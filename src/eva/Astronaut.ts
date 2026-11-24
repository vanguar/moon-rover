import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
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
  /** Touchdown at (x, z) with heading yaw and horizontal speed v: both boots leave prints. */
  onLand?: (x: number, z: number, yaw: number, v: number) => void;
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

  /**
   * The A7L-B EMU of Apollo 15-17, after NASA/Smithsonian descriptions and photos:
   * Beta-cloth outer garment with convolute (bellows) joints at shoulders, elbows and
   * knees; LEVA - a white shell over the bubble helmet with the 24-carat gold visor;
   * the PLSS backpack with the OPS on top; the RCU on the chest carrying the Hasselblad;
   * red and blue oxygen connectors; lunar overshoes with light-blue ribbed silicone
   * soles; gloves with blue fingertips; the commander's red stripes (from Apollo 13);
   * the flag on the left shoulder; lower legs grey with lunar dust.
   */
  private buildModel(): void {
    const M = (color: number, rough = 0.9, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const beta = M(0xe7e5de), betaDust = M(0xa3a09a, 0.95), betaShade = M(0xd2d0c9);
    const red = M(0xa82a20, 0.7), blue = M(0x2c5ea8, 0.5), sole = M(0x86b7dc, 0.6);
    const glove = M(0x9aa3ad, 0.8), tips = M(0x35558a, 0.6), dark = M(0x2c2e33, 0.6);
    const metal = M(0xb9bdc3, 0.35, 0.85), gold = M(0xd6a640, 0.12, 1);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    const ring = (r: number, parent: THREE.Object3D, y: number, m: THREE.Material = betaShade, z = 0) => {
      const o = add(new THREE.TorusGeometry(r, r * 0.16, 6, 18), m, 0, y, z, parent);
      o.rotation.x = Math.PI / 2;
      return o;
    };
    // Legs: hip pivot at 0.95 m, knee at 0.5 m.
    for (const [leg, knee, sx] of [[this.legL, this.kneeL, 0.13], [this.legR, this.kneeR, -0.13]] as const) {
      leg.position.set(sx, 0.95, 0);
      this.body.add(leg);
      add(new THREE.CylinderGeometry(0.118, 0.104, 0.42, 14), beta, 0, -0.22, 0, leg);
      add(new RoundedBoxGeometry(0.07, 0.14, 0.15, 2, 0.02), betaShade, sx > 0 ? 0.1 : -0.1, -0.22, 0.02, leg); // thigh pocket
      add(new THREE.CylinderGeometry(0.121, 0.121, 0.045, 14), red, 0, -0.38, 0, leg); // commander's stripe
      knee.position.set(0, -0.45, 0);
      leg.add(knee);
      for (let k = 0; k < 3; k++) ring(0.105, knee, 0.03 - k * 0.035, betaShade);
      add(new THREE.CylinderGeometry(0.1, 0.088, 0.36, 14), betaDust, 0, -0.2, 0, knee);
      // Lunar overshoe: white upper, light-blue ribbed sole (33.6 × 15.2 cm, 8 ribs).
      add(new RoundedBoxGeometry(0.15, 0.11, 0.33, 3, 0.04), betaDust, 0, -0.4, 0.045, knee);
      add(new THREE.BoxGeometry(0.152, 0.022, 0.336), sole, 0, -0.462, 0.045, knee);
      for (let k = 0; k < 8; k++) add(new THREE.BoxGeometry(0.13, 0.008, 0.02), sole, 0, -0.476, -0.1 + k * 0.041, knee);
    }
    // Torso (upper and lower), shoulder bellows.
    add(new RoundedBoxGeometry(0.5, 0.56, 0.34, 4, 0.12), beta, 0, 1.3, 0, this.body);
    add(new RoundedBoxGeometry(0.44, 0.26, 0.3, 3, 0.1), beta, 0, 1.0, 0, this.body);
    // RCU on the chest with the Hasselblad on its bracket; oxygen connectors.
    add(new RoundedBoxGeometry(0.24, 0.15, 0.1, 2, 0.02), betaShade, 0, 1.33, 0.21, this.body);
    add(new THREE.BoxGeometry(0.22, 0.02, 0.08), dark, 0, 1.41, 0.21, this.body);
    for (const kx of [-0.07, 0, 0.07]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8), metal, kx, 1.425, 0.22, this.body);
    add(new THREE.BoxGeometry(0.1, 0.1, 0.07), metal, 0, 1.22, 0.28, this.body);
    const lens = add(new THREE.CylinderGeometry(0.03, 0.032, 0.05, 14), dark, 0, 1.22, 0.335, this.body);
    lens.rotation.x = Math.PI / 2;
    for (const [cx, m] of [[0.17, red], [0.17, blue], [-0.17, red], [-0.17, blue]] as const) {
      const c = add(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 10), m, cx, m === red ? 1.2 : 1.13, 0.17, this.body);
      c.rotation.x = Math.PI / 2;
    }
    // PLSS with the OPS on top, straps.
    add(new RoundedBoxGeometry(0.5, 0.64, 0.24, 3, 0.05), beta, 0, 1.32, -0.3, this.body);
    add(new RoundedBoxGeometry(0.46, 0.19, 0.22, 3, 0.04), betaShade, 0, 1.73, -0.29, this.body);
    add(new THREE.BoxGeometry(0.42, 0.02, 0.02), dark, 0, 1.6, -0.18, this.body);
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.3), metal, 0.19, 1.92, -0.33, this.body); // VHF antenna
    // LEVA over the bubble helmet: white shell, gold visor, commander's stripe on top.
    const head = new THREE.Group();
    head.position.set(0, 1.73, 0.0);
    this.body.add(head);
    add(new THREE.SphereGeometry(0.205, 24, 16), beta, 0, 0, -0.015, head);
    // SphereGeometry's φ = π/2 faces +z (the front): the visor spans ±0.38π around it.
    add(new THREE.SphereGeometry(0.209, 24, 16, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.2, Math.PI * 0.46), gold, 0, 0, -0.012, head);
    const stripe = add(new THREE.TorusGeometry(0.207, 0.012, 6, 24, Math.PI), red, 0, 0, -0.015, head);
    stripe.rotation.y = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.15, 0.17, 0.06, 18), betaShade, 0, -0.17, -0.01, head); // neck ring
    // Arms: shoulders at 1.52 m, held out a little by the pressurised suit.
    for (const [arm, sx] of [[this.armL, 0.31], [this.armR, -0.31]] as const) {
      arm.position.set(sx, 1.52, 0);
      arm.rotation.z = sx > 0 ? 0.25 : -0.25;
      this.body.add(arm);
      for (let k = 0; k < 2; k++) ring(0.098, arm, -0.02 - k * 0.04);
      add(new THREE.CylinderGeometry(0.092, 0.084, 0.28, 12), beta, 0, -0.2, 0.02, arm);
      for (let k = 0; k < 3; k++) ring(0.086, arm, -0.36 - k * 0.032, betaShade, 0.03);
      add(new THREE.CylinderGeometry(0.093, 0.093, 0.04, 12), red, 0, -0.3, 0.025, arm);
      add(new THREE.CylinderGeometry(0.08, 0.075, 0.24, 12), beta, 0, -0.55, 0.04, arm);
      add(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 12), betaShade, 0, -0.69, 0.05, arm); // wrist ring
      add(new RoundedBoxGeometry(0.1, 0.13, 0.07, 2, 0.03), glove, 0, -0.78, 0.06, arm);
      add(new RoundedBoxGeometry(0.095, 0.04, 0.065, 2, 0.02), tips, 0, -0.85, 0.065, arm);
    }
    // The flag on the left upper arm.
    const flag = add(new THREE.PlaneGeometry(0.1, 0.065), new THREE.MeshStandardMaterial({ map: flagTexture(), roughness: 0.9 }), 0.095, -0.12, 0.02, this.armL);
    flag.rotation.y = Math.PI / 2;
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
        this.onLand?.(this.pos.x, this.pos.z, this.yaw, Math.hypot(this.vel.x, this.vel.z));
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

/** US flag patch (13 stripes, blue canton with stars as dots). */
function flagTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 76;
  c.height = 40;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 13; i++) {
    g.fillStyle = i % 2 ? '#f3f1ea' : '#b22234';
    g.fillRect(0, (i * 40) / 13, 76, 40 / 13 + 0.5);
  }
  g.fillStyle = '#3c3b6e';
  g.fillRect(0, 0, 30, 21.5);
  g.fillStyle = '#f3f1ea';
  for (let r = 0; r < 9; r++) for (let k = 0; k < (r % 2 ? 5 : 6); k++) g.fillRect(2 + k * 5 + (r % 2 ? 2.5 : 0), 1.5 + r * 2.2, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
