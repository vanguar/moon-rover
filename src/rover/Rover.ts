import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ContactForce, Physics } from '../physics/Physics';
import type { TerrainData } from '../terrain/TerrainData';
import { buildRoverModel, type RoverModel } from './model';

export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (reverse when stopped)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean; // held
}

/** A knock heard in the cab: wheel index (or -1 for chassis), strength 0..~2, hardness 0..1. */
export interface Knock {
  wheel: number;
  strength: number;
  hard: number;
}

/** Rover geometry, local frame: +z forward, +y up, +x left. */
const WHEELS: [number, number][] = [
  [1.0, 1.25], [-1.0, 1.25],
  [1.0, 0.0], [-1.0, 0.0],
  [1.0, -1.25], [-1.0, -1.25],
];
export const WHEEL_RADIUS = 0.41; // LRV wire-mesh wheel, 81.8 cm diameter
const WHEEL_WIDTH = 0.23;
const AXLE_Y = -0.35; // wheel centre below chassis origin at nominal ride height
const TRAVEL = 0.15;

// Masses: LRV 210 kg + 2 suited crew (~180 kg each) + payload; wheel 5.4 kg + traction drive.
const MASS = 620;
const WHEEL_MASS = 6;
const LINK_MASS = 3;
// Suspension (torsion bars + dampers), per wheel: sag = m·g/6/k ≈ 6 cm on the Moon.
const SPRING_K = 2800;
const DAMPER_C = 450;
const MAX_STEER = 0.55;
const MAX_SPEED = 6.0; // m/s, ~22 km/h (LRV record 18 km/h)
const STALL_TORQUE = 39; // N·m per hub motor (≈95 N at the rim)
const BRAKE_DAMP = 60; // N·m per rad/s at full pedal
const MU_REGOLITH = 0.7;
const TYRE_K = 6500; // wire-mesh tyre radial stiffness, N/m

const BATTERY_WH = 1500;
const IDLE_W = 60;
const MOTOR_EFF = 0.75;
const SOLAR_W = 600;

// Collision groups: chassis and wheels don't collide with each other.
const G_CHASSIS = 0x0002, G_WHEEL = 0x0004;
const groups = (member: number, filter: number) => (member << 16) | filter;

interface WheelUnit {
  strut: RAPIER.RigidBody;
  knuckle: RAPIER.RigidBody;
  wheel: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  susp: RAPIER.PrismaticImpulseJoint;
  steer: RAPIER.RevoluteImpulseJoint;
  axle: RAPIER.RevoluteImpulseJoint;
  /** Local offset of each body relative to the chassis at rest (for teleports). */
  offset: THREE.Vector3;
}

export class Rover {
  readonly body: RAPIER.RigidBody;
  readonly model: RoverModel;
  readonly object = new THREE.Group();

  battery = 1;
  odometer = 0;
  power = 0;
  solar = 0;
  headlights = false;
  parkBrake = false;
  speed = 0;
  steerAngle = 0;
  motorTemp: [number, number] = [20, 20];
  battTemp = 22;
  volts = 36;
  readonly knocks: Knock[] = [];
  readonly wheelContact = new Array(6).fill(false);
  readonly wheelSlip = new Array(6).fill(0);
  readonly wheelRimSpeed = new Array(6).fill(0);
  readonly wheelImpact = new Array(6).fill(0);
  readonly wheelWorld = Array.from({ length: 6 }, () => new THREE.Vector3());
  readonly wheelNormal = Array.from({ length: 6 }, () => new THREE.Vector3(0, 1, 0));
  /** Rock size for a collider (0 if not a rock), set by the game. */
  isRock: (c: RAPIER.Collider) => number = () => 0;

  private units: WheelUnit[] = [];
  private chassisColliders: RAPIER.Collider[] = [];
  private lastSusp = new Array(6).fill(0);
  private prevPos = new THREE.Vector3();
  private sunDir: THREE.Vector3;
  private motorLoad = 0;
  private mechPower = 0;
  private tq = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private tv2 = new THREE.Vector3();

  constructor(private physics: Physics, private terrain: TerrainData, sunDir: THREE.Vector3, x: number, z: number, yaw: number) {
    const R = physics.R;
    const w = physics.world;
    this.sunDir = sunDir.clone();
    const y = terrain.height(x, z) + 1.0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = w.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0) // vacuum: no aerodynamic drag
        .setAngularDamping(0)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    const cg = groups(G_CHASSIS, 0xffff & ~G_WHEEL);
    this.chassisColliders.push(
      w.createCollider(
        R.ColliderDesc.cuboid(0.7, 0.2, 1.6)
          .setMassProperties(MASS, { x: 0, y: -0.08, z: 0 }, { x: 560, y: 740, z: 230 }, { x: 0, y: 0, z: 0, w: 1 })
          .setFriction(0.6).setRestitution(0.1).setCollisionGroups(cg)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(400),
        this.body,
      ),
      // Massless crew/seat/antenna volume so the rover rests on it when upside down.
      w.createCollider(
        R.ColliderDesc.cuboid(0.85, 0.45, 0.75).setTranslation(0, 0.62, -0.2).setDensity(0).setFriction(0.6).setCollisionGroups(cg)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300),
        this.body,
      ),
    );

    const O = { x: 0, y: 0, z: 0 }, I = { x: 0, y: 0, z: 0, w: 1 }, tiny = { x: 0.02, y: 0.02, z: 0.02 };
    const axleRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (const [wx, wz] of WHEELS) {
      const offset = new THREE.Vector3(wx, AXLE_Y, wz);
      const p = offset.clone().applyQuaternion(q).add(new THREE.Vector3(x, y, z));
      const mk = (extra?: number) => {
        const d = R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setCanSleep(false);
        if (extra) d.setAdditionalMassProperties(extra, O, tiny, I);
        return w.createRigidBody(d);
      };
      const strut = mk(LINK_MASS);
      const knuckle = mk(LINK_MASS);
      const wheel = mk();
      wheel.enableCcd(true);
      // Rounded cylinder: radius 0.41 m, width 0.23 m (the wire-mesh tyre's profile).
      const border = 0.08;
      const collider = w.createCollider(
        R.ColliderDesc.roundCylinder(WHEEL_WIDTH / 2 - border, WHEEL_RADIUS - border, border)
          .setRotation({ x: axleRot.x, y: axleRot.y, z: axleRot.z, w: axleRot.w })
          .setMass(WHEEL_MASS)
          .setFriction(MU_REGOLITH)
          .setFrictionCombineRule(R.CoefficientCombineRule.Min)
          .setRestitution(0.05)
          .setCollisionGroups(groups(G_WHEEL, 0xffff & ~(G_WHEEL | G_CHASSIS)))
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(450),
        wheel,
      );
      const susp = w.createImpulseJoint(R.JointData.prismatic({ x: wx, y: AXLE_Y, z: wz }, O, { x: 0, y: 1, z: 0 }), this.body, strut, true) as RAPIER.PrismaticImpulseJoint;
      susp.setLimits(-TRAVEL, TRAVEL);
      susp.configureMotorModel(R.MotorModel.ForceBased);
      susp.configureMotorPosition(0, SPRING_K, DAMPER_C);
      susp.setContactsEnabled(false);
      const steer = w.createImpulseJoint(R.JointData.revolute(O, O, { x: 0, y: 1, z: 0 }), strut, knuckle, true) as RAPIER.RevoluteImpulseJoint;
      steer.configureMotorModel(R.MotorModel.ForceBased);
      steer.configureMotorPosition(0, 3000, 150);
      steer.setContactsEnabled(false);
      const axle = w.createImpulseJoint(R.JointData.revolute(O, O, { x: 1, y: 0, z: 0 }), knuckle, wheel, true) as RAPIER.RevoluteImpulseJoint;
      axle.configureMotorModel(R.MotorModel.ForceBased);
      axle.setContactsEnabled(false);
      this.units.push({ strut, knuckle, wheel, collider, susp, steer, axle, offset });
    }

    this.model = buildRoverModel();
    this.object.add(this.model.root);
    this.prevPos.set(x, y, z);
  }

  private chassisQuat(out: THREE.Quaternion): THREE.Quaternion {
    const r = this.body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  /** Wheel spin rate relative to the chassis about its axle, rad/s (+ = rolling forward). */
  private wheelOmega(u: WheelUnit): number {
    const a = u.wheel.angvel(), c = this.body.angvel();
    const r = u.wheel.rotation();
    const axle = this.tv2.set(1, 0, 0).applyQuaternion(this.tq.set(r.x, r.y, r.z, r.w));
    return (a.x - c.x) * axle.x + (a.y - c.y) * axle.y + (a.z - c.z) * axle.z;
  }

  /** Called every fixed physics step. */
  step(dt: number, input: DriveInput): void {
    const lv = this.body.linvel();
    const fwd = this.forwardVector(this.tv);
    const speed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.speed = speed;

    // Steering servos: rate-limited; front and rear axles steer opposite (double Ackermann).
    const steerLimit = MAX_STEER * (1 - 0.55 * Math.min(1, Math.abs(speed) / MAX_SPEED));
    const target = -input.steer * steerLimit;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -1.6 * dt, 1.6 * dt);
    const steerFor = [this.steerAngle, this.steerAngle, 0, 0, -this.steerAngle * 0.75, -this.steerAngle * 0.75];

    let drive = 0, brake = 0;
    if (input.throttle > 0.01) {
      if (speed < -0.3) brake = input.throttle;
      else drive = input.throttle;
    }
    if (input.brake > 0.01) {
      if (speed > 0.3) brake = Math.max(brake, input.brake);
      else drive = -input.brake * 0.6;
    }
    const parked = input.handbrake || this.parkBrake;
    if (this.parkBrake) drive = 0;
    const powerAvail = this.battery > 0 ? 1 : 0.1;
    const derate = THREE.MathUtils.clamp(1 - (Math.max(...this.motorTemp) - 120) / 40, 0.3, 1);

    let mech = 0, load = 0;
    for (let i = 0; i < 6; i++) {
      const u = this.units[i];
      u.steer.configureMotorPosition(steerFor[i], 3000, 150);
      // Hub motor: linear torque-speed characteristic, reaction on the chassis.
      const omega = this.wheelOmega(u);
      const rim = omega * WHEEL_RADIUS;
      const dirRim = drive >= 0 ? rim : -rim;
      const curve = Math.max(0, 1 - Math.max(0, dirRim) / MAX_SPEED);
      const tq = drive * STALL_TORQUE * curve * powerAvail * derate;
      const r = u.wheel.rotation();
      const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
      u.wheel.resetTorques(true);
      u.wheel.addTorque({ x: axle.x * tq, y: axle.y * tq, z: axle.z * tq }, true);
      u.knuckle.resetTorques(true);
      u.knuckle.addTorque({ x: -axle.x * tq, y: -axle.y * tq, z: -axle.z * tq }, true);
      // Brakes act through the axle joint: viscous at speed, locking when parked.
      // Note: a factor of exactly 0 makes Rapier lock the joint; use a negligible value to free it.
      const damp = parked ? 4000 : brake * BRAKE_DAMP;
      u.axle.configureMotorVelocity(0, Math.max(damp, 1e-6));
      mech += Math.abs(tq * omega);
      load += Math.abs(drive) * curve * powerAvail / 6;
    }
    this.motorLoad = load;
    this.mechPower = mech;

    // Energy budget.
    const up = this.upVector(this.tv);
    this.solar = SOLAR_W * Math.max(0, up.dot(this.sunDir));
    const copper = this.motorLoad * 150;
    const motorW = mech / MOTOR_EFF + copper;
    this.power = IDLE_W + motorW + (this.headlights ? 60 : 0) - this.solar;
    this.battery = THREE.MathUtils.clamp(this.battery - (this.power * dt) / 3600 / BATTERY_WH, 0, 1);
    const current = Math.max(0, this.power + this.solar) / 36;
    this.volts = 30 + 7 * this.battery - current * 0.04;
    // Motor heat leaves only by radiation in vacuum (slow); ~0.9 kJ/K hub mass.
    const heat = (mech * (1 - MOTOR_EFF)) / MOTOR_EFF / 6 + copper / 6;
    for (let k = 0; k < 2; k++) {
      const T = this.motorTemp[k];
      const rad = 0.9 * 5.67e-8 * 0.06 * (Math.pow(T + 273, 4) - Math.pow(250, 4));
      this.motorTemp[k] = T + ((heat * (k === 0 ? 1.05 : 0.95) - rad) * dt) / 900;
    }
    this.battTemp += ((current * 0.15 - (this.battTemp - 22) * 0.6) * dt) / 3000;
  }

  /** Contact force events from the physics step: knocks on rocks and the chassis. */
  onContacts(events: ContactForce[]): void {
    for (const e of events) {
      let wheel = -2;
      let other = e.c2;
      for (let i = 0; i < 6; i++) {
        if (this.units[i].collider.handle === e.c1) { wheel = i; other = e.c2; }
        else if (this.units[i].collider.handle === e.c2) { wheel = i; other = e.c1; }
      }
      if (wheel === -2 && this.chassisColliders.some((c) => c.handle === e.c1 || c.handle === e.c2)) wheel = -1;
      if (wheel === -2) continue;
      const col = this.physics.world.getCollider(other);
      const rock = col ? this.isRock(col) : 0;
      // Static wheel load is ~170 N; knocks are the excess, in kN.
      const excess = (e.force - (wheel >= 0 ? 450 : 0)) / 1000;
      if (excess <= 0.05) continue;
      this.knocks.push({ wheel, strength: Math.min(2.5, excess * (rock ? 1.2 : 0.6)), hard: rock ? 1 : wheel === -1 ? 0.8 : 0.3 });
    }
  }

  /** Called once per rendered frame after physics. */
  sync(dt: number): void {
    const t = this.body.translation();
    const cq = this.chassisQuat(new THREE.Quaternion());
    this.object.position.set(t.x, t.y, t.z);
    this.object.quaternion.copy(cq);
    this.object.updateMatrixWorld();

    const pos = this.object.position;
    const d = Math.hypot(pos.x - this.prevPos.x, pos.z - this.prevPos.z);
    if (d < 5) this.odometer += d;
    this.prevPos.copy(pos);

    const inv = cq.clone().invert();
    const down = this.upVector(new THREE.Vector3()).negate();
    const world = this.physics.world;
    for (let i = 0; i < 6; i++) {
      const u = this.units[i];
      const wv = this.model.wheels[i];
      const wp = u.wheel.translation(), wr = u.wheel.rotation();
      // Visual wheel = physical wheel body, expressed in the chassis frame.
      wv.steer.position.set(wp.x - t.x, wp.y - t.y, wp.z - t.z).applyQuaternion(inv);
      wv.steer.quaternion.copy(inv).multiply(new THREE.Quaternion(wr.x, wr.y, wr.z, wr.w));
      wv.spin.rotation.set(0, 0, 0);
      this.wheelWorld[i].set(wp.x, wp.y, wp.z);

      let contact = false;
      world.contactPairsWith(u.collider, (other) => {
        world.contactPair(u.collider, other, (m, flipped) => {
          if (m.numContacts() > 0) {
            contact = true;
            const n = m.normal();
            const s = flipped ? 1 : -1; // normal pointing out of the ground
            this.wheelNormal[i].set(n.x * s, n.y * s, n.z * s);
          }
        });
      });
      this.wheelContact[i] = contact;
      const rim = this.wheelOmega(u) * WHEEL_RADIUS;
      this.wheelRimSpeed[i] = THREE.MathUtils.clamp(rim, -MAX_SPEED * 1.5, MAX_SPEED * 1.5);
      this.wheelSlip[i] = contact ? this.wheelRimSpeed[i] - this.speed : 0;
      // Suspension: strut displacement along the chassis Y.
      const sp = u.strut.translation();
      const local = this.tv.set(sp.x - t.x, sp.y - t.y, sp.z - t.z).applyQuaternion(inv);
      const comp = local.y - AXLE_Y; // + = compressed
      this.wheelImpact[i] = dt > 0 ? (comp - this.lastSusp[i]) / dt : 0;
      this.lastSusp[i] = comp;

      // Tyre flattening from the wheel load; motion blur of chevrons beyond ~1/3 pitch per frame.
      const loadN = contact ? Math.max(0, SPRING_K * (comp + 0.06)) : 0;
      wv.uniforms.uCenter.value.set(wp.x, wp.y, wp.z);
      wv.uniforms.uDown.value.copy(down);
      wv.uniforms.uDefl.value = contact ? THREE.MathUtils.clamp(loadN / TYRE_K, 0.008, 0.08) : 0;
      const travel = Math.abs(this.wheelRimSpeed[i]) / 60 / ((2 * Math.PI * WHEEL_RADIUS) / 18);
      const blur = THREE.MathUtils.smoothstep(travel, 0.15, 0.45);
      wv.blurMat.opacity = blur * 0.75;
      wv.chevronMat.opacity = 1 - blur * 0.8;
    }
    this.model.setSteering(this.steerAngle);
  }

  upVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.chassisQuat(this.tq));
  }

  forwardVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.chassisQuat(this.tq));
  }

  /** Roll and pitch in degrees (positive roll = right side down, positive pitch = nose up). */
  attitude(): { roll: number; pitch: number; heading: number } {
    const q = this.chassisQuat(new THREE.Quaternion());
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)));
    const roll = THREE.MathUtils.radToDeg(Math.atan2(left.y, up.y));
    let heading = THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z));
    if (heading < 0) heading += 360;
    return { roll, pitch, heading };
  }

  get motorLoadFactor(): number {
    return this.motorLoad;
  }

  get mechanicalPower(): number {
    return this.mechPower;
  }

  /** Move the whole articulated rover (chassis + suspension links + wheels). */
  private teleport(x: number, y: number, z: number, q: THREE.Quaternion): void {
    const rot = { x: q.x, y: q.y, z: q.z, w: q.w };
    const zero = { x: 0, y: 0, z: 0 };
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation(rot, true);
    this.body.setLinvel(zero, true);
    this.body.setAngvel(zero, true);
    for (const u of this.units) {
      const p = u.offset.clone().applyQuaternion(q).add(new THREE.Vector3(x, y, z));
      for (const b of [u.strut, u.knuckle, u.wheel]) {
        b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
        b.setRotation(rot, true);
        b.setLinvel(zero, true);
        b.setAngvel(zero, true);
      }
    }
  }

  /** Put the rover back on its wheels, keeping its heading. */
  reset(): void {
    const t = this.body.translation();
    const { heading } = this.attitude();
    const yaw = -THREE.MathUtils.degToRad(heading) + Math.PI;
    this.teleport(t.x, this.terrain.height(t.x, t.z) + 1.1, t.z, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  }

  placeAt(x: number, z: number, yaw: number): void {
    this.teleport(x, this.terrain.height(x, z) + 1.1, z, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    this.prevPos.set(x, 0, z);
    this.odometer = 0;
  }

  setHeadlights(on: boolean): void {
    this.headlights = on;
    this.model.setHeadlights(on);
  }
}
