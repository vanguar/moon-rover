import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type RAPIER from '@dimforge/rapier3d';
import type { QualitySettings } from '../config';
import type { Physics } from '../physics/Physics';
import { makeLunar, NOISE_GLSL } from '../render/lunar';
import { hash2, mulberry32, type TerrainData } from './TerrainData';
import { site as currentSite } from '../world';

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
const OUTCROP_VARIANTS_MARS = 4;
/** Boulder probability per BOULDER_GRID cell: base + steep slopes + rocky pavement (each weight ≤ 1). */
const BOULDER_P0 = 0.004;
const BOULDER_P_SLOPE = 0.12;
const BOULDER_P_PAVE = 0.05;
const BOULDER_P_MAX = BOULDER_P0 + BOULDER_P_SLOPE + BOULDER_P_PAVE;
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
      pts.push(new THREE.Vector3(x, y + th * 0.25 * rnd(), z), new THREE.Vector3(x * (0.85 + 0.12 * rnd()), y + tk, z * (0.85 + 0.12 * rnd())));
    }
    // Inner points: the top and bottom of the plate are not planes (spalls, a hump, a dip).
    for (let k = 0; k < 10; k++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * shrink * 0.7;
      const x = Math.cos(a) * r + ox, z = Math.sin(a) * r * 0.75 + oz;
      pts.push(new THREE.Vector3(x, y + th * (0.95 + 0.35 * rnd()), z), new THREE.Vector3(x, y - th * 0.2 * rnd(), z));
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

/**
 * Mars bedrock plate (Máaz / Séítah outcrops, cf. the Rochette ridge, PIA24840): a low
 * slab barely proud of the sand, its top flat and gently wavy, its rim rounded by wind
 * abrasion, its outline an irregular polygon broken along a few joint planes. A pillow
 * shape (superellipsoid-like: flat faces, rounded edges) with smooth normals - no boxes.
 * Unit size: x, z within about ±1, y within ±0.5.
 */
function plateGeometry(seed: number, tint: RockTint): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 4);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const n = noise3(seed);
  // Joints: straight fracture edges of the outline (direction, distance from the centre).
  const joints = Array.from({ length: 4 + Math.floor(rnd() * 3) }, () => ({ a: rnd() * Math.PI * 2, c: 0.5 + rnd() * 0.35 }));
  const elong = 0.6 + rnd() * 0.35;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const rh = Math.hypot(v.x, v.z), az = Math.atan2(v.z, v.x);
    // Outline radius: wavy, cut back by the joints (soft minimum: rounded corners).
    let R = 1 + 0.16 * n(Math.cos(az) * 1.7 + 3, Math.sin(az) * 1.7, 0.5) + 0.05 * n(Math.cos(az) * 6, Math.sin(az) * 6, 2.5);
    for (const j of joints) {
      const c = Math.cos(az - j.a);
      if (c > 0.05) {
        const lim = j.c / c;
        R = -Math.log(Math.exp(-R * 18) + Math.exp(-lim * 18)) / 18;
      }
    }
    // Pillow profile: flat top and bottom, rim rounded over ~a third of the height.
    const fr = Math.pow(rh, 0.16), fy = Math.sign(v.y) * Math.pow(Math.abs(v.y), 0.3);
    const top = v.y > 0 ? 0.06 * fbm(n, v, 1.4, 2) + 0.02 * fbm(n, v, 7, 2) : 0;
    const x = rh > 1e-6 ? (v.x / rh) * fr * R : 0, z = rh > 1e-6 ? (v.z / rh) * fr * R * elong : 0;
    // Edge thickness varies around the rim (spalled flakes, thinner tongues).
    const rim = 0.75 + 0.25 * n(Math.cos(az) * 3 + 9, Math.sin(az) * 3, 1.5);
    p.setXYZ(i, x, fy * 0.5 * rim * (0.85 + 0.15 * R) + top, z);
  }
  g.computeVertexNormals();
  // Light-toned tops: the plates hold a thicker, brighter dust coat than loose rocks.
  return colorize(g, n, { base: tint.base, dust: tint.dust ? tint.dust.clone().multiplyScalar(1.7) : null }, 0.9);
}

/** Vertex colours: mottled albedo; on Mars a coat of bright dust on upward faces (up to dustMax). */
function colorize(g: THREE.BufferGeometry, n: (x: number, y: number, z: number) => number, tint: RockTint, dustMax = 0.4): THREE.BufferGeometry {
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
      c.lerp(tint.dust, THREE.MathUtils.clamp(up * (dustMax > 0.4 ? 1.1 : 0.7), 0, dustMax));
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
  /** Outcrop shapes: the Moon's bedded slab; on Mars several bedrock plates. */
  private outcropMeshes: THREE.InstancedMesh[] = [];
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
  /** Where layered ledges crop out (for checks). */
  readonly ledgeSpots: { x: number; z: number }[] = [];
  /** A skylight (Pavonis): centre, radius with margin, rim height - no rocks hang over it. */
  private hole: { x: number; z: number; r: number; rimY: number } | null = null;

  constructor(private terrain: TerrainData, private physics: Physics, quality: QualitySettings, photo?: THREE.Texture) {
    this.q = quality;
    const cave = (terrain.meta as { cave?: { x: number; z: number; rimY: number; holeR: number[] } }).cave;
    if (cave) this.hole = { x: cave.x, z: cave.z, r: Math.max(...cave.holeR) + 3, rimY: cave.rimY };
    this.abundance = terrain.meta.rockAbundance ?? (terrain.meta.body === 'mars' ? 5 : 1);
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
        .replace('#include <common>', '#include <common>\nvarying vec3 vRockP;\nvarying vec3 vRockN;\nvarying float vRockSeed;\nvarying float vRockS;')
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
vRockSeed = 0.5;
#endif
vRockP = position * rScale;
vRockS = rScale;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vRockP;
varying vec3 vRockN;
varying float vRockSeed;
varying float vRockS;
#if ROCK_PHOTO > 0
uniform sampler2D uRockPhoto;
// Real rover photographs of Martian rock (2 × 2 atlas), projected triplanarly. Stochastic
// tiling: each cell of a grid shows its own window of the photo, turned by its own angle,
// and the four cells round a point blend smoothly with the contrast kept (variance-
// preserving) - no repeat, no mirror axes, no seams (the photos are not tileable).
vec2 phash(vec2 c) {
  uvec2 v = uvec2(ivec2(floor(c)) + 1048576) * uvec2(1664525u, 1013904223u);
  v.x += v.y * 1664525u; v.y += v.x * 1013904223u; v ^= v >> 16u; v.x += v.y * 1664525u; v.y += v.x * 1013904223u; v ^= v >> 16u;
  return vec2(v) * (1.0 / 4294967295.0);
}
vec3 photoTap(vec2 p, vec2 tile) {
  // p in cells; a cell shows ~0.35 of a photo tile.
  vec2 i = floor(p), f = fract(p);
  vec3 acc = vec3(0.0);
  float wsum = 0.0, w2 = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k & 1), float(k >> 1));
    vec2 h = phash(i + o);
    float an = h.x * 6.2831853;
    vec2 d = p - (i + o);
    vec2 lq = mat2(cos(an), sin(an), -sin(an), cos(an)) * d * 0.35 + 0.5 + (h - 0.5) * 0.12;
    lq = clamp(lq, vec2(0.01), vec2(0.99));
    vec2 bw = mix(1.0 - f, f, o);
    float w = bw.x * bw.y;
    w = w * w * (3.0 - 2.0 * w);
    acc += texture2D(uRockPhoto, (tile + lq) * 0.5).rgb * w;
    wsum += w; w2 += w * w;
  }
  vec3 mean = textureLod(uRockPhoto, (tile + 0.5) * 0.5, 9.0).rgb;
  // Blending lowers contrast: restore it around the photo's mean.
  return max(mean + (acc / wsum - mean) * wsum / sqrt(w2), vec3(0.0));
}
vec3 rockPhoto(vec3 p, vec3 w) {
  float s = vRockSeed;
  vec2 tile = vec2(floor(s * 2.0), floor(fract(s * 7.13) * 2.0));
#if ROCK_MARS > 0
  // Tile (1, 0), the coarse "Cine" basalt, turns into a speckled carpet on a metre-wide
  // plate: big rocks take the dusty, finely pitted Jezero rock (0, 0) instead.
  if (vRockS > 1.2 && tile.x > 0.5 && tile.y < 0.5) tile.x = 0.0;
#endif
  vec3 o = vec3(s * 17.0, s * 5.0, s * 11.0);
#if ROCK_MARS > 0
  // Mars bedrock plates are metres across: stretch the photo with the rock's size
  // instead of repeating a 0.6 m tile into a visible grid.
  p = p / (0.21 * clamp(vRockS * 0.7, 1.0, 3.0)) + o;
#else
  p = p / 0.21 + o;
#endif
  return photoTap(p.yz, tile) * w.x + photoTap(p.xz, tile) * w.y + photoTap(p.xy, tile) * w.z;
}
#endif
${NOISE_GLSL}
// Triplanar value noise in rock-local metres.
float tri(vec3 p, vec3 w) {
  return lnoised(p.yz).x * w.x + lnoised(p.xz + 13.1).x * w.y + lnoised(p.xy + 27.7).x * w.z;
}
#if ROCK_MARS > 0
// Calcium-sulfate veins (cf. Cheyava Falls, Perseverance 2024; the veins of Gale seen
// by Curiosity): water filled fractures with white sulfate. Fractures = level lines of
// a warped noise field, a coarse set (cm apart) and a fine one between: wandering,
// branching, of uneven width - no straight or parallel lines. Returns coverage 0..1,
// faded where the veins would be finer than ~2 px (no moire). Only some rocks.
float veined() { return step(fract(vRockSeed * 13.7), 0.2); }
// Cell hash (exact integers): jittered fracture-network nodes.
vec2 vh2(vec2 c) {
  uvec2 v = uvec2(ivec2(c) + 1048576) * uvec2(1664525u, 1013904223u);
  v.x += v.y * 1664525u; v.y += v.x * 1013904223u; v ^= v >> 16u; v.x += v.y * 1664525u; v.y += v.x * 1013904223u; v ^= v >> 16u;
  return vec2(v) * (1.0 / 4294967295.0);
}
// Distance to the nearest fracture of a jittered cell network (F2 - F1): polygons of
// uneven size and shape, edges meeting at triple junctions. "keep": the share of
// fracture segments that were filled (each segment, between two given cells, decides
// on its own) - a few veins crossing and ending, not a net around every cell.
float fracture(vec2 p, float keep) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  vec2 c1 = vec2(0.0), c2 = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 r = g + 0.15 + 0.7 * vh2(i + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = i + g; } else if (d < d2) { d2 = d; c2 = i + g; }
  }
  float filled = step(vh2(c1 + c2 + 91.0).x, keep);
  return mix(9.0, sqrt(d2) - sqrt(d1), filled);
}
float veinNet(vec3 p, vec3 w, float fw) {
  vec3 q = p + vec3(vRockSeed * 31.0, vRockSeed * 7.0, vRockSeed * 19.0);
  // The plane facing the dominant normal (no ghost lines from blending three).
  vec2 p2 = w.x > w.y && w.x > w.z ? q.yz : w.y > w.z ? q.xz : q.xy;
  // A little warp: fractures kink and bow instead of running ruler-straight.
  vec2 wp = vec2(lnoised(p2 * 6.0).x, lnoised(p2 * 6.0 + 7.3).x) - 0.5;
  vec2 a2 = p2 * 4.5 + wp * 0.7;
  vec2 b2 = p2 * 14.0 + wp * 1.4 + 3.7;
  float ea = fracture(a2, 0.38), eb = fracture(b2, 0.18);
  // Width pinches and swells along each vein (2-7 mm, fine set 1-3 mm).
  float wa = 0.04 * (0.4 + 1.2 * lnoised(p2 * 11.0 + 2.0).x);
  float wb = 0.035 * (0.3 + 1.0 * lnoised(p2 * 27.0 + 6.0).x);
  float va = (1.0 - smoothstep(wa, wa + fwidth(ea) + 1e-4, ea)) * (1.0 - smoothstep(0.1, 0.22, fw * 4.5));
  float vb = (1.0 - smoothstep(wb, wb + fwidth(eb) + 1e-4, eb)) * (1.0 - smoothstep(0.1, 0.22, fw * 14.0)) * 0.7;
  // Not every fracture was filled: the fine set comes and goes.
  float present = smoothstep(0.35, 0.6, lnoised(p2 * 2.5 + 17.0).x);
  return max(va, vb * present) * veined();
}
#endif
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
#if ROCK_MARS > 0
  // Sulfate is harder than the host rock: the veins stand out as low ridges.
  H += veinNet(vRockP, w, fw) * 0.0025;
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
#if ROCK_MARS > 0
  {
    float v = veinNet(vRockP, w, fw);
    if (v > 0.0) {
      // Host: reddish sedimentary rock (hematite), the vein cream-white sulfate, with
      // the ochre dust lying on it on the upper faces.
      diffuseColor.rgb *= mix(vec3(1.0), vec3(1.12, 0.94, 0.84), veined() * 0.6);
      float up = smoothstep(0.4, 0.95, normalize(vRockN).y);
      // Bright where fresh, a thin ochre dusting on the upper faces.
      vec3 sulfate = mix(vec3(0.78, 0.73, 0.64), vec3(0.6, 0.45, 0.33), up * 0.3);
      diffuseColor.rgb = mix(diffuseColor.rgb, sulfate, v);
    } else diffuseColor.rgb *= mix(vec3(1.0), vec3(1.12, 0.94, 0.84), veined() * 0.6);
  }
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
    if (mars) for (let v = 0; v < OUTCROP_VARIANTS_MARS; v++) this.outcropMeshes.push(new THREE.InstancedMesh(plateGeometry(41 + v * 17, tint), mat, 500));
    // Four lunar slab shapes (one shape everywhere was a visible repeat).
    else for (let v = 0; v < 4; v++) this.outcropMeshes.push(new THREE.InstancedMesh(slabGeometry(5 + v * 29, tint), mat, 400));
    for (const m of [...this.boulderNear, ...this.boulderFar, ...this.outcropMeshes]) this.prep(m);
    for (const m of this.boulderFar) m.castShadow = false;
    this.placeBoulders();
    if (this.mars && terrain.meta.sites?.rochette) this.placeArtuby(terrain.meta.sites.rochette.x, terrain.meta.sites.rochette.z);
    this.placeLandmarks(mat, tint);
  }

  /**
   * Real, photographed rocks at their stations:
   * - Apollo 17 station 6: the split boulder at the foot of the North Massif (AS17-140-
   *   21497 and the pan around it): a house-sized block of breccia that rolled down the
   *   massif and broke into five pieces, the cracks open by up to a metre or so.
   * - Apollo 15 station 7, Spur crater: the "Genesis Rock" (15415), a fist-sized piece of
   *   white anorthosite that Scott and Irwin found perched on top of a larger dusty rock.
   */
  private placeLandmarks(mat: THREE.Material, tint: RockTint): void {
    const id = currentSite().id, sites = this.terrain.meta.sites ?? {};
    const t = this.terrain;
    const add = (g: THREE.BufferGeometry, pos: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3, albedo: number, collide = true) => {
      const m = new THREE.InstancedMesh(g, mat, 1);
      m.setMatrixAt(0, new THREE.Matrix4().compose(pos, q, s));
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([albedo, albedo, albedo]), 3);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      if (collide) {
        g.computeBoundingBox();
        const bb = g.boundingBox!, c = bb.getCenter(new THREE.Vector3()).multiply(s).applyQuaternion(q).add(pos);
        const e = bb.getSize(new THREE.Vector3()).multiply(s).multiplyScalar(0.5);
        this.makeCollider({ x: c.x, y: c.y, z: c.z, r: Math.max(e.x, e.z), sx: e.x / 0.82, sy: e.y / 0.82, sz: e.z / 0.82, q, v: 0, albedo });
      }
    };
    if (id === 'apollo17' && sites.st6) {
      const rnd = mulberry32(21497);
      const base = rockGeometry(21497, 5, tint, true);
      // Along the slope (the boulder rolled down it): the long axis across the fall line.
      t.normal(sites.st6.x, sites.st6.z, this.tmpN, 8);
      const down = new THREE.Vector3(this.tmpN[0], 0, this.tmpN[2]).normalize();
      const yaw = Math.atan2(down.x, down.z) + Math.PI / 2;
      const S = new THREE.Vector3(5.5, 3.2, 3.6);
      // Four fracture planes, roughly across the long axis, each tilted its own way.
      const cuts: { n: THREE.Vector3; d: number }[] = [];
      for (let k = 0; k < 4; k++) {
        const n = new THREE.Vector3(1, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.7).normalize();
        cuts.push({ n, d: -0.62 + k * 0.42 + (rnd() - 0.5) * 0.12 });
      }
      const cx = sites.st6.x - down.x * 6, cz = sites.st6.z - down.z * 6;
      const bp = base.getAttribute('position') as THREE.BufferAttribute;
      for (let piece = 0; piece < 5; piece++) {
        // Each piece: the boulder's points clipped to its slab, then their convex hull -
        // flat, exact fracture faces (clamping the mesh itself folded triangles onto them).
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < bp.count; i++) {
          const v = new THREE.Vector3().fromBufferAttribute(bp, i);
          // Keep the slab between cut piece-1 and cut piece: outside vertices onto the planes.
          if (piece > 0) { const c = cuts[piece - 1], k = v.dot(c.n) - c.d; if (k < 0) v.addScaledVector(c.n, -k); }
          if (piece < 4) { const c = cuts[piece], k = v.dot(c.n) - c.d; if (k > 0) v.addScaledVector(c.n, -k); }
          pts.push(v);
        }
        const g = new ConvexGeometry(pts);
        const col = new Float32Array(g.getAttribute('position').count * 3);
        for (let i = 0; i < col.length; i += 3) { const k = 0.9 + 0.2 * rnd(); col[i] = tint.base.r * k; col[i + 1] = tint.base.g * k; col[i + 2] = tint.base.b * k; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        // The pieces moved apart along the axis and settled a little down the slope.
        const along = (piece - 2) * (0.35 + rnd() * 0.35);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.08, yaw + (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.1));
        const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const pos = new THREE.Vector3(cx + ax.x * along + down.x * rnd() * 0.6, 0, cz + ax.z * along + down.z * rnd() * 0.6);
        pos.y = t.height(pos.x, pos.z) + S.y * (0.45 - rnd() * 0.1);
        add(g, pos, q, S, 1.05 + rnd() * 0.15);
      }
    }
    if (id === 'apollo15' && sites.spur && sites.lm) {
      // On the rim of Spur (~50 m from its centre), on the side facing the LM.
      const sx = sites.spur.x, sz = sites.spur.z;
      const dir = new THREE.Vector3(sites.lm.x - sx, 0, sites.lm.z - sz).normalize();
      const px = sx + dir.x * 52, pz = sz + dir.z * 52;
      const y0 = t.height(px, pz);
      const ped = rockGeometry(15415, 4, tint, true);
      const qp = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0.7, -0.1));
      const sp = new THREE.Vector3(0.45, 0.28, 0.38);
      add(ped, new THREE.Vector3(px, y0 + sp.y * 0.55, pz), qp, sp, 0.95);
      // The white anorthosite on top: a bright, clean, angular fragment ~ 10 x 6 cm.
      const gen = rockGeometry(15416, 3, { base: new THREE.Color(0.62, 0.62, 0.6), dust: null }, true);
      add(gen, new THREE.Vector3(px + 0.04, y0 + sp.y * 0.55 + sp.y * 0.85 + 0.03, pz - 0.03), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.9, 0.2)), new THREE.Vector3(0.055, 0.032, 0.04), 1.0, false);
    }
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
    this.surfCells.clear(); // cobble density depends on the quality
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
    // Apollo 15: where a deep depression's upper wall is steep - Hadley Rille, and the
    // walls of the larger mare craters - the layered mare basalt crops out in ledges
    // (Scott and Irwin at station 9a; AS15-89-12104...).
    const layered = currentSite().id === 'apollo15';
    // Upper wall of a deep depression: the rim within 150 m is 5-60 m above, and the
    // ground within 400 m drops more than 80 m below (the rille is ~300 m deep; small
    // craters on the plain are not).
    const upperWall = (x: number, z: number, h: number) => {
      let up = -Infinity, down = Infinity;
      for (let k = 0; k < 12; k++) {
        const c = Math.cos(k * 0.5236), sn = Math.sin(k * 0.5236);
        up = Math.max(up, t.height(x + c * 150, z + sn * 150));
        down = Math.min(down, t.height(x + c * 400, z + sn * 400));
      }
      return up - h > 5 && up - h < 60 && h - down > 80;
    };
    const nB = [0, 0, 0];
    const n = Math.floor(t.meta.sizeX / BOULDER_GRID);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -t.halfX + (i + 0.5) * BOULDER_GRID, z = -t.halfZ + (j + 0.5) * BOULDER_GRID;
        const h = hash2(i, j, 991);
        // Above the highest possible p (steepest slope on pavement) the cell is empty
        // whatever the slope: skip the costly normal (4 height samples) for ~83 % of cells.
        if (h > BOULDER_P_MAX) continue;
        t.normal(x, z, this.tmpN, 3);
        const slopeDeg = (Math.acos(Math.min(1, this.tmpN[1])) * 180) / Math.PI;
        // Probability per 64 m² cell: sparse on the plains, dense on steep slopes.
        // Mars: the bedrock pavement (material map) is strewn with blocks and low ledges
        // of the Máaz lava flows; the sand between them has few.
        const mat = t.materialAt(x, z);
        const p = BOULDER_P0 + BOULDER_P_SLOPE * THREE.MathUtils.smoothstep(slopeDeg, 10, 30) + BOULDER_P_PAVE * mat;
        if (h > p) continue;
        const rnd = mulberry32(Math.floor(hash2(i, j, 4242) * 4294967296));
        const px = x + (rnd() - 0.5) * BOULDER_GRID, pz = z + (rnd() - 0.5) * BOULDER_GRID;
        const outcrop = (slopeDeg > 24 && rnd() < 0.35) || (mat > 0.7 && rnd() < 0.45);
        if (layered && slopeDeg > 22 && rnd() < 0.65) {
          t.normal(px, pz, nB, 12);
          if (Math.acos(Math.min(1, nB[1])) > 0.42 && upperWall(px, pz, t.height(px, pz))) {
            this.ledgeSpots.push({ x: px, z: pz });
            // Ledges along the contour; often a second bed a few metres lower.
            const strike = Math.atan2(this.tmpN[0], -this.tmpN[2]);
            const dn = Math.hypot(this.tmpN[0], this.tmpN[2]) || 1;
            this.placePlateRow(px, pz, rnd, strike + (rnd() - 0.5) * 0.25, 0.55 + rnd() * 0.2, 1.9);
            if (rnd() < 0.6) this.placePlateRow(px + (this.tmpN[0] / dn) * 2.8, pz + (this.tmpN[2] / dn) * 2.8, rnd, strike + (rnd() - 0.5) * 0.25, 0.55 + rnd() * 0.2, 1.9);
            continue;
          }
        }
        // Mars bedrock on flat ground: a row of low plates along the strike (Rochette ridge).
        if (outcrop && this.mars && slopeDeg <= 24) {
          this.placePlateRow(px, pz, rnd);
          continue;
        }
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
        this.addBoulder({ x: px, y, z: pz, r, sx, sy, sz, q, v: Math.floor(rnd() * BOULDER_VARIANTS), albedo: outcrop ? (this.mars ? 0.75 : 0.5) + rnd() * 0.2 : 0.85 + rnd() * 0.4, outcrop });
      }
    }
  }

  /**
   * The Artuby ridge at Rochette (the first cores, Sol 190, PIA24840): a long band of
   * light, dust-coated plates breaking out of the ground, with Rochette itself - a
   * ~1.5 m lumpy block of altered basalt, its faces cleaner and greyer - lying beside
   * it, and loose blocks shed from the ridge. Fixed seed: always the same scene.
   */
  private placeArtuby(cx: number, cz: number): void {
    const t = this.terrain;
    const rnd = mulberry32(190);
    const strike = THREE.MathUtils.degToRad(25);
    const dx = Math.cos(strike), dz = Math.sin(strike);
    for (let k = -6; k <= 6; k++) {
      const a = k * 4.5 + (rnd() - 0.5) * 2, side = (rnd() - 0.5) * 2.5 - 3;
      this.placePlateRow(cx + dx * a - dz * side, cz + dz * a + dx * side, rnd, strike + (rnd() - 0.5) * 0.3);
    }
    const Y = new THREE.Vector3(0, 1, 0);
    // v 2-3 on Mars are the faceted, freshly broken shapes (Rochette's look in PIA24840).
    const block = (x: number, z: number, r: number, albedo: number, v = Math.floor(rnd() * 2)) => {
      const sx = r * (1.3 + 0.3 * rnd()), sy = r * (0.6 + 0.15 * rnd()), sz = r * (0.75 + 0.2 * rnd());
      const q = new THREE.Quaternion().setFromAxisAngle(Y, strike + (rnd() - 0.5) * 1.2).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, 0, (rnd() - 0.5) * 0.3)));
      this.addBoulder({ x, y: t.height(x, z) - sy * 0.3, z, r, sx, sy, sz, q, v, albedo, outcrop: false });
    };
    // Rochette, on the rover's side of the ridge.
    block(cx + dz * 1.5, cz - dx * 1.5, 0.75, 2.6, 2);
    for (let k = 0; k < 14; k++) {
      const a = (rnd() - 0.5) * 50, side = -1 - rnd() * 9;
      block(cx + dx * a - dz * side, cz + dz * a + dx * side, 0.15 + 0.4 * rnd() * rnd(), 0.9 + rnd() * 0.4);
    }
  }

  /**
   * Over the opening the ground is not drawn (TerrainRenderer discards it), but the
   * heightmap there still holds the DTM's sag: a rock placed on it would float in the
   * void. Nor does a rock sit on the lip just above the throat.
   */
  private overHole(x: number, z: number, y: number): boolean {
    const h = this.hole;
    return !!h && Math.hypot(x - h.x, z - h.z) < h.r && y < h.rimY + 1.5;
  }

  private addBoulder(b: Rock): void {
    if (this.overHole(b.x, b.z, b.y)) return;
    const key = `${Math.floor(b.x / BOULDER_CELL)},${Math.floor(b.z / BOULDER_CELL)}`;
    if (!this.boulderGrid.has(key)) this.boulderGrid.set(key, []);
    this.boulderGrid.get(key)!.push(this.boulders.length);
    this.boulders.push(b);
  }

  /**
   * A broken-up bedrock exposure on Mars: 2-5 low plates (0.25-0.6 m thick, half
   * buried) strung along the strike with sand between them, each following the
   * ground's tilt, as along the Rochette ridge and across the Máaz pavement.
   */
  placePlateRow(x0: number, z0: number, rnd: () => number, strike = rnd() * Math.PI, albedoBase?: number, scale = 1): void {
    const t = this.terrain;
    const dx = Math.cos(strike), dz = Math.sin(strike);
    const count = 2 + Math.floor(rnd() * 4);
    const r0 = (0.7 + rnd() * 1.3) * scale;
    const albedo = albedoBase ?? 1.05 + rnd() * 0.25;
    // The bedding dips: the plates of one row lean the same way (tilted ledges).
    const dip = (rnd() - 0.5) * 0.35;
    let along = -r0 * count * 0.5, prev = 0;
    const up = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < count; k++) {
      const r = r0 * (0.55 + 0.6 * rnd());
      along += (prev + r) * (0.75 + 0.35 * rnd());
      prev = r;
      const side = (rnd() - 0.5) * 0.6 * r0;
      const x = x0 + dx * along - dz * side, z = z0 + dz * along + dx * side;
      if (!t.inside(x, z)) continue;
      t.normal(x, z, this.tmpN, 1.5);
      up.set(this.tmpN[0], this.tmpN[1], this.tmpN[2]);
      const q = new THREE.Quaternion()
        .setFromUnitVectors(Y, up)
        .multiply(new THREE.Quaternion().setFromAxisAngle(Y, -strike + (rnd() - 0.5) * 0.6))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dip + (rnd() - 0.5) * 0.15));
      const sx = r * (0.9 + 0.3 * rnd()), sz = r * (0.75 + 0.3 * rnd()), sy = (0.25 + rnd() * 0.35) * scale;
      this.addBoulder({ x, y: t.height(x, z) - sy * 0.45, z, r, sx, sy, sz, q, v: Math.floor(rnd() * (this.mars ? OUTCROP_VARIANTS_MARS : 4)), albedo: albedo + (rnd() - 0.5) * 0.08, outcrop: true });
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
      if (this.overHole(x, z, y)) continue;
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
      if (this.overHole(x, z, y)) continue;
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
    const nOut = new Array(this.outcropMeshes.length).fill(0);
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
            const o = b.v % this.outcropMeshes.length, om = this.outcropMeshes[o];
            if (nOut[o] < om.instanceMatrix.count) {
              om.setMatrixAt(nOut[o], m4);
              om.setColorAt(nOut[o]++, col);
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
    const all: [THREE.InstancedMesh, number][] = this.outcropMeshes.map((m, o) => [m, nOut[o]]);
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

  /** Rocks of the cells around a point, for surfaceAt (deterministic, so cached). */
  private surfCells = new Map<string, Rock[]>();
  private tq = new THREE.Quaternion();
  private ta = new THREE.Vector3();
  private tb = new THREE.Vector3();

  private surfCell(cx: number, cz: number): Rock[] {
    const key = `${cx},${cz}`;
    let list = this.surfCells.get(key);
    if (!list) {
      if (this.surfCells.size > 24) this.surfCells.clear();
      list = [...this.cellRocks(cx, cz), ...this.cellGravel(cx, cz)];
      this.surfCells.set(key, list);
    }
    return list;
  }

  /**
   * Top of the rock surface under (x, z), m (−Infinity where there is none): for
   * an astronaut on foot to stand on, step onto, or run into rocks. Each rock is
   * taken as the ellipsoid of its drawn shape (boulders and cobbles ~0.85 of their
   * scale across, 0.8 up; slabs and plates 0.9 across, 0.5 up).
   */
  surfaceAt(x: number, z: number): number {
    let top = -Infinity;
    const test = (r: Rock) => {
      const reach = Math.max(r.sx, r.sz);
      const dx = x - r.x, dz = z - r.z;
      if (dx * dx + dz * dz > reach * reach) return;
      const kx = r.outcrop ? 0.9 : 0.85, ky = r.outcrop ? 0.5 : 0.8;
      // Vertical line through (x, z) in the rock's unit-sphere frame: |A + t·B| = 1.
      this.tq.copy(r.q).invert();
      const A = this.ta.set(dx, 0, dz).applyQuaternion(this.tq);
      const B = this.tb.set(0, 1, 0).applyQuaternion(this.tq);
      A.set(A.x / (r.sx * kx), A.y / (r.sy * ky), A.z / (r.sz * kx));
      B.set(B.x / (r.sx * kx), B.y / (r.sy * ky), B.z / (r.sz * kx));
      const bb = B.dot(B), ab = A.dot(B), disc = ab * ab - bb * (A.dot(A) - 1);
      if (disc <= 0) return;
      const y = r.y + (-ab + Math.sqrt(disc)) / bb;
      if (y > top) top = y;
    };
    const c0x = Math.floor((x - 3) / CELL), c1x = Math.floor((x + 3) / CELL);
    const c0z = Math.floor((z - 3) / CELL), c1z = Math.floor((z + 3) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) for (const r of this.surfCell(cx, cz)) test(r);
    const b0x = Math.floor((x - 8) / BOULDER_CELL), b1x = Math.floor((x + 8) / BOULDER_CELL);
    const b0z = Math.floor((z - 8) / BOULDER_CELL), b1z = Math.floor((z + 8) / BOULDER_CELL);
    for (let bz = b0z; bz <= b1z; bz++)
      for (let bx = b0x; bx <= b1x; bx++) for (const i of this.boulderGrid.get(`${bx},${bz}`) ?? []) test(this.boulders[i]);
    return top;
  }

  count(): number {
    const sum = (l: THREE.InstancedMesh[]) => l.reduce((a, m) => a + m.count, 0);
    return sum(this.meshes) + sum(this.boulderNear) + sum(this.boulderFar) + sum(this.outcropMeshes);
  }
}
