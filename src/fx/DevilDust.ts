import * as THREE from 'three';
import { HASH2I_GLSL } from '../render/hash';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * The foot of a dust devil, simulated as particles, and the dark track it leaves.
 *
 * Flow (Rankine vortex with a surface boundary layer, as in the models of Kanak 2005
 * and the Mars measurements of Ellehoj et al. 2010, Jackson & Lorenz 2015):
 *  - tangential speed v_t = V_max · r/rc inside the core, V_max · rc/r outside
 *    (V_max ≈ 10–20 m/s on Mars);
 *  - in the lowest metre friction slows the rotation, so the pressure gradient wins
 *    and air (with sand and dust) spirals INWARD along the ground;
 *  - near the core wall it turns upward (≈ 2–5 m/s), lifting the dust into the column;
 *  - higher up the lifted dust is flung outward and falls back or drifts away.
 * Coarse grains (sand) hop and fall back quickly; fine dust stays aloft.
 *
 * Track: the vortex removes the bright surface dust and exposes darker material, so
 * devils leave dark streaks (seen from orbit and by Perseverance's cameras).
 */
// Kept modest: big soft sprites close to the camera cost a lot of fill rate.
// Track ribbon: 4800 pieces of 1.5 m - with seven devils (~20 pieces/s) ~4 min, longer
// than a track lives (TRACK_HOLD + TRACK_FADE), so no visible piece is ever reused.
const N = 1200;
const TRACK_N = 4800;
/** Track age (s) at which the wind starts covering it again, and how long that takes. */
const TRACK_HOLD = 90;
const TRACK_FADE = 120;
/** Track ribbon cells across: a band tens of metres wide must follow the ground. */
// 16 across: the band hugs the ground (with 4 the terrain between the vertices cut it
// off along straight lines).
const TRACK_K = 16;
/** Segments (1.5 m each) over which a track's head fades in. */
const RAMP = 8;
/** Vertices per track segment: a row of TRACK_K + 1 at its start and at its end. */
const TRACK_V = 2 * (TRACK_K + 1);

interface DevilIn {
  id: number;
  x: number;
  z: number;
  r: number;
  s: number;
  spin: number;
  vx: number;
  vz: number;
}

export class DevilDust {
  readonly points: THREE.Points;
  readonly track: THREE.Mesh;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private life = new Float32Array(N);
  private kind = new Float32Array(N); // 0 sand, 1 dust
  /** Base size per particle, m: a power-law spread from fine silt haze to sand grains. */
  private base = new Float32Array(N);
  private owner = new Int32Array(N).fill(-1);
  private geo: THREE.BufferGeometry;
  private aSize: Float32Array;
  private aAlpha: Float32Array;
  private cursor = 0;
  private carry = new Map<number, number>();
  private tPos = new Float32Array(TRACK_N * TRACK_V * 3);
  private tAlpha = new Float32Array(TRACK_N * TRACK_V);
  /** Time each track vertex was laid (s, this.time). */
  private tBirth = new Float32Array(TRACK_N * TRACK_V).fill(-1e6);
  private time = 0;
  private trackU = { uNow: { value: 0 } };
  private tHead = 0;
  private lastTrack = new Map<number, { x: number; z: number; age: number; along: number; edge?: number[]; recent: number[]; s: number; count: number }>();
  private trackGeo: THREE.BufferGeometry;

  constructor(private terrain: TerrainData) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.aSize = new Float32Array(N);
    this.aAlpha = new Float32Array(N);
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.55, 0.38, 0.25) }, uScale: { value: 700 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main() { vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.75, 36.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          gl_FragColor = vec4(uColor, vA * (1.0 - r));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;

    // Track ribbons: multiplicative darkening (the bright dust coat is stripped off).
    this.trackGeo = new THREE.BufferGeometry();
    this.trackGeo.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.trackGeo.setAttribute('aA', new THREE.BufferAttribute(this.tAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.trackGeo.setAttribute('aB', new THREE.BufferAttribute(this.tBirth, 1).setUsage(THREE.DynamicDrawUsage));
    const uv = new Float32Array(TRACK_N * TRACK_V * 2);
    const idx = new Uint32Array(TRACK_N * TRACK_K * 6);
    for (let q = 0; q < TRACK_N; q++) {
      const v = q * TRACK_V;
      for (let k = 0; k < TRACK_K; k++) {
        const a = v + k, b = v + TRACK_K + 1 + k;
        idx.set([a, b, a + 1, a + 1, b, b + 1], (q * TRACK_K + k) * 6);
      }
    }
    this.trackGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.trackGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const tm = new THREE.ShaderMaterial({
      vertexShader: `attribute float aA; attribute float aB; varying float vA; varying float vB; varying vec2 vUv; uniform float uCurvK;
        void main() { vA = aA; vB = aB; vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0);
          vec2 dc = w.xz - cameraPosition.xz; w.y -= dot(dc, dc) * uCurvK;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `varying float vA; varying float vB; varying vec2 vUv; uniform float uNow;
        ${HASH2I_GLSL}
        float h(vec2 p) { return hash2i(p); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          // vUv.x: across the track (0..1), vUv.y: metres along the devil's path.
          float a = vUv.y, c = vUv.x * 2.0 - 1.0;
          // Ragged, wandering, diffuse edges - the vortex swept a wavering band, not a strip.
          float wob = (n(vec2(a * 0.12, 1.0)) - 0.5) * 0.5 + (n(vec2(a * 0.5, 7.0)) - 0.5) * 0.25;
          float width = 0.45 + 0.5 * n(vec2(a * 0.07, 3.0));
          // Fully soft edges: the scour thins out toward the sides, no rim.
          float e = abs(c + wob) / width;
          float edge = exp(-e * e * 2.2) * smoothstep(1.0, 0.75, abs(c));
          // Intermittent: where the vortex weakened or lost contact the scour fades out.
          float patchy = mix(0.15, 1.0, smoothstep(0.25, 0.65, n(vec2(a * 0.025, 11.0)) * 0.7 + n(vec2(a * 0.09, c * 1.5 + 4.0)) * 0.3));
          // Scour loops from the rotation while the devil drifts: curved, irregular
          // arcs (warped noise), not a periodic stripe pattern.
          float lw = n(vec2(a * 0.11, c * 0.9 + 3.0)) * 4.0;
          float loops = 0.65 + 0.35 * smoothstep(0.35, 0.8, n(vec2(a * 0.45 + c * 1.1 + lw, c * 1.6 - lw * 0.5 + 9.0)));
          float speck = 0.7 + 0.3 * n(vec2(a * 2.3, c * 5.0));
          // The wind lays dust back over the track: it pales in patches, here sooner and
          // there later (noise), never segment by segment, and is gone before its piece
          // of the ribbon is reused.
          float cover = (uNow - vB - ${TRACK_HOLD.toFixed(1)}) / ${TRACK_FADE.toFixed(1)};
          float when = n(vec2(a * 0.06, c * 1.7 + 20.0)) * 0.55 + n(vec2(a * 0.23, c * 4.0 + 40.0)) * 0.3 + n(vec2(a * 0.9, c * 9.0)) * 0.15;
          float stay = 1.0 - smoothstep(when * 0.75, when * 0.75 + 0.25, cover);
          // Seen from the ground a devil track is subtle (it stands out from orbit).
          float k = 1.0 - 0.12 * vA * edge * loops * speck * patchy * stay;
          gl_FragColor = vec4(vec3(k * 0.5), 1.0); }`,
      uniforms: { uCurvK: { value: 0.5 / 3389500 }, uNow: this.trackU.uNow },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.track = new THREE.Mesh(this.trackGeo, tm);
    this.track.frustumCulled = false;
    this.track.renderOrder = 1;
  }

  setLight(c: THREE.Color): void {
    ((this.points.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).copy(c);
  }

  update(dt: number, devils: DevilIn[], cam: THREE.Vector3): void {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.trackU.uNow.value = this.time;
    const t = this.terrain;
    // Spawn at the feet of the devils near the camera.
    const byId = new Map<number, DevilIn>();
    for (const d of devils) byId.set(d.id, d);
    devils.forEach((d) => {
      const di = d.id;
      this.trackStep(di, d, dt);
      const dist = Math.hypot(d.x - cam.x, d.z - cam.z);
      if (dist > 350 || d.s < 0.05) return;
      const rc = d.r;
      const rate = (90 + rc * 12) * d.s * (dist < 150 ? 1 : 0.4);
      let c = (this.carry.get(di) ?? 0) + rate * dt;
      while (c >= 1) {
        c -= 1;
        const i = this.cursor;
        this.cursor = (this.cursor + 1) % N;
        const a = Math.random() * Math.PI * 2;
        const r = rc * (1.2 + Math.random() * 2.3);
        const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
        this.pos[i * 3] = x;
        this.pos[i * 3 + 1] = t.height(x, z) + 0.05;
        this.pos[i * 3 + 2] = z;
        this.vel[i * 3] = d.vx;
        this.vel[i * 3 + 1] = 0.5 + Math.random();
        this.vel[i * 3 + 2] = d.vz;
        this.life[i] = 3 + Math.random() * 5;
        // Size spectrum (Martian dust ~1-3 µm haze up to 0.1-1 mm saltating sand): drawn
        // as clumps from a power law - many tiny specks, fewer puffs, rare big haze blobs.
        const sand = Math.random() < 0.35;
        this.kind[i] = sand ? 0 : 1;
        const u = Math.random();
        this.base[i] = sand ? 0.008 + 0.05 * u * u * u : 0.015 + 0.75 * Math.pow(u, 3.2);
        this.owner[i] = di;
      }
      this.carry.set(di, c);
    });

    const g = 3.721;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      const d = byId.get(this.owner[i]);
      this.life[i] -= dt;
      if (!d || this.life[i] <= 0) {
        this.life[i] = 0;
        continue;
      }
      const k = i * 3;
      const px = this.pos[k], py = this.pos[k + 1], pz = this.pos[k + 2];
      const gy = t.height(px, pz);
      const hAbove = py - gy;
      const rx = px - d.x, rz = pz - d.z;
      const r = Math.hypot(rx, rz) + 1e-3;
      const rc = d.r;
      const vmax = (10 + rc * 0.3) * d.s;
      const vt = (r < rc ? (vmax * r) / rc : (vmax * rc) / r) * d.spin;
      // Ground friction layer: weaker rotation, radial inflow; above it the inflow stops.
      const bl = Math.exp(-hAbove / (0.4 + rc * 0.05));
      const vtE = vt * (1 - 0.45 * bl);
      const vr = -bl * vmax * 0.45 * Math.min(1, r / rc) + (1 - bl) * (r < rc * 1.6 ? vmax * 0.06 : 0);
      // Updraft concentrated at the core wall, decaying with height.
      const wall = Math.exp(-((r / rc - 1) ** 2) / 0.6);
      const w = vmax * 0.35 * wall * Math.exp(-hAbove / (rc * 8));
      // Target air velocity (with the devil's drift).
      const ax = (rx / r) * vr - (rz / r) * vtE + d.vx;
      const az = (rz / r) * vr + (rx / r) * vtE + d.vz;
      // Particle response: sand relaxes fast but is heavy; dust follows the air.
      const tau = this.kind[i] > 0.5 ? 0.25 : 0.08;
      const kk = Math.min(1, dt / tau);
      this.vel[k] += (ax - this.vel[k]) * kk;
      this.vel[k + 2] += (az - this.vel[k + 2]) * kk;
      // Settling speed grows with size (Stokes): fine silt hangs, coarse sand falls.
      const settle = this.kind[i] > 0.5 ? 0.02 + this.base[i] * 0.6 : 1.6;
      this.vel[k + 1] += ((w - settle) - this.vel[k + 1]) * kk * 0.6 - (this.kind[i] > 0.5 ? 0 : g * 0.25 * dt);
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < gy + 0.02) {
        this.pos[k + 1] = gy + 0.02;
        if (this.vel[k + 1] < 0) this.vel[k + 1] *= -0.3;
      }
      const age = 1 - this.life[i] / 8;
      const fine = this.kind[i] > 0.5;
      const bs = this.base[i];
      // Big haze puffs spread and fade; small specks stay sharp and denser.
      this.aSize[n] = bs * (1 + age * (fine ? 1.5 : 0.2) + (fine ? hAbove * 0.02 : 0));
      this.aAlpha[n] = (fine ? 0.06 + 0.35 * Math.exp(-bs * 12) : 0.6) * Math.min(1, this.life[i]) * d.s;
      this.pos[n * 3] = this.pos[k];
      this.pos[n * 3 + 1] = this.pos[k + 1];
      this.pos[n * 3 + 2] = this.pos[k + 2];
      // Keep particle state aligned with the compacted draw order.
      if (n !== i) {
        this.vel.copyWithin(n * 3, k, k + 3);
        this.life[n] = this.life[i];
        this.kind[n] = this.kind[i];
        this.base[n] = this.base[i];
        this.owner[n] = this.owner[i];
        this.life[i] = 0;
      }
      n++;
    }
    this.cursor = n % N;
    this.geo.setDrawRange(0, n);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Lay a track segment every ~1.5 m of the devil's path. */
  private trackStep(di: number, d: DevilIn, dt: number): void {
    const last = this.lastTrack.get(di);
    if (!last || Math.hypot(d.x - last.x, d.z - last.z) > 30) {
      this.lastTrack.set(di, { x: d.x, z: d.z, age: 0, along: Math.random() * 100, recent: [], s: d.s, count: 0 });
      return;
    }
    last.age += dt;
    const dx = d.x - last.x, dz = d.z - last.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.5 || d.s < 0.3) return;
    // Wider than the core: the inflow layer scours a band ~2-3 core radii across.
    const w = Math.min(d.r * 1.6, 25);
    const sx = (-dz / len) * w, sz = (dx / len) * w;
    const q = this.tHead;
    this.tHead = (this.tHead + 1) % TRACK_N;
    const t = this.terrain;
    // A row of points across the band, from one edge (+side) to the other.
    const row = (x: number, z: number) => {
      const r: number[] = [];
      for (let k = 0; k <= TRACK_K; k++) {
        const f = 1 - (2 * k) / TRACK_K;
        r.push(x + sx * f, z + sz * f);
      }
      return r;
    };
    // Start where the previous segment ended (same row of points): no gaps, no overlaps.
    const start = last.edge ?? row(last.x, last.z);
    const end = row(d.x, d.z);
    last.edge = end;
    // Consecutive segments share their rows and a continuous "along" coordinate,
    // so the band has no seams.
    const a0 = last.along, a1 = last.along + len;
    const uvA = this.trackGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < TRACK_V; k++) {
      const src = k <= TRACK_K ? start : end, c = k % (TRACK_K + 1);
      const x = src[c * 2], z = src[c * 2 + 1], vi = q * TRACK_V + k;
      this.tPos.set([x, t.height(x, z) + 0.06, z], vi * 3);
      this.tBirth[vi] = this.time;
      uvA.setXY(vi, c / TRACK_K, k <= TRACK_K ? a0 : a1);
    }
    // The scour builds up over the last ~12 m behind the devil (and from where its track
    // begins), so neither end of the band is a straight cut across it; the shader's
    // patchy noise makes that ramp ragged.
    last.s = d.s;
    last.count++;
    last.recent.push(q);
    if (last.recent.length > RAMP + 1) last.recent.shift();
    const n = last.recent.length;
    for (let m = 0; m < n; m++) {
      const seg = last.recent[m], fromEnd = n - 1 - m; // 0 = newest
      for (let k = 0; k < TRACK_V; k++) {
        const endRow = k > TRACK_K;
        // Head ramp (from the devil back) times tail ramp (from where the track began).
        const fromStart = last.count - 1 - fromEnd + (endRow ? 1 : 0);
        const st = Math.min(1, (fromEnd + (endRow ? 0 : 1)) / RAMP, fromStart / RAMP);
        this.tAlpha[seg * TRACK_V + k] = last.s * st * st * (3 - 2 * st);
      }
    }
    // Upload only the segments that changed (the buffers are large).
    const seg = (attr: THREE.BufferAttribute, q0: number) => attr.addUpdateRange(q0 * TRACK_V * attr.itemSize, TRACK_V * attr.itemSize);
    const posA = this.trackGeo.getAttribute('position') as THREE.BufferAttribute;
    const birthA = this.trackGeo.getAttribute('aB') as THREE.BufferAttribute;
    const alphaA = this.trackGeo.getAttribute('aA') as THREE.BufferAttribute;
    seg(posA, q);
    seg(uvA, q);
    seg(birthA, q);
    for (const r of last.recent) seg(alphaA, r);
    posA.needsUpdate = uvA.needsUpdate = birthA.needsUpdate = alphaA.needsUpdate = true;
    last.along = a1;
    last.x = d.x;
    last.z = d.z;
  }
}
