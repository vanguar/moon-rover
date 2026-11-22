import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import type { TerrainData } from '../terrain/TerrainData';
import { buildRoverModel, type RoverModel } from './model';

export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (reverse when stopped)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
}

/** Rover geometry, local frame: +z forward, +y up, +x left. */
const WHEELS: [number, number][] = [
  [1.0, 1.25], [-1.0, 1.25],
  [1.0, 0.0], [-1.0, 0.0],
  [1.0, -1.25], [-1.0, -1.25],
];
export const WHEEL_RADIUS = 0.41; // LRV wire-mesh wheel, 81.8 cm diameter
const WHEEL_Y = -0.05;
const REST = 0.3;
const TRAVEL = 0.22;

// Mass: LRV 210 kg + 2 suited crew (~180 kg each) + payload.
const MASS = 620;
const MAX_STEER = 0.55;
const MAX_SPEED = 6.0; // m/s, ~22 km/h (LRV record 18 km/h)
const WHEEL_FORCE = 95; // N per hub motor at stall (x6 ≈ traction limit μ·m·g)
const BRAKE = 40;
const MU_REGOLITH = 0.75;

// Energy: silver-zinc batteries (scaled down for gameplay).
const BATTERY_WH = 1500;
const IDLE_W = 60;
const MOTOR_EFF = 0.75;
const SOLAR_W = 600; // panel peak with sun on its normal

export class Rover {
  readonly body: RAPIER.RigidBody;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  readonly model: RoverModel;
  readonly object = new THREE.Group();

  battery = 1; // 0..1
  odometer = 0; // metres
  power = 0; // W, net (positive = draw)
  solar = 0; // W
  headlights = false;
  speed = 0; // m/s signed along forward
  steerAngle = 0;
  /** Per-wheel: contact, slip (m/s), rim speed (m/s), suspension compression rate. */
  readonly wheelContact = new Array(6).fill(false);
  readonly wheelSlip = new Array(6).fill(0);
  readonly wheelRimSpeed = new Array(6).fill(0);
  readonly wheelImpact = new Array(6).fill(0);
  readonly wheelWorld = Array.from({ length: 6 }, () => new THREE.Vector3());
  readonly wheelNormal = Array.from({ length: 6 }, () => new THREE.Vector3(0, 1, 0));

  private lastSusp = new Array(6).fill(REST);
  private lastRot = new Array(6).fill(0);
  private prevPos = new THREE.Vector3();
  private sunDir: THREE.Vector3;
  private motorLoad = 0;

  constructor(private physics: Physics, private terrain: TerrainData, sunDir: THREE.Vector3, x: number, z: number, yaw: number) {
    const R = physics.R;
    this.sunDir = sunDir.clone();
    const y = terrain.height(x, z) + 1.2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0) // vacuum: no aerodynamic drag
        .setAngularDamping(0.05)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    // Chassis frame; mass properties: centre of mass low, box-like inertia.
    physics.world.createCollider(
      R.ColliderDesc.cuboid(1.0, 0.2, 1.6)
        .setMassProperties(MASS, { x: 0, y: -0.08, z: 0 }, { x: 560, y: 740, z: 230 }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.6)
        .setRestitution(0.1),
      this.body,
    );
    // Massless crew/seat/antenna volume so the rover rests on it when upside down.
    physics.world.createCollider(
      R.ColliderDesc.cuboid(0.85, 0.45, 0.75).setTranslation(0, 0.62, -0.2).setDensity(0).setFriction(0.6),
      this.body,
    );

    this.vehicle = physics.world.createVehicleController(this.body);
    this.vehicle.setIndexForwardAxis = 2;
    WHEELS.forEach(([wx, wz], i) => {
      this.vehicle.addWheel({ x: wx, y: WHEEL_Y, z: wz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_RADIUS);
      this.vehicle.setWheelSuspensionStiffness(i, 6.5);
      this.vehicle.setWheelSuspensionCompression(i, 1.6);
      this.vehicle.setWheelSuspensionRelaxation(i, 2.2);
      this.vehicle.setWheelMaxSuspensionTravel(i, TRAVEL);
      this.vehicle.setWheelMaxSuspensionForce(i, 60000);
      this.vehicle.setWheelFrictionSlip(i, MU_REGOLITH);
      this.vehicle.setWheelSideFrictionStiffness(i, 0.85);
    });

    this.model = buildRoverModel();
    this.object.add(this.model.root);
    this.prevPos.set(x, y, z);
  }

  /** Called every fixed physics step. */
  step(dt: number, input: DriveInput): void {
    const v = this.vehicle;
    const speed = v.currentVehicleSpeed();
    this.speed = speed;

    // Steering: rate-limited, reduced at speed; front and rear axles steer opposite.
    const steerLimit = MAX_STEER * (1 - 0.55 * Math.min(1, Math.abs(speed) / MAX_SPEED));
    const target = -input.steer * steerLimit;
    const rate = 1.6 * dt;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -rate, rate);
    v.setWheelSteering(0, this.steerAngle);
    v.setWheelSteering(1, this.steerAngle);
    v.setWheelSteering(4, -this.steerAngle * 0.75);
    v.setWheelSteering(5, -this.steerAngle * 0.75);

    // Hub motors: linear torque-speed curve; brake pedal reverses when nearly stopped.
    let drive = 0;
    let brake = 0;
    if (input.throttle > 0.01) {
      if (speed < -0.3) brake = BRAKE * input.throttle;
      else drive = input.throttle;
    }
    if (input.brake > 0.01) {
      if (speed > 0.3) brake = Math.max(brake, BRAKE * input.brake);
      else drive = -input.brake * 0.6;
    }
    if (input.handbrake) brake = BRAKE * 2.5;
    const dirSpeed = drive >= 0 ? speed : -speed;
    const curve = Math.max(0, 1 - Math.max(0, dirSpeed) / MAX_SPEED);
    const powerAvail = this.battery > 0 ? 1 : 0.1;
    const force = drive * WHEEL_FORCE * curve * powerAvail;
    this.motorLoad = Math.abs(drive) * curve * powerAvail;

    const tmp = { x: 0, y: 0, z: 0 };
    let mechPower = 0;
    for (let i = 0; i < 6; i++) {
      v.setWheelEngineForce(i, force);
      v.setWheelBrake(i, brake);
      // Traction falls off on slopes: loose regolith shears and slides downhill.
      const contact = v.wheelIsInContact(i);
      let mu = MU_REGOLITH;
      if (contact) {
        const n = v.wheelContactNormal(i, tmp as RAPIER.Vector)!;
        const slopeDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)));
        mu *= THREE.MathUtils.clamp(1 - (slopeDeg - 8) / 40, 0.3, 1);
      }
      v.setWheelFrictionSlip(i, mu);
      mechPower += Math.abs(force * speed);
    }

    v.updateVehicle(dt, this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS);

    // Energy budget.
    const up = this.upVector(new THREE.Vector3());
    this.solar = SOLAR_W * Math.max(0, up.dot(this.sunDir));
    const motorW = mechPower / MOTOR_EFF + this.motorLoad * 150; // copper losses at stall
    const lightsW = this.headlights ? 60 : 0;
    this.power = IDLE_W + motorW + lightsW - this.solar;
    this.battery = THREE.MathUtils.clamp(this.battery - (this.power * dt) / 3600 / BATTERY_WH, 0, 1);
  }

  /** Called once per rendered frame after physics. */
  sync(dt: number): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.object.position.set(t.x, t.y, t.z);
    this.object.quaternion.set(r.x, r.y, r.z, r.w);
    this.object.updateMatrixWorld();

    const pos = this.object.position;
    const dx = pos.x - this.prevPos.x, dz = pos.z - this.prevPos.z;
    const d = Math.hypot(dx, dz);
    if (d < 5) this.odometer += d;
    this.prevPos.copy(pos);

    const v = this.vehicle;
    const tmp = { x: 0, y: 0, z: 0 } as RAPIER.Vector;
    for (let i = 0; i < 6; i++) {
      const susp = v.wheelSuspensionLength(i) ?? REST;
      const w = this.model.wheels[i];
      const [wx, wz] = WHEELS[i];
      w.position.set(wx, WHEEL_Y - susp, wz);
      w.rotation.set(0, v.wheelSteering(i) ?? 0, 0);
      const rot = v.wheelRotation(i) ?? 0;
      w.children[0].rotation.x = rot;
      const contact = v.wheelIsInContact(i);
      this.wheelContact[i] = contact;
      // Rim speed vs ground speed -> slip, which throws regolith.
      const dRot = dt > 0 ? (rot - this.lastRot[i]) / dt : 0;
      this.lastRot[i] = rot;
      // Bound to what the motors can do (also guards the first frame / resets).
      this.wheelRimSpeed[i] = THREE.MathUtils.clamp(dRot * WHEEL_RADIUS, -MAX_SPEED * 1.5, MAX_SPEED * 1.5);
      this.wheelSlip[i] = contact ? this.wheelRimSpeed[i] - this.speed : 0;
      this.wheelImpact[i] = dt > 0 ? (this.lastSusp[i] - susp) / dt : 0;
      this.lastSusp[i] = susp;
      w.getWorldPosition(this.wheelWorld[i]);
      if (contact) {
        const n = v.wheelContactNormal(i, tmp);
        if (n) this.wheelNormal[i].set(n.x, n.y, n.z);
      }
    }
    this.model.setSteering(this.steerAngle);
  }

  upVector(out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  }

  forwardVector(out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  }

  /** Roll and pitch in degrees (positive roll = right side down, positive pitch = nose up). */
  attitude(): { roll: number; pitch: number; heading: number } {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)));
    let roll = THREE.MathUtils.radToDeg(Math.atan2(left.y, up.y));
    if (Math.abs(roll) > 180) roll -= Math.sign(roll) * 360;
    // Heading: 0 = north (-z), 90 = east (+x).
    let heading = THREE.MathUtils.radToDeg(Math.atan2(f.x, -f.z));
    if (heading < 0) heading += 360;
    return { roll, pitch, heading };
  }

  get motorLoadFactor(): number {
    return this.motorLoad;
  }

  /** Put the rover back on its wheels, keeping its heading. */
  reset(): void {
    const t = this.body.translation();
    const { heading } = this.attitude();
    const yaw = -THREE.MathUtils.degToRad(heading) + Math.PI;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const y = this.terrain.height(t.x, t.z) + 1.3;
    this.body.setTranslation({ x: t.x, y, z: t.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  setHeadlights(on: boolean): void {
    this.headlights = on;
    this.model.setHeadlights(on);
  }
}
