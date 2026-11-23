import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ContactForce, Physics } from '../physics/Physics';
import type { TerrainData } from '../terrain/TerrainData';
import { world } from '../world';
import type { RoverModel } from './models/kit';
import type { RoverSpec } from './specs';

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

const MOTOR_EFF = 0.75;
const MU_REGOLITH = 0.7;

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
  readonly n: number;
  readonly wheelRadius: number;
  readonly wheelContact: boolean[];
  readonly wheelSlip: number[];
  readonly wheelRimSpeed: number[];
  readonly wheelImpact: number[];
  /** Normal load on each wheel, N (from the suspension). */
  readonly wheelLoad: number[];
  readonly wheelWorld: THREE.Vector3[];
  readonly wheelNormal: THREE.Vector3[];
  /** Wheel centres in the chassis frame (drives the suspension-link visuals). */
  readonly wheelLocal: THREE.Vector3[];
  /** Fraction of the solar array covered by settled dust (Mars), 0..1. */
  panelDust = 0;
  /** External horizontal force on the chassis (wind), N. */
  readonly windForce = new THREE.Vector3();
  /** Rock size for a collider (0 if not a rock), set by the game. */
  isRock: (c: RAPIER.Collider) => number = () => 0;

  private units: WheelUnit[] = [];
  private chassisColliders: RAPIER.Collider[] = [];
  private lastSusp: number[];
  // Tuning derived from the spec and the world's gravity.
  private maxSpeed: number;
  private stallTorque: number;
  private springK: number;
  private damperC: number;
  private brakeDamp: number;
  private steerK: number;
  private tyreK: number;
  private prevPos = new THREE.Vector3();
  private sunDir: THREE.Vector3;
  private motorLoad = 0;
  /** Sunlight reaching the panels relative to the vacuum value (atmosphere, dust storm). */
  solarScale = 1;
  private mechPower = 0;
  private tq = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private tv2 = new THREE.Vector3();

  constructor(
    private physics: Physics,
    private terrain: TerrainData,
    sunDir: THREE.Vector3,
    x: number,
    z: number,
    yaw: number,
    readonly spec: RoverSpec,
  ) {
    const R = physics.R;
    const w = physics.world;
    const g = world().gravity;
    const n = spec.wheels.length;
    this.n = n;
    this.wheelRadius = spec.wheelRadius;
    this.wheelContact = new Array(n).fill(false);
    this.wheelSlip = new Array(n).fill(0);
    this.wheelRimSpeed = new Array(n).fill(0);
    this.wheelImpact = new Array(n).fill(0);
    this.wheelLoad = new Array(n).fill(0);
    this.lastSusp = new Array(n).fill(0);
    this.wheelWorld = Array.from({ length: n }, () => new THREE.Vector3());
    this.wheelNormal = Array.from({ length: n }, () => new THREE.Vector3(0, 1, 0));
    this.wheelLocal = spec.wheels.map(([wx, wz]) => new THREE.Vector3(wx, spec.axleY, wz));
    this.sunDir = sunDir.clone();
    const mass = spec.mass;
    const perWheel = (mass * g) / n;
    // Static sag ≈ 40 % of the travel; damping ≈ 0.42 of critical (LRV: k 2800 N/m, c 450 N·s/m).
    this.springK = perWheel / (0.4 * spec.travel);
    this.damperC = 2 * 0.42 * Math.sqrt((this.springK * mass) / n);
    this.maxSpeed = spec.maxSpeed;
    // Stall torque to climb ~30° (skid steering needs extra to scrub sideways).
    this.stallTorque = ((0.62 * (mass * g * spec.wheelRadius)) / n) * (spec.skid ? 1.9 : 1);
    const scale = (mass * g) / (620 * 1.62);
    this.brakeDamp = 60 * scale * (spec.wheelRadius / 0.41);
    this.steerK = 3000 * scale;
    this.tyreK = 6500 * scale;
    const wheelMass = Math.max(0.3, mass * 0.01);
    const linkMass = Math.max(0.15, mass * 0.005);

    const y = terrain.height(x, z) + Math.max(0.6, -spec.axleY + spec.wheelRadius + 0.3);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = w.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0) // vacuum / thin air: aerodynamic drag is negligible
        .setAngularDamping(0)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    const cg = groups(G_CHASSIS, 0xffff & ~G_WHEEL);
    const [bx, by, bz] = spec.body.half;
    const [ox, oy, oz] = spec.body.offset;
    const inertia = spec.body.inertia ?? [
      (mass / 3) * (by * by + bz * bz) * 1.1,
      (mass / 3) * (bx * bx + bz * bz) * 1.1,
      (mass / 3) * (bx * bx + by * by) * 1.1,
    ];
    const thresh = 400 * scale;
    // Centre of mass low in the chassis (batteries, electronics).
    const com = { x: -ox, y: -oy - 0.4 * by, z: -oz };
    this.chassisColliders.push(
      w.createCollider(
        R.ColliderDesc.cuboid(bx, by, bz)
          .setTranslation(ox, oy, oz)
          .setMassProperties(mass, com, { x: inertia[0], y: inertia[1], z: inertia[2] }, { x: 0, y: 0, z: 0, w: 1 })
          .setFriction(0.6).setRestitution(0.1).setCollisionGroups(cg)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(thresh),
        this.body,
      ),
      // Massless upper volume (crew, mast, lid) so the rover rests on it when upside down.
      w.createCollider(
        R.ColliderDesc.cuboid(...spec.top.half).setTranslation(...spec.top.offset).setDensity(0).setFriction(0.6).setCollisionGroups(cg)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(thresh * 0.75),
        this.body,
      ),
    );

    const O = { x: 0, y: 0, z: 0 }, I = { x: 0, y: 0, z: 0, w: 1 }, tiny = { x: 0.02, y: 0.02, z: 0.02 };
    const axleRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const r = spec.wheelRadius, ww = spec.wheelWidth;
    const border = Math.min(0.08, r * 0.2, ww * 0.35);
    for (const [wx, wz] of spec.wheels) {
      const offset = new THREE.Vector3(wx, spec.axleY, wz);
      const p = offset.clone().applyQuaternion(q).add(new THREE.Vector3(x, y, z));
      const mk = (extra?: number) => {
        const d = R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setCanSleep(false);
        if (extra) d.setAdditionalMassProperties(extra, O, tiny, I);
        return w.createRigidBody(d);
      };
      const strut = mk(linkMass);
      const knuckle = mk(linkMass);
      const wheel = mk();
      wheel.enableCcd(true);
      const collider = w.createCollider(
        R.ColliderDesc.roundCylinder(ww / 2 - border, r - border, border)
          .setRotation({ x: axleRot.x, y: axleRot.y, z: axleRot.z, w: axleRot.w })
          .setMass(wheelMass)
          .setFriction(MU_REGOLITH)
          .setFrictionCombineRule(R.CoefficientCombineRule.Min)
          .setRestitution(0.05)
          .setCollisionGroups(groups(G_WHEEL, 0xffff & ~(G_WHEEL | G_CHASSIS)))
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(450 * scale),
        wheel,
      );
      const susp = w.createImpulseJoint(R.JointData.prismatic({ x: wx, y: spec.axleY, z: wz }, O, { x: 0, y: 1, z: 0 }), this.body, strut, true) as RAPIER.PrismaticImpulseJoint;
      susp.setLimits(-spec.travel, spec.travel);
      susp.configureMotorModel(R.MotorModel.ForceBased);
      susp.configureMotorPosition(0, this.springK, this.damperC);
      susp.setContactsEnabled(false);
      const steer = w.createImpulseJoint(R.JointData.revolute(O, O, { x: 0, y: 1, z: 0 }), strut, knuckle, true) as RAPIER.RevoluteImpulseJoint;
      steer.configureMotorModel(R.MotorModel.ForceBased);
      steer.configureMotorPosition(0, this.steerK, this.steerK * 0.05);
      steer.setContactsEnabled(false);
      const axle = w.createImpulseJoint(R.JointData.revolute(O, O, { x: 1, y: 0, z: 0 }), knuckle, wheel, true) as RAPIER.RevoluteImpulseJoint;
      axle.configureMotorModel(R.MotorModel.ForceBased);
      axle.setContactsEnabled(false);
      this.units.push({ strut, knuckle, wheel, collider, susp, steer, axle, offset });
    }

    this.model = spec.build();
    this.object.add(this.model.root);
    this.prevPos.set(x, y, z);
  }

  /** Remove all bodies (switching rovers). */
  dispose(): void {
    const w = this.physics.world;
    for (const u of this.units) for (const b of [u.wheel, u.knuckle, u.strut]) w.removeRigidBody(b);
    w.removeRigidBody(this.body);
    this.units = [];
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
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
    const spec = this.spec;
    const n = this.n;
    const lv = this.body.linvel();
    const fwd = this.forwardVector(this.tv);
    const speed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.speed = speed;
    const vmax = this.maxSpeed;

    // Steering servos: rate-limited; front and rear axles steer opposite (double Ackermann).
    const steerLimit = spec.maxSteer * (1 - 0.55 * Math.min(1, Math.abs(speed) / vmax));
    const target = -input.steer * steerLimit;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -1.6 * dt, 1.6 * dt);

    let drive = 0, brake = 0;
    if (input.throttle > 0.01) {
      if (speed < -0.3 * vmax / 6) brake = input.throttle;
      else drive = input.throttle;
    }
    if (input.brake > 0.01) {
      if (speed > 0.3 * vmax / 6) brake = Math.max(brake, input.brake);
      else drive = -input.brake * 0.6;
    }
    const parked = input.handbrake || this.parkBrake;
    if (this.parkBrake) drive = 0;
    const powerAvail = this.battery > 0 ? 1 : 0.1;
    const derate = THREE.MathUtils.clamp(1 - (Math.max(...this.motorTemp) - 120) / 40, 0.3, 1);
    // Skid steering: the sides are driven differentially (and counter-rotate to pivot in place).
    const turn = spec.skid ? -input.steer : 0;

    let mech = 0, load = 0;
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      u.steer.configureMotorPosition(this.steerAngle * spec.steer[i], this.steerK, this.steerK * 0.05);
      const left = spec.wheels[i][0] > 0;
      let d = drive;
      if (spec.skid && turn !== 0) {
        // Turning left (turn > 0): the left side is the inner one. It slows, and reverses for a pivot turn.
        const inner = (left && turn > 0) || (!left && turn < 0);
        const k = Math.abs(turn);
        const pivot = Math.abs(drive) < 0.05 ? 0.45 * k : 0;
        d = inner ? drive * (1 - 1.6 * k) - pivot : drive + pivot;
        d = THREE.MathUtils.clamp(d, -1, 1);
      }
      // Hub motor: linear torque-speed characteristic, reaction on the chassis.
      const omega = this.wheelOmega(u);
      const rim = omega * this.wheelRadius;
      const dirRim = d >= 0 ? rim : -rim;
      const curve = Math.max(0, 1 - Math.max(0, dirRim) / vmax);
      const tq = d * this.stallTorque * curve * powerAvail * derate;
      const r = u.wheel.rotation();
      const axle = this.tv2.set(1, 0, 0).applyQuaternion(this.tq.set(r.x, r.y, r.z, r.w));
      u.wheel.resetTorques(true);
      u.wheel.addTorque({ x: axle.x * tq, y: axle.y * tq, z: axle.z * tq }, true);
      u.knuckle.resetTorques(true);
      u.knuckle.addTorque({ x: -axle.x * tq, y: -axle.y * tq, z: -axle.z * tq }, true);
      // Brakes act through the axle joint: viscous at speed, locking when parked.
      // Note: a factor of exactly 0 makes Rapier lock the joint; use a negligible value to free it.
      const damp = parked ? 4000 * (this.steerK / 3000) : brake * this.brakeDamp;
      u.axle.configureMotorVelocity(0, Math.max(damp, 1e-6));
      mech += Math.abs(tq * omega);
      load += (Math.abs(d) * curve * powerAvail) / n;
    }
    this.motorLoad = load;
    this.mechPower = mech;

    // Wind (Mars): drag on the body, F = ½ρv²·Cd·A — real Martian winds barely push a rover.
    this.body.resetForces(true);
    if (this.windForce.lengthSq() > 0) this.body.addForce({ x: this.windForce.x, y: 0, z: this.windForce.z }, true);

    // Energy budget.
    const up = this.upVector(this.tv);
    this.solar = spec.solarW * this.solarScale * (1 - this.panelDust) * Math.max(0, up.dot(this.sunDir));
    const copper = this.motorLoad * 150 * (spec.mass / 620);
    const motorW = mech / MOTOR_EFF + copper;
    this.power = spec.idleW + motorW + (this.headlights ? spec.lightsW : 0) - this.solar;
    this.battery = THREE.MathUtils.clamp(this.battery - (this.power * dt) / 3600 / spec.batteryWh, 0, 1);
    const current = Math.max(0, this.power + this.solar) / 36;
    this.volts = 30 + 7 * this.battery - current * 0.04;
    // Motor heat leaves only by radiation in vacuum (slow); ~0.9 kJ/K hub mass.
    const heat = (mech * (1 - MOTOR_EFF)) / MOTOR_EFF / n + copper / n;
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
      for (let i = 0; i < this.n; i++) {
        if (this.units[i].collider.handle === e.c1) { wheel = i; other = e.c2; }
        else if (this.units[i].collider.handle === e.c2) { wheel = i; other = e.c1; }
      }
      if (wheel === -2 && this.chassisColliders.some((c) => c.handle === e.c1 || c.handle === e.c2)) wheel = -1;
      if (wheel === -2) continue;
      const col = this.physics.world.getCollider(other);
      const rock = col ? this.isRock(col) : 0;
      // Static wheel load (LRV ~170 N); knocks are the excess, in units of the LRV's kN scale.
      const scale = this.steerK / 3000;
      const excess = (e.force / scale - (wheel >= 0 ? 450 : 0)) / 1000;
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
    for (let i = 0; i < this.n; i++) {
      const u = this.units[i];
      const wv = this.model.wheels[i];
      const wp = u.wheel.translation(), wr = u.wheel.rotation();
      // Visual wheel = physical wheel body, expressed in the chassis frame.
      wv.steer.position.set(wp.x - t.x, wp.y - t.y, wp.z - t.z).applyQuaternion(inv);
      wv.steer.quaternion.copy(inv).multiply(new THREE.Quaternion(wr.x, wr.y, wr.z, wr.w));
      wv.spin.rotation.set(0, 0, 0);
      this.wheelWorld[i].set(wp.x, wp.y, wp.z);
      this.wheelLocal[i].copy(wv.steer.position);

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
      const rim = this.wheelOmega(u) * this.wheelRadius;
      this.wheelRimSpeed[i] = THREE.MathUtils.clamp(rim, -this.maxSpeed * 1.5, this.maxSpeed * 1.5);
      this.wheelSlip[i] = contact ? this.wheelRimSpeed[i] - this.speed : 0;
      // Suspension: strut displacement along the chassis Y.
      const sp = u.strut.translation();
      const local = this.tv.set(sp.x - t.x, sp.y - t.y, sp.z - t.z).applyQuaternion(inv);
      const comp = local.y - this.spec.axleY; // + = compressed
      this.wheelImpact[i] = dt > 0 ? (comp - this.lastSusp[i]) / dt : 0;
      this.lastSusp[i] = comp;
      this.wheelLoad[i] = contact ? Math.max(0, this.springK * (comp + 0.4 * this.spec.travel)) : 0;

      // Tyre flattening from the wheel load; motion blur of chevrons beyond ~1/3 pitch per frame (LRV wire-mesh tyre).
      if (wv.uniforms && wv.blurMat && wv.chevronMat) {
        const loadN = contact ? Math.max(0, this.springK * (comp + 0.4 * this.spec.travel)) : 0;
        wv.uniforms.uCenter.value.set(wp.x, wp.y, wp.z);
        wv.uniforms.uDown.value.copy(down);
        wv.uniforms.uDefl.value = contact ? THREE.MathUtils.clamp(loadN / this.tyreK, 0.008, 0.08) : 0;
        const travel = Math.abs(this.wheelRimSpeed[i]) / 60 / ((2 * Math.PI * this.wheelRadius) / 18);
        const blur = THREE.MathUtils.smoothstep(travel, 0.15, 0.45);
        wv.blurMat.opacity = blur * 0.75;
        wv.chevronMat.opacity = 1 - blur * 0.8;
      }
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

  /** Chassis origin height above the ground for a teleport (wheels just touching). */
  private rideHeight(): number {
    return -this.spec.axleY + this.wheelRadius + 0.12;
  }

  /** Put the rover back on its wheels, keeping its heading. */
  reset(): void {
    const t = this.body.translation();
    const { heading } = this.attitude();
    const yaw = -THREE.MathUtils.degToRad(heading) + Math.PI;
    this.teleport(t.x, this.terrain.height(t.x, t.z) + this.rideHeight(), t.z, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  }

  placeAt(x: number, z: number, yaw: number): void {
    this.teleport(x, this.terrain.height(x, z) + this.rideHeight(), z, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    this.prevPos.set(x, 0, z);
    this.odometer = 0;
  }

  setHeadlights(on: boolean): void {
    this.headlights = on;
    this.model.setHeadlights(on);
  }
}
