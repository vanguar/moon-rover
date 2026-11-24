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
 * every few years; the game shows one every few minutes (sizes 0.6-12 m, power
 * law: small ones far more often) - a game liberty, noted in docs/REALISM.md.
 */
const N = 4000;

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
  private timer = 40 + Math.random() * 60;
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
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 1.0, 40.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor;
        void main() { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(uColor, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
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

  update(dt: number, around: THREE.Vector3, camDir: THREE.Vector3): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 120 + Math.random() * 240;
      // Size: cumulative N(>D) ∝ D^-2 between 0.6 and 12 m crater radius.
      const r = Math.min(12, 0.6 * Math.pow(1 - Math.random() * 0.995, -0.5));
      // Somewhere ahead of the camera, 120-1200 m away, inside the map.
      const a = Math.atan2(camDir.x, camDir.z) + (Math.random() - 0.5) * 1.4;
      const d = 120 + Math.random() * 1080;
      const x = around.x + Math.sin(a) * d, z = around.z + Math.cos(a) * d;
      if (this.terrain.inside(x, z)) this.strike(x, z, r, around.x, around.z);
    }
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
}
