import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
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
/** Gravel layer (5–30 cm) in the 3 × 3 cells around the rover, per m² (Moon / Mars). */
const GRAVEL = { moon: 0.12, mars: 0.4 };

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
function rockGeometry(seed: number, detail: number, tint: RockTint, blocky = false): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const n = noise3(seed);
  // 0 = weathered and rounded, 1 = fresh and blocky. Lunar blocks ("blocky"): many
  // fracture planes like an impact fragment, but every edge softened - micrometeorite
  // bombardment rounds lunar rocks over millions of years (cf. the station 6 boulder).
  const angular = blocky ? 0.75 + 0.25 * rnd() : rnd();
  const nCuts = blocky ? 5 + Math.floor(rnd() * 4) : 2 + Math.floor(rnd() * 3);
  const cuts = Array.from({ length: nCuts }, () => ({
    d: new THREE.Vector3(rnd() - 0.5, rnd() - 0.6, rnd() - 0.5).normalize(),
    c: blocky ? 0.55 + rnd() * 0.25 : 0.62 + rnd() * 0.25,
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

/**
 * Angular rock: a fresh fragment from weathering and rockfall - the convex hull of
 * points on an irregular, elongated body, so it has flat fracture faces and sharp
 * edges (flat shading), plus a few spalled-off corners.
 */
function angularGeometry(seed: number, tint: RockTint): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const n = noise3(seed);
  const pts: THREE.Vector3[] = [];
  const el = new THREE.Vector3(0.8 + rnd() * 0.5, 0.45 + rnd() * 0.45, 0.7 + rnd() * 0.5);
  const count = 16 + Math.floor(rnd() * 14);
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    v.multiplyScalar(0.75 + 0.35 * rnd()).multiply(el);
    if (v.y < -0.25) v.y = -0.25 - (v.y + 0.25) * 0.3; // flatter base, resting on the soil
    pts.push(v);
  }
  let g: THREE.BufferGeometry = new ConvexGeometry(pts);
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  g.computeVertexNormals(); // non-indexed: one normal per face -> crisp facets
  return colorize(g, n, tint);
}

/**
 * Bedded slabs: a ledge of 3-5 stacked plates with broken, irregular outlines,
 * each slightly offset and tilted - layered lava flows / sediments breaking up
 * along their bedding planes.
 */
function slabGeometry(seed: number, tint: RockTint): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const n = noise3(seed);
  const parts: THREE.BufferGeometry[] = [];
  const layers = 2 + Math.floor(rnd() * 3);
  let y = -0.5;
  for (let l = 0; l < layers; l++) {
    // Plates as thick as a third of their width: blocky ledges, not sheets.
    const th = 0.26 + rnd() * 0.18;
    const shrink = 1 - l * (0.15 + rnd() * 0.12);
    const ox = (rnd() - 0.5) * 0.35, oz = (rnd() - 0.5) * 0.3;
    const pts: THREE.Vector3[] = [];
    // Broken outline: many points with jagged radius (spalled edges, re-entrant bites
    // smoothed by the hull into irregular facets), thickness varying around the rim.
    const sides = 14 + Math.floor(rnd() * 8);
    const bite = rnd() * Math.PI * 2;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
      let r = shrink * (0.55 + 0.45 * rnd());
      // One side snapped off: a straight-ish fracture face.
      if (Math.cos(a - bite) > 0.6) r *= 0.7 + 0.1 * rnd();
      const x = Math.cos(a) * r * 1.1 + ox, z = Math.sin(a) * r * (0.6 + 0.3 * rnd()) + oz;
      const tk = th * (0.55 + 0.5 * rnd());
      pts.push(new THREE.Vector3(x, y + th * 0.15 * rnd(), z), new THREE.Vector3(x * (0.85 + 0.12 * rnd()), y + tk, z * (0.85 + 0.12 * rnd())));
    }
    let g: THREE.BufferGeometry = new ConvexGeometry(pts);
    g.rotateZ((rnd() - 0.5) * 0.3);
    g.rotateX((rnd() - 0.5) * 0.25);
    g = g.index ? g.toNonIndexed() : g;
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    parts.push(g);
    y += th * (0.8 + 0.1 * rnd());
  }
  const g = mergeGeometries(parts)!;
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
      c.lerp(tint.dust, THREE.MathUtils.clamp(up * 0.7, 0, 0.4));
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
  private mars: boolean;
  private gravelMeshes: THREE.InstancedMesh[] = [];

  constructor(private terrain: TerrainData, private physics: Physics, quality: QualitySettings, photo?: THREE.Texture) {
    this.q = quality;
    this.abundance = terrain.meta.body === 'mars' ? 5 : 1;
    this.mars = terrain.meta.body === 'mars';
    // Moon: grey basalt/breccia; Mars: dark grey-brown basalt under a coat of ferric dust.
    const mars = terrain.meta.body === 'mars';
    const tint: RockTint = mars
      ? { base: new THREE.Color(0.085, 0.078, 0.072), dust: new THREE.Color(0.3, 0.2, 0.13) }
      : { base: new THREE.Color(0.18, 0.175, 0.168), dust: null }; // basalt / breccia, albedo ~0.1-0.15
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }), 'rock', (shader) => {
      shader.defines = { ...(shader.defines ?? {}), ROCK_MARS: mars ? 1 : 0, ROCK_PHOTO: photo ? 1 : 0 };
      if (photo) shader.uniforms.uRockPhoto = { value: photo };
      // Rock surface detail in the rock's own frame (it stays on the rock): chips and
      // vesicles as a bump map, mineral grains, darker pits, and (Moon) a fine dust
      // coat on the upper faces; (Mars) the ochre dust is handled by the vertex colour.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRockP;\nvarying vec3 vRockN;\nvarying float vRockSeed;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
float rScale = 1.0;
#ifdef USE_INSTANCING
rScale = length(instanceMatrix[0].xyz);
vRockN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
// Which photo tile and where in it: from the rock's own position (stable per rock).
vec3 iT = instanceMatrix[3].xyz;
vRockSeed = fract(sin(dot(iT.xz, vec2(12.9898, 78.233))) * 43758.5453);
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
varying float vRockSeed;
#if ROCK_PHOTO > 0
uniform sampler2D uRockPhoto;
// Real rover photographs of Martian rock (2 × 2 atlas), projected triplanarly at
// ~0.6 m per tile, mirrored so it never shows a seam; each rock its own tile and offset.
vec3 photoTap(vec2 p, vec2 tile) {
  vec2 q = abs(fract(p * 0.5) * 2.0 - 1.0); // mirror-repeat
  q = mix(vec2(0.01), vec2(0.99), q);
  return texture2D(uRockPhoto, (tile + q) * 0.5).rgb;
}
vec3 rockPhoto(vec3 p, vec3 w) {
  float s = vRockSeed;
  vec2 tile = vec2(floor(s * 2.0), floor(fract(s * 7.13) * 2.0));
  vec3 o = vec3(s * 17.0, s * 5.0, s * 11.0);
  p = p / 0.6 + o;
  return photoTap(p.yz, tile) * w.x + photoTap(p.xz, tile) * w.y + photoTap(p.xy, tile) * w.z;
}
#endif
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
#if ROCK_PHOTO > 0
  // Relief from the photograph's brightness: fractures, flakes and grains of real rock.
  H = dot(rockPhoto(vRockP, w), vec3(0.33)) * 0.006 + H * 0.4;
#endif
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
  float g1 = tri(vRockP * 260.0, w);
  float grains = (smoothstep(0.72, 0.85, g1) * 0.35 - smoothstep(0.3, 0.15, g1) * 0.3) * detail;
  // Breccia clasts and mottling at cm scale; dark pits (vesicles).
  float mott = (tri(vRockP * 14.0 + 3.0, w) - 0.5) * 0.35;
  float pit = smoothstep(0.78, 0.92, tri(vRockP * 38.0 + 5.0, w));
#if ROCK_PHOTO > 0
  // Colour, grain, dust patches and fractures from the photographs (their mean is 1).
  diffuseColor.rgb *= rockPhoto(vRockP, w) / 0.5 * (1.0 + 0.3 * mott);
#else
  diffuseColor.rgb *= (1.0 + grains + mott) * (1.0 - 0.55 * pit * detail);
#endif
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
      // Mars: half the variants are rounded (delta cobbles, wind-worn), half angular
      // fresh fragments; the Moon gets angular ones too (impact fragments).
      // Moon: impact fragments - all blocky, with edges rounded by micrometeorites.
      const angular = this.mars ? v >= VARIANTS / 2 : true;
      const geo = angular
        ? this.mars ? angularGeometry(100 + v * 7, tint) : rockGeometry(100 + v * 7, 3, tint, true)
        : rockGeometry(100 + v * 7, 2, tint);
      const m = new THREE.InstancedMesh(geo, mat, this.capacity());
      this.prep(m);
      this.meshes.push(m);
      // Gravel: the same shapes at a quarter of the triangles (they are a few cm on screen).
      const gm = new THREE.InstancedMesh(angular ? geo : rockGeometry(100 + v * 7, 1, tint), mat, Math.ceil((9 * CELL * CELL * GRAVEL.mars * 1.2) / VARIANTS) + 32);
      this.prep(gm);
      gm.castShadow = false;
      this.gravelMeshes.push(gm);
    }
    for (let v = 0; v < BOULDER_VARIANTS; v++) {
      // Two rounded and two angular boulder shapes.
      const ang = this.mars ? v >= BOULDER_VARIANTS / 2 : true;
      const near = ang ? (this.mars ? angularGeometry(311 + v * 13, tint) : rockGeometry(311 + v * 13, 5, tint, true)) : rockGeometry(311 + v * 13, 4, tint);
      this.boulderNear.push(new THREE.InstancedMesh(near, mat, 600));
      const far = new THREE.InstancedMesh(ang ? (this.mars ? angularGeometry(311 + v * 13, tint) : rockGeometry(311 + v * 13, 2, tint, true)) : rockGeometry(311 + v * 13, 2, tint), mat, 2000);
      // Far boulders are not drawn into the real-time shadow map (instanced meshes are not culled).
      this.boulderFar.push(far);
    }
    // Outcrops: bedded slabs (stacked plates breaking along bedding planes).
    this.outcropMesh = new THREE.InstancedMesh(slabGeometry(5, tint), mat, 800);
    for (const m of [...this.boulderNear, ...this.boulderFar, this.outcropMesh]) this.prep(m);
    for (const m of this.boulderFar) m.castShadow = false;
    this.placeBoulders();
  }

  private capacity(): number {
    // + the gravel layer of the 3 × 3 cells around the rover.
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
        // Mars: the bedrock pavement (material map) is strewn with blocks and low ledges
        // of the Máaz lava flows; the sand between them has few.
        const mat = t.materialAt(x, z);
        const p = 0.004 + 0.12 * THREE.MathUtils.smoothstep(slopeDeg, 10, 30) + 0.05 * mat;
        if (h > p) continue;
        const rnd = mulberry32(Math.floor(hash2(i, j, 4242) * 4294967296));
        const px = x + (rnd() - 0.5) * BOULDER_GRID, pz = z + (rnd() - 0.5) * BOULDER_GRID;
        const outcrop = (slopeDeg > 24 && rnd() < 0.35) || (mat > 0.7 && rnd() < 0.45);
        // (Outcrop albedo: weathered, dust-coated rock, close to the soil around it.)
        let r: number, sx: number, sy: number, sz: number;
        const q = new THREE.Quaternion();
        if (outcrop) {
          // Slab along the contour, dipping with the slope.
          r = slopeDeg > 24 ? 2 + rnd() * 4 : 1.2 + rnd() * 2.5;
          // On the flat pavement: low, wide ledges (layered flows), 20-60 cm proud.
          sx = r * (1.0 + 0.6 * rnd()); sy = slopeDeg > 24 ? r * (0.45 + rnd() * 0.3) : 0.5 + rnd() * 0.6; sz = r * (0.7 + rnd() * 0.4);
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
        this.boulders.push({ x: px, y, z: pz, r, sx, sy, sz, q, v: Math.floor(rnd() * BOULDER_VARIANTS), albedo: outcrop ? (this.mars ? 0.75 : 0.5) + rnd() * 0.2 : 0.85 + rnd() * 0.4, outcrop });
        const key = `${Math.floor(px / BOULDER_CELL)},${Math.floor(pz / BOULDER_CELL)}`;
        if (!this.boulderGrid.has(key)) this.boulderGrid.set(key, []);
        this.boulderGrid.get(key)!.push(idx);
      }
    }
  }

  /**
   * Dense gravel near the rover: on the Jezero floor (Máaz) a few angular 5–40 cm
   * rocks per square metre are seen in every Navcam frame; drawing them everywhere
   * would be too costly, so this layer exists only in the cells around the rover
   * (the terrain shader's pebbles carry on beyond).
   */
  private cellGravel(cx: number, cz: number): Rock[] {
    const t = this.terrain;
    const rnd = mulberry32(Math.floor(hash2(cx, cz, 191) * 4294967296));
    const x0 = cx * CELL, z0 = cz * CELL;
    const n = Math.floor(CELL * CELL * (this.mars ? GRAVEL.mars : GRAVEL.moon) * this.q.rockDensity);
    const out: Rock[] = [];
    for (let i = 0; i < n; i++) {
      const x = x0 + rnd() * CELL, z = z0 + rnd() * CELL;
      const r = Math.min(0.3, 0.045 * Math.pow(1 - rnd() * 0.999, -1 / 1.9));
      const sx = r * (0.8 + rnd() * 0.6), sy = r * (0.4 + rnd() * 0.4), sz = r * (0.8 + rnd() * 0.6);
      const y = t.height(x, z) - sy * 0.35;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.8, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.8));
      out.push({ x, y, z, r, sx, sy, sz, q, v: Math.floor(rnd() * VARIANTS), albedo: 0.7 + rnd() * 0.7 });
    }
    return out;
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
    const gCounts = new Array(VARIANTS).fill(0);
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
      const near1 = Math.abs(ix - cx) <= 1 && Math.abs(iz - cz) <= 1;
      const rocks = this.cellRocks(ix, iz);
      if (near1) {
        for (const r of this.cellGravel(ix, iz)) {
          const gm = this.gravelMeshes[r.v];
          const c = gCounts[r.v];
          if (c >= gm.instanceMatrix.count) continue;
          m4.compose(p.set(r.x, r.y, r.z), r.q, s.set(r.sx, r.sy, r.sz));
          gm.setMatrixAt(c, m4);
          gm.setColorAt(c, col.setScalar(r.albedo));
          gCounts[r.v] = c + 1;
        }
      }
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
          this.colliders.set(k, rocks.filter((r) => r.r >= min && r.r >= min).map((r) => this.makeCollider(r)));
        }
      }
    }
    for (let v = 0; v < VARIANTS; v++) {
      const gm = this.gravelMeshes[v];
      gm.count = gCounts[v];
      gm.instanceMatrix.needsUpdate = true;
      if (gm.instanceColor) gm.instanceColor.needsUpdate = true;
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
    // Fitted to the visible shape (was 0.68: wheels sank into rocks without touching them).
    const k = r.outcrop ? 0.48 : 0.82;
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
