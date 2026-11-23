import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { QualitySettings } from '../config';
import type { Physics } from '../physics/Physics';
import { makeLunar, NOISE_GLSL } from '../render/lunar';
import { hash2, mulberry32, type TerrainData } from './TerrainData';

const CELL = 32;
const VARIANTS = 6;
/** Rocks bigger than this get colliders within COLLIDER_RADIUS. */
const COLLIDER_BIG = 0.25;
const COLLIDER_RADIUS = 70;
/** Cobbles 10–25 cm get colliders only in the rover's own and adjacent cells. */
const COLLIDER_SMALL = 0.1;
const BOULDER_GRID = 8;
const BOULDER_CELL = 64;
const BOULDER_VARIANTS = 4;

interface Rock {
  x: number; y: number; z: number;
  r: number; sx: number; sy: number; sz: number;
  q: THREE.Quaternion;
  v: number;
  albedo: number;
  outcrop?: boolean;
}

/** Seeded 3D value noise + fbm (for rock shapes). */
function noise3(seed: number): (x: number, y: number, z: number) => number {
  const h = (i: number, j: number, k: number) => hash2(i * 73856093 + k * 19349663, j * 83492791 + seed, seed);
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const fx = sm(x - i), fy = sm(y - j), fz = sm(z - k);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(h(i, j, k), h(i + 1, j, k), fx), l(h(i, j + 1, k), h(i + 1, j + 1, k), fx), fy),
      l(l(h(i, j, k + 1), h(i + 1, j, k + 1), fx), l(h(i, j + 1, k + 1), h(i + 1, j + 1, k + 1), fx), fy),
      fz,
    ) * 2 - 1;
  };
}

function fbm(n: (x: number, y: number, z: number) => number, v: THREE.Vector3, f: number, oct: number): number {
  let s = 0, a = 0.5;
  for (let o = 0; o < oct; o++) {
    s += a * n(v.x * f + o * 7.1, v.y * f + o * 3.3, v.z * f + o * 5.7);
    f *= 2.1;
    a *= 0.5;
  }
  return s;
}

export type RockTint = { base: THREE.Color; dust: THREE.Color | null };

/**
 * Rock shape: an irregular, lumpy body (multi-octave noise on an ellipsoid)
 * with a few softly bevelled fracture faces — subangular to subrounded, as
 * real blocks are after impact fragmentation and erosion. Smooth normals; the
 * vertex colour carries mineral mottling and (on Mars) dust settled on top.
 */
function rockGeometry(seed: number, detail: number, tint: RockTint): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const n = noise3(seed);
  const angular = rnd(); // 0 = weathered and rounded, 1 = fresh and blocky
  const nCuts = 2 + Math.floor(rnd() * 3);
  const cuts = Array.from({ length: nCuts }, () => ({
    d: new THREE.Vector3(rnd() - 0.5, rnd() - 0.6, rnd() - 0.5).normalize(),
    c: 0.62 + rnd() * 0.25,
  }));
  const elong = new THREE.Vector3(0.85 + rnd() * 0.45, 0.6 + rnd() * 0.35, 0.8 + rnd() * 0.4);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let s = 1 + 0.3 * fbm(n, v, 1.1, 2) + 0.07 * fbm(n, v, 4.3, 2) + 0.025 * fbm(n, v, 11, 2);
    // Fracture faces: pull the surface onto the plane with a rounded edge (no hard box corners).
    for (const cut of cuts) {
      const d = v.dot(cut.d) * s;
      if (d > cut.c - 0.15) {
        const t = THREE.MathUtils.smoothstep(d, cut.c - 0.15, cut.c + 0.2) * (0.35 + 0.5 * angular);
        s *= 1 - t * (1 - cut.c / Math.max(d, cut.c));
      }
    }
    // Flatter underside: the rock rests on the regolith.
    if (v.y < -0.3) s *= 1 - (-v.y - 0.3) * 0.35;
    v.multiplyScalar(s).multiply(elong);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return colorize(g, n, tint);
}

/** Layered sedimentary/lava-flow outcrop: a ledge of strata with recessed bedding planes. */
function outcropGeometry(seed: number, tint: RockTint): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 4);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const n = noise3(seed);
  const layers = 4 + Math.floor(rnd() * 4);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    // Irregular outline in plan view, flat-ish top, steeper front.
    const s = 1 + 0.35 * fbm(n, v, 0.9, 3);
    v.multiplyScalar(s);
    v.y *= 0.5;
    // Bedding: each layer recessed by a different amount, with a soft step.
    const ly = (v.y + 0.6) * layers;
    const li = Math.floor(ly), lf = ly - li;
    const recess = 0.08 * (0.5 + 0.5 * Math.sin(li * 12.9898 + seed)) * (1 - THREE.MathUtils.smoothstep(lf, 0.0, 0.25));
    v.x *= 1 - recess;
    v.z *= 1 - recess;
    v.y += (Math.round(ly) - ly) * 0.06 / layers;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return colorize(g, n, tint);
}

/** Vertex colours: mottled albedo; on Mars a coat of bright dust on upward faces. */
function colorize(g: THREE.BufferGeometry, n: (x: number, y: number, z: number) => number, tint: RockTint): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const nr = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const m = 0.85 + 0.2 * fbm(n, v, 6, 2) + 0.08 * n(v.x * 23, v.y * 23, v.z * 23);
    c.copy(tint.base).multiplyScalar(m);
    if (tint.dust) {
      // Dust settles only on the flatter upper faces, patchily; sides stay dark basalt.
      const up = THREE.MathUtils.smoothstep(nr.getY(i), 0.55, 0.95) * (0.35 + 0.55 * (fbm(n, v, 3, 2) * 0.5 + 0.5));
      c.lerp(tint.dust, THREE.MathUtils.clamp(up, 0, 0.6));
    }
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Rocks: cobbles streamed around the rover (deterministic per 32 m cell) plus
 * metre-scale boulders and bedrock outcrops over the DTM window, placed by slope:
 * thin regolith on steep rille walls and crater rims exposes and sheds rock.
 */
export class Rocks {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private boulderNear: THREE.InstancedMesh[] = [];
  private boulderFar: THREE.InstancedMesh[] = [];
  private outcropMesh: THREE.InstancedMesh;
  private boulders: Rock[] = [];
  private boulderGrid = new Map<string, number[]>();
  private cellKey = '';
  private boulderKey = '';
  private colliders = new Map<string, RAPIER.Collider[]>();
  private boulderColliders = new Map<number, RAPIER.Collider>();
  private rockSize = new Map<number, number>();
  private q: QualitySettings;
  private tmpN = [0, 0, 0];
  private abundance: number;

  constructor(private terrain: TerrainData, private physics: Physics, quality: QualitySettings) {
    this.q = quality;
    this.abundance = terrain.meta.body === 'mars' ? 5 : 1;
    // Moon: grey basalt/breccia; Mars: dark grey-brown basalt under a coat of ferric dust.
    const mars = terrain.meta.body === 'mars';
    const tint: RockTint = mars
      ? { base: new THREE.Color(0.075, 0.064, 0.058), dust: new THREE.Color(0.3, 0.17, 0.1) }
      : { base: new THREE.Color(0.27, 0.26, 0.245), dust: null };
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }), 'rock', (shader) => {
      shader.defines = { ...(shader.defines ?? {}), ROCK_MARS: mars ? 1 : 0 };
      // Rock surface detail in the rock's own frame (it stays on the rock): chips and
      // vesicles as a bump map, mineral grains, darker pits, and (Moon) a fine dust
      // coat on the upper faces; (Mars) the ochre dust is handled by the vertex colour.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRockP;\nvarying vec3 vRockN;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
float rScale = 1.0;
#ifdef USE_INSTANCING
rScale = length(instanceMatrix[0].xyz);
vRockN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
#else
vRockN = normalize(mat3(modelMatrix) * objectNormal);
#endif
vRockP = position * rScale;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vRockP;
varying vec3 vRockN;
${NOISE_GLSL}
// Triplanar value noise in rock-local metres.
float tri(vec3 p, vec3 w) {
  return lnoised(p.yz).x * w.x + lnoised(p.xz + 13.1).x * w.y + lnoised(p.xy + 27.7).x * w.z;
}
float rockH(vec3 p, vec3 w) {
  float h = tri(p * 9.0, w) * 0.5 + tri(p * 23.0, w) * 0.3 + tri(p * 61.0, w) * 0.15;
  // Vesicles / pits: sharp small dents.
  float pit = smoothstep(0.78, 0.92, tri(p * 38.0 + 5.0, w));
  return h - pit * 0.6;
}`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{
  vec3 wN = abs(normalize(vRockN));
  vec3 w = wN / (wN.x + wN.y + wN.z);
  float fw = length(fwidth(vRockP));
  float detail = 1.0 - smoothstep(0.01, 0.05, fw);
  float H = rockH(vRockP, w) * 0.004 * detail;
  // Bump from screen-space derivatives (Mikkelsen).
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec2 dH = vec2(dFdx(H), dFdy(H));
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  normal = normalize(abs(det) * normal - grad);
}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  vec3 wN = abs(normalize(vRockN));
  vec3 w = wN / (wN.x + wN.y + wN.z);
  float fw = length(fwidth(vRockP));
  float detail = 1.0 - smoothstep(0.01, 0.05, fw);
  // Mineral grains: bright plagioclase laths, dark pyroxene/ilmenite, 1–4 mm.
  float g1 = lhash12(floor(vRockP.xz * 260.0 + vRockP.y * 31.0));
  float grains = (g1 > 0.86 ? 0.35 : g1 < 0.12 ? -0.3 : 0.0) * detail;
  // Breccia clasts and mottling at cm scale; dark pits (vesicles).
  float mott = (tri(vRockP * 14.0 + 3.0, w) - 0.5) * 0.35;
  float pit = smoothstep(0.78, 0.92, tri(vRockP * 38.0 + 5.0, w));
  diffuseColor.rgb *= (1.0 + grains + mott) * (1.0 - 0.55 * pit * detail);
#if ROCK_MARS == 0
  // Lunar rocks carry a thin coat of fine soil on their upper faces (zap pits, dust).
  float up = smoothstep(0.35, 0.9, normalize(vRockN).y) * (0.5 + 0.5 * tri(vRockP * 4.0, w));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.196, 0.19), up * 0.5);
#endif
}`,
        );
    });
    for (let v = 0; v < VARIANTS; v++) {
      // Cobbles are small on screen: low-poly but smooth, lumpy shapes.
      const m = new THREE.InstancedMesh(rockGeometry(100 + v * 7, 2, tint), mat, this.capacity());
      this.prep(m);
      this.meshes.push(m);
    }
    for (let v = 0; v < BOULDER_VARIANTS; v++) {
      this.boulderNear.push(new THREE.InstancedMesh(rockGeometry(311 + v * 13, 4, tint), mat, 600));
      const far = new THREE.InstancedMesh(rockGeometry(311 + v * 13, 2, tint), mat, 2000);
      // Far boulders are not drawn into the real-time shadow map (instanced meshes are not culled).
      this.boulderFar.push(far);
    }
    this.outcropMesh = new THREE.InstancedMesh(outcropGeometry(5, tint), mat, 800);
    for (const m of [...this.boulderNear, ...this.boulderFar, this.outcropMesh]) this.prep(m);
    for (const m of this.boulderFar) m.castShadow = false;
    this.placeBoulders();
  }

  private capacity(): number {
    return Math.ceil(this.q.maxRocks / VARIANTS) + 64;
  }

  private prep(m: THREE.InstancedMesh): void {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.count = 0;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3).fill(1), 3);
    this.group.add(m);
  }

  setQuality(q: QualitySettings): void {
    this.q = q;
    for (let v = 0; v < VARIANTS; v++) {
      const old = this.meshes[v];
      const m = new THREE.InstancedMesh(old.geometry, old.material, this.capacity());
      this.group.remove(old);
      old.dispose();
      this.prep(m);
      this.meshes[v] = m;
    }
    this.cellKey = '';
    this.boulderKey = '';
  }

  private placeBoulders(): void {
    const t = this.terrain;
    const n = Math.floor(t.meta.sizeX / BOULDER_GRID);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -t.halfX + (i + 0.5) * BOULDER_GRID, z = -t.halfZ + (j + 0.5) * BOULDER_GRID;
        const h = hash2(i, j, 991);
        t.normal(x, z, this.tmpN, 3);
        const slopeDeg = (Math.acos(Math.min(1, this.tmpN[1])) * 180) / Math.PI;
        // Probability per 64 m² cell: sparse on the plains, dense on steep slopes.
        const p = 0.004 + 0.12 * THREE.MathUtils.smoothstep(slopeDeg, 10, 30);
        if (h > p) continue;
        const rnd = mulberry32(Math.floor(hash2(i, j, 4242) * 4294967296));
        const px = x + (rnd() - 0.5) * BOULDER_GRID, pz = z + (rnd() - 0.5) * BOULDER_GRID;
        const outcrop = slopeDeg > 24 && rnd() < 0.35;
        let r: number, sx: number, sy: number, sz: number;
        const q = new THREE.Quaternion();
        if (outcrop) {
          // Slab along the contour, dipping with the slope.
          r = 2 + rnd() * 4;
          sx = r * (1.2 + rnd()); sy = r * (0.35 + rnd() * 0.3); sz = r * (0.6 + rnd() * 0.4);
          const yaw = Math.atan2(this.tmpN[0], this.tmpN[2]) + Math.PI / 2;
          const up = new THREE.Vector3(this.tmpN[0], this.tmpN[1], this.tmpN[2]);
          q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
        } else {
          r = 0.6 * Math.pow(1 - rnd() * 0.97, -1 / 2.2);
          if (r > 6) r = 6;
          sx = r * (0.8 + rnd() * 0.4); sy = r * (0.55 + rnd() * 0.4); sz = r * (0.8 + rnd() * 0.4);
          q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.8, rnd() * 6.28, (rnd() - 0.5) * 0.8));
        }
        // Partially buried; large blocks sink deeper into the regolith.
        const y = t.height(px, pz) - sy * (outcrop ? 0.45 : 0.3);
        const idx = this.boulders.length;
        this.boulders.push({ x: px, y, z: pz, r, sx, sy, sz, q, v: Math.floor(rnd() * BOULDER_VARIANTS), albedo: 0.85 + rnd() * 0.4, outcrop });
        const key = `${Math.floor(px / BOULDER_CELL)},${Math.floor(pz / BOULDER_CELL)}`;
        if (!this.boulderGrid.has(key)) this.boulderGrid.set(key, []);
        this.boulderGrid.get(key)!.push(idx);
      }
    }
  }

  private cellRocks(cx: number, cz: number): Rock[] {
    const t = this.terrain;
    const rnd = mulberry32(Math.floor(hash2(cx, cz, 77) * 4294967296));
    const x0 = cx * CELL, z0 = cz * CELL;
    t.normal(x0 + CELL / 2, z0 + CELL / 2, this.tmpN, 6);
    const slope = 1 - this.tmpN[1];
    const density = this.q.rockDensity * this.abundance * (22 + slope * 400);
    const n = Math.floor(density * (0.5 + rnd()));
    const out: Rock[] = [];
    for (let i = 0; i < n; i++) {
      const x = x0 + rnd() * CELL, z = z0 + rnd() * CELL;
      // Cumulative N(>D) ~ D^-2.1: lots of cobbles, rare large rocks.
      let r = 0.05 * Math.pow(1 - rnd() * 0.9999, -1 / 2.1);
      if (r > 1.5) r = 1.5;
      const sx = r * (0.8 + rnd() * 0.5), sy = r * (0.45 + rnd() * 0.45), sz = r * (0.8 + rnd() * 0.5);
      const y = t.height(x, z) - sy * 0.3;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6));
      // Fresh rock is brighter than space-weathered regolith; albedo varies by lithology.
      out.push({ x, y, z, r, sx, sy, sz, q, v: Math.floor(rnd() * VARIANTS), albedo: 0.75 + rnd() * 0.6 });
    }
    return out;
  }

  update(pos: THREE.Vector3): void {
    this.updateBoulders(pos);
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const key = `${cx},${cz}`;
    if (key === this.cellKey) return;
    this.cellKey = key;

    const rad = Math.ceil(this.q.rockRadius / CELL);
    const counts = new Array(VARIANTS).fill(0);
    const cap = this.meshes[0].instanceMatrix.count;
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const keep = new Set<string>();
    const cRad = Math.ceil(COLLIDER_RADIUS / CELL);
    const cells: [number, number, number][] = [];
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= rad * rad) cells.push([cx + dx, cz + dz, d2]);
      }
    cells.sort((a, b) => a[2] - b[2]);
    for (const [ix, iz, d2] of cells) {
      const rocks = this.cellRocks(ix, iz);
      const far = Math.sqrt(d2) * CELL;
      for (const r of rocks) {
        if (r.r < far * 0.0012) continue;
        const c = counts[r.v];
        if (c >= cap) continue;
        m4.compose(p.set(r.x, r.y, r.z), r.q, s.set(r.sx, r.sy, r.sz));
        this.meshes[r.v].setMatrixAt(c, m4);
        this.meshes[r.v].setColorAt(c, col.setScalar(r.albedo));
        counts[r.v] = c + 1;
      }
      const adj = Math.abs(ix - cx) <= 1 && Math.abs(iz - cz) <= 1;
      if (Math.abs(ix - cx) <= cRad && Math.abs(iz - cz) <= cRad) {
        // Key includes whether small cobbles are simulated, so cells are rebuilt when that changes.
        const k = `${ix},${iz},${adj ? 1 : 0}`;
        keep.add(k);
        if (!this.colliders.has(k)) {
          const min = adj ? COLLIDER_SMALL : COLLIDER_BIG;
          this.colliders.set(k, rocks.filter((r) => r.r >= min).map((r) => this.makeCollider(r)));
        }
      }
    }
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = counts[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.meshes[v].instanceColor!.needsUpdate = true;
    }
    for (const [k, list] of this.colliders) {
      if (!keep.has(k)) {
        for (const c of list) this.removeCollider(c);
        this.colliders.delete(k);
      }
    }
  }

  private updateBoulders(pos: THREE.Vector3): void {
    const bx = Math.floor(pos.x / BOULDER_CELL), bz = Math.floor(pos.z / BOULDER_CELL);
    const key = `${bx},${bz}`;
    if (key === this.boulderKey) return;
    this.boulderKey = key;
    const range = Math.min(this.q.drawDistance, 2500);
    const rad = Math.ceil(range / BOULDER_CELL);
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const nNear = new Array(BOULDER_VARIANTS).fill(0), nFar = new Array(BOULDER_VARIANTS).fill(0);
    let nOut = 0;
    const keepCol = new Set<number>();
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        const list = this.boulderGrid.get(`${bx + dx},${bz + dz}`);
        if (!list) continue;
        for (const idx of list) {
          const b = this.boulders[idx];
          const d = Math.hypot(b.x - pos.x, b.z - pos.z);
          if (d > range || b.r < d * 0.0012) continue;
          m4.compose(p.set(b.x, b.y, b.z), b.q, s.set(b.sx, b.sy, b.sz));
          col.setScalar(b.albedo);
          if (b.outcrop) {
            if (nOut < this.outcropMesh.instanceMatrix.count) {
              this.outcropMesh.setMatrixAt(nOut, m4);
              this.outcropMesh.setColorAt(nOut++, col);
            }
          } else if (d < 160 && nNear[b.v] < this.boulderNear[b.v].instanceMatrix.count) {
            this.boulderNear[b.v].setMatrixAt(nNear[b.v], m4);
            this.boulderNear[b.v].setColorAt(nNear[b.v]++, col);
          } else if (nFar[b.v] < this.boulderFar[b.v].instanceMatrix.count) {
            this.boulderFar[b.v].setMatrixAt(nFar[b.v], m4);
            this.boulderFar[b.v].setColorAt(nFar[b.v]++, col);
          }
          if (d < COLLIDER_RADIUS + b.r * 2) {
            keepCol.add(idx);
            if (!this.boulderColliders.has(idx)) this.boulderColliders.set(idx, this.makeCollider(b));
          }
        }
      }
    const all: [THREE.InstancedMesh, number][] = [[this.outcropMesh, nOut]];
    for (let v = 0; v < BOULDER_VARIANTS; v++) all.push([this.boulderNear[v], nNear[v]], [this.boulderFar[v], nFar[v]]);
    for (const [m, n] of all) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
    for (const [idx, c] of this.boulderColliders) {
      if (!keepCol.has(idx)) {
        this.removeCollider(c);
        this.boulderColliders.delete(idx);
      }
    }
  }

  private makeCollider(r: Rock): RAPIER.Collider {
    const R = this.physics.R;
    // Rounded box fitted to the rock's scaled extents; rocks are fixed (embedded in regolith).
    const k = r.outcrop ? 0.42 : 0.68;
    const hx = r.sx * k, hy = r.sy * k, hz = r.sz * k;
    const br = Math.min(hx, hy, hz) * 0.45;
    const d = R.ColliderDesc.roundCuboid(hx - br, hy - br, hz - br, br)
      .setTranslation(r.x, r.y, r.z)
      .setRotation({ x: r.q.x, y: r.q.y, z: r.q.z, w: r.q.w })
      .setFriction(0.75)
      .setRestitution(0.15);
    const c = this.physics.world.createCollider(d);
    this.rockSize.set(c.handle, Math.min(r.r, 3));
    return c;
  }

  private removeCollider(c: RAPIER.Collider): void {
    this.rockSize.delete(c.handle);
    this.physics.world.removeCollider(c, false);
  }

  /** Rock size if the collider is a rock, else 0. */
  sizeOf(c: RAPIER.Collider): number {
    return this.rockSize.get(c.handle) ?? 0;
  }

  count(): number {
    const sum = (l: THREE.InstancedMesh[]) => l.reduce((a, m) => a + m.count, 0);
    return sum(this.meshes) + sum(this.boulderNear) + sum(this.boulderFar) + this.outcropMesh.count;
  }
}
