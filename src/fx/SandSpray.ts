import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Sand inside a dust devil, around the rover: grains of 0.1-2 mm lifted by the vortex,
 * flying with it and striking the rover.
 *
 * Flow (Rankine vortex moving with the devil): tangential speed V·r/rc inside the core,
 * V·rc/r outside (V ≈ 10-25 m/s on Mars); in the lowest ~1.5 m friction lets the
 * pressure gradient win and the air spirals INWARD; at the core wall it turns upward.
 * The core itself is nearly calm (the "eye": Perseverance's microphone heard the roar
 * drop and return as a devil passed over it on sol 215, Murdoch et al. 2022).
 *
 * Grains: launched from the ground in hops (saltation) where the wind is strong, then
 * pulled toward the local air speed with a response time of ~0.4 s (thin CO2 at
 * 6 mbar drags weakly) under Martian gravity; on landing they bounce or stop. The air
 * at 0.017 kg/m^3 cannot lift pebbles - only dust and sand: no stones fly here.
 *
 * Each grain is drawn as a short motion streak (what a camera sees of a grain doing
 * 10-20 m/s), never as a square sprite. Grains that reach the rover's body hit it:
 * counted for the sound of the impacts and for the slow sandblasting of its surfaces.
 */
const N = 4000;
const G = 3.721;
const TAU = 0.4;

export interface DevilFlow {
  x: number;
  z: number;
  /** Core radius, m. */
  r: number;
  /** Strength 0..1. */
  s: number;
  /** +1 anticlockwise seen from above, -1 clockwise. */
  spin: number;
  vx: number;
  vz: number;
}

export class SandSpray {
  readonly lines: THREE.Mesh;
  /** Grain impacts on the rover during the last update, and their summed energy (≈ v²). */
  hits = 0;
  hitEnergy = 0;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private life = new Float32Array(N);
  private head = new Float32Array(N * 3);
  private tail = new Float32Array(N * 3);
  private alpha = new Float32Array(N);
  private geo: THREE.InstancedBufferGeometry;
  private carry = 0;
  private cursor = 0;
  private u = new THREE.Vector3();

  constructor(private terrain: TerrainData) {
    // One camera-facing ribbon per grain from its tail to its head, at least ~1.5 px
    // wide: a streak like a fast grain on a photograph, never a square sprite.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    g.setAttribute('aHead', new THREE.InstancedBufferAttribute(this.head, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTail', new THREE.InstancedBufferAttribute(this.tail, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.InstancedBufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.6, 0.42, 0.28) }, uPx: { value: 1 / 720 } },
      vertexShader: `attribute vec3 aHead; attribute vec3 aTail; attribute float aA; uniform float uPx;
        varying float vA; varying float vS;
        void main() {
          vec4 h = projectionMatrix * viewMatrix * vec4(aHead, 1.0);
          vec4 t = projectionMatrix * viewMatrix * vec4(aTail, 1.0);
          vec4 c = mix(t, h, position.y);
          vec2 d = h.xy / max(h.w, 1e-3) - t.xy / max(t.w, 1e-3);
          vec2 n = normalize(vec2(-d.y, d.x) + 1e-6);
          // Width: a ~3 mm grain in world units, but never under ~1.5 px.
          float wNdc = max(0.003 * projectionMatrix[1][1] / max(c.w, 1e-3), uPx * 1.5);
          c.xy += n * position.x * wNdc * c.w;
          gl_Position = c;
          vA = aA; vS = position.x;
        }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; varying float vS;
        void main() { float a = vA * (1.0 - vS * vS);
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.Mesh(g, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
  }

  setLight(c: THREE.Color): void {
    ((this.lines.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).copy(c);
  }

  /** Screen height in pixels (minimum streak width). */
  setViewport(h: number): void {
    (this.lines.material as THREE.ShaderMaterial).uniforms.uPx.value = 2 / Math.max(h, 1);
  }

  /** Air velocity of the vortex at a point (m/s), into `out`. */
  flow(d: DevilFlow, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = x - d.x, dz = z - d.z, r = Math.hypot(dx, dz) + 1e-3;
    const V = 8 + 14 * d.s;
    const vt = V * (r < d.r ? r / d.r : d.r / r);
    const tx = (-dz / r) * d.spin, tz = (dx / r) * d.spin;
    // Inflow in the frictional layer near the ground, updraft at the core wall.
    const low = Math.max(0, 1 - y / 1.5);
    const vin = -0.45 * vt * low;
    const up = (1.5 + 3 * d.s) * Math.exp(-(((r - d.r) / (0.6 * d.r)) ** 2));
    return out.set(tx * vt + (dx / r) * vin + d.vx, up, tz * vt + (dz / r) * vin + d.vz);
  }

  /**
   * @param devil the devil over the rover (or null), @param rover its position, yaw and
   * the body's half extents (x across, y up, z along; body centre offset up).
   */
  update(dt: number, devil: DevilFlow | null, rover: { pos: THREE.Vector3; yaw: number; half: [number, number, number]; up: number }, cam: THREE.Vector3): void {
    dt = Math.min(dt, 0.05);
    const t = this.terrain;
    this.hits = 0;
    this.hitEnergy = 0;
    // Spawn: grains leave the ground where the wind exceeds the saltation threshold
    // (~10 m/s at 1 m on Mars), within ~25 m of the camera.
    if (devil && devil.s > 0.05) {
      const reach = Math.min(25, devil.r * 3);
      const dc = Math.hypot(cam.x - devil.x, cam.z - devil.z);
      if (dc < reach + 25) {
        this.carry += dt * 2600 * devil.s;
        while (this.carry >= 1) {
          this.carry -= 1;
          const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 16;
          const x = cam.x + Math.cos(a) * rr, z = cam.z + Math.sin(a) * rr;
          const f = this.flow(devil, x, 0.2, z, this.u);
          const sp = Math.hypot(f.x - devil.vx, f.z - devil.vz);
          if (sp < 9 || Math.random() > (sp - 9) / 8) continue;
          const i = this.cursor;
          this.cursor = (this.cursor + 1) % N;
          // Saltation: off at a fraction of the wind speed, steeply upward (0.5-3 m/s).
          this.pos.set([x, t.height(x, z) + 0.02, z], i * 3);
          this.vel.set([f.x * 0.35, 0.5 + Math.random() * Math.random() * 2.5 + f.y * 0.3, f.z * 0.35], i * 3);
          this.life[i] = 2 + Math.random() * 3;
        }
      }
    }
    const c = Math.cos(rover.yaw), s = Math.sin(rover.yaw);
    const [hx, hy, hz] = rover.half;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      let x = this.pos[k], y = this.pos[k + 1], z = this.pos[k + 2];
      if (devil) {
        const f = this.flow(devil, x, y - t.height(x, z), z, this.u);
        this.vel[k] += ((f.x - this.vel[k]) / TAU) * dt;
        this.vel[k + 1] += ((f.y - this.vel[k + 1]) / TAU) * dt * 0.5;
        this.vel[k + 2] += ((f.z - this.vel[k + 2]) / TAU) * dt;
      }
      this.vel[k + 1] -= G * dt;
      x += this.vel[k] * dt;
      y += this.vel[k + 1] * dt;
      z += this.vel[k + 2] * dt;
      // The rover's body (an oriented box): the grain strikes it and bounces off.
      const lx = (x - rover.pos.x) * c - (z - rover.pos.z) * s, lz = (x - rover.pos.x) * s + (z - rover.pos.z) * c;
      const ly = y - rover.pos.y - rover.up;
      if (Math.abs(lx) < hx && Math.abs(lz) < hz && Math.abs(ly) < hy) {
        const v2 = this.vel[k] ** 2 + this.vel[k + 1] ** 2 + this.vel[k + 2] ** 2;
        this.hits++;
        this.hitEnergy += v2;
        this.vel[k] *= -0.3;
        this.vel[k + 2] *= -0.3;
        this.vel[k + 1] = Math.abs(this.vel[k + 1]) * 0.3;
        x = this.pos[k];
        z = this.pos[k + 2];
        y = this.pos[k + 1];
      }
      const gy = t.height(x, z);
      if (y < gy) {
        // Landing: a fast grain rebounds (and the splash goes on), a slow one stays.
        const sp = Math.hypot(this.vel[k], this.vel[k + 2]);
        if (sp > 4 && Math.random() < 0.7) {
          y = gy + 0.01;
          this.vel[k + 1] = sp * (0.15 + 0.25 * Math.random());
          this.vel[k] *= 0.6;
          this.vel[k + 2] *= 0.6;
        } else this.life[i] = 0;
      }
      this.pos[k] = x;
      this.pos[k + 1] = y;
      this.pos[k + 2] = z;
      if (this.life[i] <= 0) continue;
      // Streak: where the grain was ~1/60 s ago (motion blur), fading toward the tail.
      const o = n * 3;
      this.head[o] = x;
      this.head[o + 1] = y;
      this.head[o + 2] = z;
      // Tail: where the grain was 1/30 s ago (motion blur of a camera frame).
      this.tail[o] = x - this.vel[k] * 0.033;
      this.tail[o + 1] = y - this.vel[k + 1] * 0.033;
      this.tail[o + 2] = z - this.vel[k + 2] * 0.033;
      this.alpha[n] = Math.min(1, this.life[i]) * 0.8;
      n++;
    }
    const g = this.geo;
    g.instanceCount = n;
    (g.getAttribute('aHead') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aTail') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aA') as THREE.BufferAttribute).needsUpdate = true;
  }
}
