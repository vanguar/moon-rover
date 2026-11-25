import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';
import type { Astronaut } from './Astronaut';

/**
 * Camera shots of a moonwalk that show the astronaut from the front, as the real EVAs
 * were seen:
 *  - the exit: a short shot from in front while the astronaut climbs off the rover,
 *    then the camera swings round behind;
 *  - standing still: the chase camera comes slowly round to a front three-quarter view
 *    (any movement brings it back behind);
 *  - the partner's Hasselblad: the other crewman stands ahead along the way and the
 *    astronaut walks toward him; once passed (or too far) he moves on ahead - the way
 *    most of the Apollo surface photographs of a crewman were taken;
 *  - the rover's TV camera (GCTA), aimed from Houston: it pans after the astronaut with
 *    the 2.6 s Earth-Moon round trip and a limited slew rate, and zooms to keep him
 *    framed - as Ed Fendell filmed the Apollo 15-17 EVAs.
 */
export type EvaShot = 'partner' | 'tv';

const EYE = 1.45; // a crewman's chest-mounted Hasselblad, m above the ground
const DELAY = 2.6; // Earth-Moon radio round trip, s
const SLEW = THREE.MathUtils.degToRad(22); // pan/tilt rate of the GCTA, rad/s

export class EvaCamera {
  /** Exit shot: seconds since the astronaut stepped off. */
  private introT = 99;
  private introFrom = new THREE.Vector3();
  /** Extra orbit yaw of the chase camera while standing still. */
  idleYaw = 0;
  private spot = new THREE.Vector3();
  private spotSide = 1;
  private aim = new THREE.Vector3();
  private hist: { t: number; p: THREE.Vector3 }[] = [];
  private clock = 0;
  private tvYaw = Number.NaN;
  private tvPitch = 0;
  private tvFov = 40;

  constructor(private terrain: TerrainData) {}

  /** The astronaut has just stepped off: start the exit shot and forget old spots. */
  start(a: Astronaut): void {
    this.introT = 0;
    const f = new THREE.Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    const side = new THREE.Vector3(f.z, 0, -f.x);
    // In front and a little to the side (away from the rover), at chest height.
    this.introFrom.copy(a.pos).addScaledVector(f, 3.4).addScaledVector(side, 1.3);
    this.introFrom.y = this.terrain.height(this.introFrom.x, this.introFrom.z) + 1.35;
    this.idleYaw = 0;
    this.spot.set(Number.NaN, 0, 0);
    this.hist.length = 0;
    this.tvYaw = Number.NaN;
  }

  /**
   * Chase-camera additions: the exit shot (returns the blend weight of the intro
   * position) and the slow swing to the front while standing still.
   */
  chase(dt: number, a: Astronaut, input: boolean): { intro: number; from: THREE.Vector3 } {
    this.introT += dt;
    const intro = 1 - THREE.MathUtils.smoothstep(this.introT, 1.6, 3.6);
    // Standing still for 3 s: come round to ~150° (front three-quarter), slowly, with a
    // gentle drift; moving or touching the controls: back behind.
    const front = a.idleTime > 3 && !input;
    const target = front ? Math.PI * 0.83 + 0.18 * Math.sin(a.idleTime * 0.11) : 0;
    const rate = front ? 0.55 : 1.6;
    this.idleYaw += THREE.MathUtils.clamp(target - this.idleYaw, -rate * dt, rate * dt);
    return { intro, from: this.introFrom };
  }

  /** Place the camera for a partner or TV shot. */
  shoot(shot: EvaShot, dt: number, a: Astronaut, camera: THREE.PerspectiveCamera, rover: { pos: THREE.Vector3; fwd: THREE.Vector3 }, baseFov: number): void {
    this.clock += dt;
    const chest = a.pos.clone();
    chest.y += 1.25;
    if (shot === 'partner') this.partner(dt, a, chest, camera, baseFov);
    else this.tv(dt, chest, camera, rover);
    camera.near = 0.05;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  private partner(dt: number, a: Astronaut, chest: THREE.Vector3, camera: THREE.PerspectiveCamera, baseFov: number): void {
    const moving = a.speed > 0.2;
    const dir = moving ? new THREE.Vector3(a.vel.x, 0, a.vel.z).normalize() : new THREE.Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    const to = new THREE.Vector3(this.spot.x - a.pos.x, 0, this.spot.z - a.pos.z);
    const dist = to.length();
    // Move on when passed (the partner is behind), too far, or the view is blocked.
    const passed = Number.isFinite(this.spot.x) && to.dot(dir) < -1.5;
    if (!Number.isFinite(this.spot.x) || passed || dist > 22 || !this.clear(this.spot, chest)) this.newSpot(a, dir, moving);
    camera.position.copy(this.spot);
    // A hand-held aim: follows the astronaut with a little lag.
    if (!Number.isFinite(this.aim.x) || this.aim.distanceToSquared(chest) > 100) this.aim.copy(chest);
    else this.aim.lerp(chest, 1 - Math.exp(-dt * 3));
    camera.up.set(0, 1, 0);
    camera.lookAt(this.aim);
    // The 60 mm Hasselblad lens covers ~50°: keep the field, narrower when far.
    const d = camera.position.distanceTo(chest);
    camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(2.4 / d)), 28, baseFov);
  }

  /** A spot 7-10 m ahead and 2.5-4.5 m to one side (alternating), with a clear view. */
  private newSpot(a: Astronaut, dir: THREE.Vector3, moving: boolean): void {
    const side = new THREE.Vector3(dir.z, 0, -dir.x);
    this.spotSide = -this.spotSide;
    const chest = a.pos.clone();
    chest.y += 1.25;
    const h = (n: number) => Math.abs(Math.sin(n * 12.9898 + this.clock * 78.233) * 43758.5453) % 1;
    for (let k = 0; k < 8; k++) {
      const ahead = (moving ? 7 : 3.5) + h(k) * (moving ? 3 : 1.5);
      const off = (2.5 + h(k + 0.5) * 2) * (k % 2 ? -this.spotSide : this.spotSide);
      const p = a.pos.clone().addScaledVector(dir, ahead).addScaledVector(side, off);
      p.y = this.terrain.height(p.x, p.z) + EYE;
      if (this.clear(p, chest) || k === 7) {
        this.spot.copy(p);
        return;
      }
    }
  }

  /** No ground between the camera and the astronaut's chest. */
  private clear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      const x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
      if (this.terrain.height(x, z) > from.y + (to.y - from.y) * t - 0.15) return false;
    }
    return true;
  }

  private tv(dt: number, chest: THREE.Vector3, camera: THREE.PerspectiveCamera, rover: { pos: THREE.Vector3; fwd: THREE.Vector3 }): void {
    // The GCTA on its mast at the front of the LRV, ~1.6 m up.
    const cam = rover.pos.clone().addScaledVector(rover.fwd, 1.25);
    cam.y = this.terrain.height(cam.x, cam.z) + 1.6;
    camera.position.copy(cam);
    // Houston sees where the astronaut was a round trip ago, and commands from that.
    this.hist.push({ t: this.clock, p: chest.clone() });
    while (this.hist.length > 2 && this.hist[1].t < this.clock - DELAY) this.hist.shift();
    const seen = this.hist[0].p;
    const d = seen.clone().sub(cam);
    const yaw = Math.atan2(d.x, d.z), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    if (!Number.isFinite(this.tvYaw)) {
      this.tvYaw = yaw;
      this.tvPitch = pitch;
    }
    let dy = yaw - this.tvYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.tvYaw += THREE.MathUtils.clamp(dy, -SLEW * dt, SLEW * dt);
    this.tvPitch += THREE.MathUtils.clamp(pitch - this.tvPitch, -SLEW * dt, SLEW * dt);
    camera.up.set(0, 1, 0);
    camera.lookAt(cam.x + Math.sin(this.tvYaw) * Math.cos(this.tvPitch), cam.y + Math.sin(this.tvPitch), cam.z + Math.cos(this.tvYaw) * Math.cos(this.tvPitch));
    // Zoom (6:1, ~8-48°) to keep a ~4 m field at the astronaut.
    const want = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(2 / Math.max(d.length(), 1))), 8, 48);
    this.tvFov += (want - this.tvFov) * Math.min(1, dt * 0.8);
    camera.fov = this.tvFov;
  }
}
