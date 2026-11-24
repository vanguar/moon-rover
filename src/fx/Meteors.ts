import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Meteoroid impacts on the Moon.
 *
 * Physics: meteoroids arrive at 20–70 km/s with no atmosphere to slow, heat or
 * reveal them - there is no fiery streak. The impact releases a flash of light
 * (seen from Earth as lunar impact flashes) and throws out an ejecta curtain:
 * an inverted cone of regolith at ~45° whose grains fly clean ballistic arcs and
 * fall back - no dust cloud lingers. Ejection speeds near the rim are of order
 * √(g·D); the crater is ~10–20× the impactor size, depth ≈ 0.2 D, with a raised
 * rim and a bright, immature ejecta blanket that rays out to a few diameters.
 *
 * Rate: on the real Moon a crater ≥ 1 m forms somewhere in an 8 × 8 km area only
 * every few years; the game shows one every couple of minutes (sizes 0.6-12 m, power
 * law: small ones far more often), always in view - a game liberty, as is the short
 * bright streak of the falling body (in vacuum it would not glow): both in docs/REALISM.md.
 */
const N = 4000;
/** Visible fall of the impactor before it strikes, s. */
const FALL_TIME = 0.6;

export interface FreshCrater {
  x: number;
  z: number;
  r: number;
  age: number;
}

export class Meteors {
  readonly points: THREE.Points;
  readonly fresh: FreshCrater[] = [];
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private life = new Float32Array(N);
  private size = new Float32Array(N);
  private geo: THREE.BufferGeometry;
  private aSize: Float32Array;
  private cursor = 0;
  private timer = 25 + Math.random() * 35;
  /** Impactors on their way down: start and end points, elapsed time, crater radius. */
  private falling: { from: THREE.Vector3; to: THREE.Vector3; t: number; r: number }[] = [];
  /** Streaks of the falling bodies: a fading tail and a bright head per body. */
  readonly streaks: THREE.LineSegments;
  private streakPos = new Float32Array(8 * 6);
  private streakCol = new Float32Array(8 * 6);
  /** Glowing heads of the falling bodies (a 1-pixel line alone is lost at a few hundred metres). */
  readonly heads: THREE.Points;
  private headPos = new Float32Array(8 * 3);
  private ndc = new THREE.Vector3();
  /** Called when a crater forms (terrain update, flash, sound, radio). */
  onImpact?: (x: number, z: number, r: number, dist: number) => void;

  constructor(private terrain: TerrainData) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.aSize = new Float32Array(N);
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.5, 0.49, 0.47) }, uScale: { value: 700 } },
      vertexShader: `attribute float aSize; uniform float uScale;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 2.0, 40.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor;
        void main() { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(uColor * 1.3, 1.0); // fresh, immature regolith is brighter
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;

    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.streakPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.streakCol, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setDrawRange(0, 0);
    this.streaks = new THREE.LineSegments(
      sg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.streaks.frustumCulled = false;

    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setDrawRange(0, 0);
    this.heads = new THREE.Points(
      hg,
      new THREE.ShaderMaterial({
        vertexShader: 'void main() { gl_PointSize = 9.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = exp(-r * r * 4.0);
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * a * 1.6, a); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.heads.frustumCulled = false;
  }

  setLight(c: THREE.Color): void {
    ((this.points.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).copy(c);
  }

  /** Strike now at a point (also used for testing). */
  strike(x: number, z: number, r: number, fromX: number, fromZ: number): void {
    const t = this.terrain;
    const g = 1.62;
    const n = Math.min(1600, Math.round(120 + r * r * 60));
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % N;
      const a = Math.random() * Math.PI * 2;
      const rr = r * (0.3 + 0.7 * Math.sqrt(Math.random()));
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      // Curtain at ~45°: speed ∝ √(g·R) · (R/r)^~1.2 (faster from deeper inside).
      const v = Math.sqrt(g * r * 2) * Math.pow(r / Math.max(rr, 0.2 * r), 1.1) * (0.6 + 0.6 * Math.random());
      const el = (40 + Math.random() * 12) * (Math.PI / 180);
      this.pos.set([px, t.height(px, pz) + 0.05, pz], i * 3);
      this.vel.set([Math.cos(a) * Math.cos(el) * v, Math.sin(el) * v, Math.sin(a) * Math.cos(el) * v], i * 3);
      this.life[i] = 1;
      this.size[i] = 0.02 + 0.12 * Math.pow(Math.random(), 4) * Math.min(1, r / 4);
    }
    this.fresh.push({ x, z, r, age: 0 });
    if (this.fresh.length > 12) this.fresh.shift();
    this.onImpact?.(x, z, r, Math.hypot(x - fromX, z - fromZ));
  }

  /**
   * Start the visible fall of an impactor onto (x, z), watched from `eye`; it strikes
   * FALL_TIME later. The fall starts ~19° above the target as seen from the eye (inside
   * the view) and arrives from one side at 35–65°, so it crosses the screen diagonally.
   */
  launch(x: number, z: number, r: number, eye: THREE.Vector3): void {
    const to = new THREE.Vector3(x, this.terrain.height(x, z), z);
    const dx = x - eye.x, dz = z - eye.z, dist = Math.hypot(dx, dz) || 1;
    const height = Math.min(400, Math.max(40, dist * 0.35));
    const el = ((35 + Math.random() * 30) * Math.PI) / 180;
    const side = Math.random() < 0.5 ? -1 : 1;
    // Mostly across the line of sight, a little away from the eye.
    const ax = (-dz / dist) * side + (dx / dist) * 0.4, az = (dx / dist) * side + (dz / dist) * 0.4;
    const k = height / Math.tan(el) / Math.hypot(ax, az);
    const from = new THREE.Vector3(x + ax * k, to.y + height, z + az * k);
    this.falling.push({ from, to, t: 0, r });
  }

  /** Pick an impact point in the camera's view, 80–450 m away, inside the map. */
  private pickTarget(around: THREE.Vector3, camera: THREE.Camera): [number, number] | null {
    const fwd = camera.getWorldDirection(this.ndc);
    const base = Math.atan2(fwd.x, fwd.z);
    for (let i = 0; i < 12; i++) {
      const a = base + (Math.random() - 0.5) * 0.7;
      const d = 80 + Math.random() * 370;
      const x = around.x + Math.sin(a) * d, z = around.z + Math.cos(a) * d;
      if (!this.terrain.inside(x, z)) continue;
      // The crater and the lower part of the fall must be on screen.
      const p = this.ndc.set(x, this.terrain.height(x, z) + 2, z).project(camera);
      if (p.z < 1 && Math.abs(p.x) < 0.85 && p.y > -0.9 && p.y < 0.6) return [x, z];
    }
    return null;
  }

  update(dt: number, around: THREE.Vector3, camera: THREE.Camera): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      const target = this.pickTarget(around, camera);
      // Nothing suitable in view (looking at the sky, map edge): try again shortly.
      this.timer = target ? 75 + Math.random() * 125 : 3;
      if (target) {
        // Size: cumulative N(>D) ∝ D^-2 between 0.6 and 12 m crater radius.
        this.launch(target[0], target[1], Math.min(12, 0.6 * Math.pow(1 - Math.random() * 0.995, -0.5)), camera.position);
      }
    }
    this.updateFalling(dt, around);
    for (const c of this.fresh) c.age += dt;
    const g = 1.62;
    const t = this.terrain;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      const k = i * 3;
      this.vel[k + 1] -= g * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.vel[k + 1] < 0 && this.pos[k + 1] < t.height(this.pos[k], this.pos[k + 2])) {
        this.life[i] = 0;
        continue;
      }
      this.pos.copyWithin(n * 3, k, k + 3);
      if (n !== i) {
        this.vel.copyWithin(n * 3, k, k + 3);
        this.life[n] = this.life[i];
        this.size[n] = this.size[i];
        this.life[i] = 0;
      }
      this.aSize[n] = this.size[n];
      n++;
    }
    this.cursor = n % N;
    this.geo.setDrawRange(0, n);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateFalling(dt: number, around: THREE.Vector3): void {
    let k = 0;
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      if (f.t >= FALL_TIME) {
        this.falling.splice(i, 1);
        this.strike(f.to.x, f.to.z, f.r, around.x, around.z);
        continue;
      }
      if (k >= 8) continue;
      // Head along the straight path; the tail is the last ~40 % of the way, fading out.
      const u = f.t / FALL_TIME, tail = Math.max(0, u - 0.35);
      const P = this.streakPos, C = this.streakCol, o = k * 6;
      P[o] = f.from.x + (f.to.x - f.from.x) * u;
      P[o + 1] = f.from.y + (f.to.y - f.from.y) * u;
      P[o + 2] = f.from.z + (f.to.z - f.from.z) * u;
      P[o + 3] = f.from.x + (f.to.x - f.from.x) * tail;
      P[o + 4] = f.from.y + (f.to.y - f.from.y) * tail;
      P[o + 5] = f.from.z + (f.to.z - f.from.z) * tail;
      C.set([2.4, 2.25, 2.0, 0, 0, 0], o);
      this.headPos.set([P[o], P[o + 1], P[o + 2]], k * 3);
      k++;
    }
    const g = this.streaks.geometry;
    g.setDrawRange(0, k * 2);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    const hg = this.heads.geometry;
    hg.setDrawRange(0, k);
    (hg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
