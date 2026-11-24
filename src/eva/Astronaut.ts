import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * An Apollo astronaut on foot (EVA), in the A7L-B suit with the PLSS backpack.
 *
 * Locomotion in 1/6 g, as filmed on Apollo 11-17: with so little weight the boots
 * barely grip (a hard push only slides), so the astronauts moved in a "kangaroo
 * hop" or loping skip - both feet together, body leaning forward to keep the
 * centre of mass over the push - at 1-2 m/s, about 0.5-0.9 s in the air per hop.
 * Accelerating and stopping take several hops; a standing jump reaches ~0.5 m
 * (John Young's jump salute, Apollo 16, ~0.4 m with suit and PLSS ≈ 170 kg).
 *
 * Ground: the terrain or the top of a rock, whichever is higher (`ground`). Rocks
 * up to STEP are stepped onto in stride; a higher one stops the astronaut like a
 * wall - jump onto it (Space, ~0.5 m) - and walking off its edge is a free fall in
 * 1/6 g. Terrain slopes steeper than ~25° cannot be climbed or stepped down, so
 * no one walks into the rille.
 */
const G = 1.62;
/** Top loping speed, m/s, and backward shuffle. */
const VMAX = 2.0;
const VBACK = 0.6;
/** Ground traction in 1/6 g: friction μ ≈ 0.6 → ≈ 1 m/s² of push while the boots are down. */
const ACCEL = 1.0;
/** The push of each take-off, m/s: 4-5 hops from standing to a full lope. */
const HOP_PUSH = 0.4;
const TURN = 1.8;
const MAX_SLOPE = Math.tan(THREE.MathUtils.degToRad(25));
/** Highest step taken in stride (a cobble, a low ledge), m; higher needs a jump. */
const STEP = 0.3;
/** Body radius for running into rocks, m (the suit with the PLSS). */
const BODY_R = 0.3;

export interface EvaInput {
  /** −1 (back) .. 1 (forward). */
  fwd: number;
  /** −1 .. 1, positive turns right. */
  turn: number;
  /** Jump (held: jump on the next touchdown). */
  jump: boolean;
}

export class Astronaut {
  readonly object = new THREE.Group();
  /** Eye point inside the helmet (first-person camera). */
  readonly camAnchor = new THREE.Object3D();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Heading: forward = (sin yaw, 0, cos yaw). */
  yaw = 0;
  onGround = true;
  /** Horizontal speed, m/s. */
  speed = 0;
  private land = 0;
  private body = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private kneeL = new THREE.Group();
  private kneeR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();

  /** ground(x, z): height to stand on - the terrain or a rock top, whichever is higher. */
  constructor(private terrain: TerrainData, private ground: (x: number, z: number) => number, x: number, z: number, yaw: number) {
    this.buildModel();
    this.yaw = yaw;
    this.pos.set(x, ground(x, z), z);
    this.sync();
  }

  private buildModel(): void {
    const suit = new THREE.MeshStandardMaterial({ color: 0xeceae4, roughness: 0.85 });
    const suitDust = new THREE.MeshStandardMaterial({ color: 0x9c9a95, roughness: 0.95 });
    const red = new THREE.MeshStandardMaterial({ color: 0xa8231c, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.6 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x5d6470, roughness: 0.7 });
    const visor = new THREE.MeshStandardMaterial({ color: 0xd4a23c, metalness: 1, roughness: 0.12 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.8, roughness: 0.35 });
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    // Legs: hip pivot at 0.95 m, knee at 0.5 m; lunar-dusty lower legs and boots.
    for (const [leg, knee, sx] of [[this.legL, this.kneeL, 0.12], [this.legR, this.kneeR, -0.12]] as const) {
      leg.position.set(sx, 0.95, 0);
      this.body.add(leg);
      mesh(new THREE.CapsuleGeometry(0.105, 0.3, 4, 10), suit, 0, -0.22, 0, leg);
      knee.position.set(0, -0.45, 0);
      leg.add(knee);
      mesh(new THREE.CapsuleGeometry(0.095, 0.3, 4, 10), suitDust, 0, -0.2, 0, knee);
      mesh(new THREE.BoxGeometry(0.15, 0.1, 0.3), dark, 0, -0.45, 0.04, knee);
      // Commander's red stripe (Apollo 15 CDR Dave Scott).
      mesh(new THREE.CylinderGeometry(0.108, 0.108, 0.05, 12), red, 0, -0.12, 0, leg);
    }
    // Torso and pressure suit.
    mesh(new THREE.CapsuleGeometry(0.24, 0.42, 6, 14), suit, 0, 1.28, 0, this.body).scale.set(1, 1, 0.8);
    mesh(new THREE.BoxGeometry(0.26, 0.14, 0.1), suit, 0, 1.28, 0.2, this.body); // remote control unit
    mesh(new THREE.BoxGeometry(0.06, 0.05, 0.02), metal, 0.07, 1.3, 0.255, this.body);
    // PLSS backpack and the oxygen purge system on top.
    mesh(new THREE.BoxGeometry(0.5, 0.62, 0.24), suit, 0, 1.32, -0.3, this.body);
    mesh(new THREE.BoxGeometry(0.46, 0.18, 0.22), suit, 0, 1.72, -0.29, this.body);
    mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.25), metal, 0.18, 1.88, -0.32, this.body); // antenna
    // Helmet: clear bubble with the gold-coated extravehicular visor.
    mesh(new THREE.SphereGeometry(0.19, 20, 14), suit, 0, 1.74, -0.02, this.body);
    mesh(new THREE.SphereGeometry(0.195, 20, 14, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.22, Math.PI * 0.5), visor, 0, 1.74, -0.015, this.body);
    // Arms: shoulders at 1.5 m, slightly out from the body (the pressurised suit).
    for (const [arm, sx] of [[this.armL, 0.3], [this.armR, -0.3]] as const) {
      arm.position.set(sx, 1.5, 0);
      arm.rotation.z = sx > 0 ? 0.25 : -0.25;
      this.body.add(arm);
      mesh(new THREE.CapsuleGeometry(0.085, 0.5, 4, 10), suit, 0, -0.32, 0.04, arm);
      mesh(new THREE.CylinderGeometry(0.088, 0.088, 0.05, 12), red, 0, -0.18, 0.04, arm);
      mesh(new THREE.SphereGeometry(0.075, 12, 8), glove, 0, -0.66, 0.08, arm);
    }
    this.camAnchor.position.set(0, 1.74, 0.08);
    this.body.add(this.camAnchor);
    this.object.add(this.body);
  }

  /** One simulation step: lope/hop over the ground height field. */
  update(dt: number, input: EvaInput): void {
    dt = Math.min(dt, 0.05);
    const t = this.terrain;
    this.yaw -= input.turn * TURN * dt * (this.onGround ? 1 : 0.4);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    if (this.onGround) {
      // Push off along the heading: limited by traction, several hops to get going.
      const target = input.fwd >= 0 ? input.fwd * VMAX : input.fwd * VBACK;
      const along = this.vel.x * fx + this.vel.z * fz;
      const dv = THREE.MathUtils.clamp(target - along, -ACCEL * dt * 1.6, ACCEL * dt);
      // Sideways sliding dies out quickly on the ground.
      const side = -this.vel.x * fz + this.vel.z * fx;
      const nAlong = along + dv, nSide = side * Math.max(0, 1 - dt * 6);
      this.vel.set(fx * nAlong - fz * nSide, 0, fz * nAlong + fx * nSide);
      this.land = Math.max(0, this.land - dt);
      const moving = Math.abs(nAlong) > 0.25;
      if ((moving || input.jump) && this.land <= 0) {
        // Hop: higher when faster (0.5-0.85 s aloft); a standing jump ~0.5 m.
        // Each take-off is also the push: most of the speed change happens here.
        const push = THREE.MathUtils.clamp(target - nAlong, -HOP_PUSH * 1.5, HOP_PUSH);
        this.vel.x += fx * push;
        this.vel.z += fz * push;
        const k = Math.min(1, Math.abs(nAlong + push) / VMAX);
        this.vel.y = input.jump ? 1.3 : 0.42 + 0.3 * k;
        this.onGround = false;
      }
    } else {
      this.vel.y -= G * dt;
    }
    // Horizontal move: refused into terrain slopes steeper than ~25° (up or down), and
    // into anything rising more than a step above the feet (a rock face) - checked at
    // the new position and one body radius ahead of it.
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const run = Math.hypot(nx - this.pos.x, nz - this.pos.z);
    if (run > 1e-5) {
      const ux = (nx - this.pos.x) / run, uz = (nz - this.pos.z) / run;
      const hNew = t.height(nx, nz);
      const steep = Math.abs(t.height(nx + ux * 0.6, nz + uz * 0.6) - hNew) / 0.6 > MAX_SLOPE;
      const ax = nx + ux * BODY_R, az = nz + uz * BODY_R;
      // Only a rock is a wall (the terrain's own rise is the slope rule's business).
      const top = Math.max(this.ground(nx, nz), this.ground(ax, az)), terr = Math.max(hNew, t.height(ax, az));
      const rise = top > terr + 0.01 ? top - this.pos.y : -Infinity;
      if (steep || rise > (this.onGround ? STEP : 0.02)) {
        this.vel.x = 0;
        this.vel.z = 0;
      } else {
        this.pos.x = nx;
        this.pos.z = nz;
      }
    }
    const g = this.ground(this.pos.x, this.pos.z);
    if (this.onGround) {
      // Off the edge of a rock: a free fall; otherwise follow small steps up and down.
      if (g < this.pos.y - 0.08) {
        this.onGround = false;
        this.vel.y = Math.min(this.vel.y, 0);
      } else this.pos.y = g;
    } else {
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= g && this.vel.y < 0) {
        this.pos.y = g;
        this.vel.y = 0;
        this.onGround = true;
        this.land = 0.12; // knees absorb the landing before the next push
      }
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.animate();
    this.sync();
  }

  /** Lean into the motion, feet together in flight, knees bend on landing, arms out for balance. */
  private animate(): void {
    const k = Math.min(1, this.speed / VMAX);
    const air = this.onGround ? 0 : THREE.MathUtils.clamp(0.5 + this.vel.y, 0, 1);
    const crouch = this.onGround ? this.land / 0.12 : 0;
    this.body.rotation.x = 0.08 + 0.22 * k;
    for (const leg of [this.legL, this.legR]) leg.rotation.x = -0.25 * k * air - 0.35 * crouch;
    for (const knee of [this.kneeL, this.kneeR]) knee.rotation.x = 0.3 * air + 0.7 * crouch;
    this.body.position.y = -0.12 * crouch;
    const sw = 0.25 + 0.25 * k * air;
    this.armL.rotation.x = -0.35 * k - 0.15 * air;
    this.armR.rotation.x = -0.35 * k - 0.15 * air;
    this.armL.rotation.z = sw;
    this.armR.rotation.z = -sw;
  }

  private sync(): void {
    this.object.position.copy(this.pos);
    this.object.rotation.set(0, this.yaw, 0);
    this.object.updateMatrixWorld(true);
  }

  /** Compass heading, degrees clockwise from north (−z). */
  get heading(): number {
    const h = (Math.atan2(Math.sin(this.yaw), -Math.cos(this.yaw)) * 180) / Math.PI;
    return h < 0 ? h + 360 : h;
  }

  dispose(): void {
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
