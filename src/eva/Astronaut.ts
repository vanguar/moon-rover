import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * An Apollo astronaut on foot (EVA) in the A7L-B suit.
 *
 * The suit is one seamless skinned surface, as the real garment is one piece of
 * cloth: the body is a signed-distance field (smooth unions of tapered capsules and
 * ellipsoids, with the convolute bellows of shoulders, elbows and knees as ripples of
 * the same surface), polygonised once by marching cubes and skinned to a skeleton,
 * so the cloth bends smoothly at the joints. Only the parts that really are separate
 * hard pieces are separate meshes on the bones: helmet and LEVA, PLSS and OPS, RCU and
 * camera, connectors, gloves, overshoe soles.
 *
 * Physics (mass ≈ 170 kg: ~80 kg crewman + ~90 kg suit and PLSS; weight on the Moon
 * 275 N). Ground friction μ ≈ 0.6 limits every horizontal force to μ·m·g, so
 *  - speed changes stay below μ·g ≈ 1 m/s² (0.75 up, 0.9 down: 2–3 steps to stop);
 *  - turns are limited by v²/r ≤ μ·g: angular rate ≤ μ·g / v (wide arcs when running);
 *  - to accelerate without toppling the body leans by atan(a/g): ~25° on the Moon for
 *    0.75 m/s² (4° on Earth) - why the astronauts leaned so far into a start and back
 *    to stop.
 * Gaits, after the Apollo Lunar Surface Journal and video analyses of the EVAs: a
 * flat-footed walk when slow (~0.4 m steps, a foot always down) and the lope - a run
 * with alternating feet - up to ~1.5 m/s with ~1-1.3 m steps; each lope step ends in a
 * ballistic float of ~40 % of the step period T = L/v: take-off speed g·t/2, height
 * g·t²/8 - a few centimetres. The two-footed kangaroo jump (Space) leaves at 1.3 m/s:
 * 0.52 m up, 1.6 s aloft.
 *
 * Ground: terrain or a rock top, whichever is higher; rocks up to 0.3 m are stepped
 * onto, a higher face stops the body, an edge is a free fall; terrain over ~25° refuses.
 */
const G = 1.62;
const MU = 0.6;
const VMAX = 1.5;
const VBACK = 0.4;
const ACCEL = 0.75;
const DECEL = 0.9;
const MAX_SLOPE = Math.tan(THREE.MathUtils.degToRad(25));
const STEP = 0.3;
const BODY_R = 0.32;
const LOPE_V = 0.6;
/** Share of a lope step spent in the air. */
const FLIGHT = 0.4;

export interface EvaInput {
  fwd: number;
  turn: number;
  jump: boolean;
}

// ------------------------------------------------------------------ rest pose
// Joint positions (metres, feet at the origin, +z forward). The arms hang out from
// the body (A-pose): a pressurised suit does not let them rest against the sides.
const J = {
  pelvis: [0, 0.97, 0], spine: [0, 1.09, 0], head: [0, 1.7, 0.02],
  shoulder: [0.34, 1.6, 0], elbow: [0.42, 1.27, 0.01], wrist: [0.47, 0.98, 0.03],
  hip: [0.14, 0.94, 0], knee: [0.14, 0.5, 0.01], ankle: [0.14, 0.1, 0],
} as const;
type V3 = readonly [number, number, number];
const mir = (p: V3): V3 => [-p[0], p[1], p[2]];

// ------------------------------------------------------------------ suit surface (SDF)
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
/** Tapered capsule a→b (radii ra, rb) with bellows ripples within `rip` metres of each flagged end. */
function limb(p: V3, a: V3, b: V3, ra: number, rb: number, ripA: boolean, ripB: boolean): number {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const px = p[0] - a[0], py = p[1] - a[1], pz = p[2] - a[2];
  const L2 = bx * bx + by * by + bz * bz, L = Math.sqrt(L2);
  const t = Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / L2));
  const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
  let r = ra + (rb - ra) * t + 0.012 * Math.sin(Math.PI * t); // pressurised: a slight bulge
  const s = t * L;
  const ripple = (dist: number) => (dist < 0.09 ? 0.007 * Math.cos((dist / 0.034) * Math.PI * 2) * (1 - dist / 0.09) : 0);
  if (ripA) r += ripple(s);
  if (ripB) r += ripple(L - s);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}
function ellipsoid(p: V3, c: V3, r: V3): number {
  const x = (p[0] - c[0]) / r[0], y = (p[1] - c[1]) / r[1], z = (p[2] - c[2]) / r[2];
  const k = Math.sqrt(x * x + y * y + z * z);
  return (k - 1) * Math.min(r[0], r[1], r[2]);
}
function roundBox(p: V3, c: V3, h: V3, rad: number): number {
  const qx = Math.abs(p[0] - c[0]) - h[0] + rad, qy = Math.abs(p[1] - c[1]) - h[1] + rad, qz = Math.abs(p[2] - c[2]) - h[2] + rad;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - rad;
}
/** Signed distance to the suit's cloth (negative inside). */
function suitSdf(p: V3): number {
  let body = smin(ellipsoid(p, [0, 1.42, 0.01], [0.31, 0.35, 0.21]), ellipsoid(p, [0, 1.01, 0], [0.26, 0.18, 0.19]), 0.12);
  // Flat back where the PLSS is strapped on (the suit's back plate under the harness).
  body = smin(body, roundBox(p, [0, 1.47, -0.1], [0.24, 0.3, 0.11], 0.06), 0.06);
  body = smin(body, limb(p, [0, 1.64, 0], [0, 1.73, 0.01], 0.17, 0.16, false, false), 0.05); // neck to the helmet ring
  let arms = Infinity, legs = Infinity;
  for (const m of [false, true]) {
    const f = (v: V3) => (m ? mir(v) : v);
    const sh = f(J.shoulder), el = f(J.elbow), wr = f(J.wrist), hip = f(J.hip), kn = f(J.knee), an = f(J.ankle);
    body = smin(body, ellipsoid(p, sh, [0.13, 0.13, 0.13]), 0.07);
    const arm = smin(limb(p, sh, el, 0.105, 0.092, true, true), limb(p, el, wr, 0.09, 0.078, true, false), 0.03);
    arms = Math.min(arms, smin(arm, ellipsoid(p, sh, [0.13, 0.13, 0.13]), 0.05));
    const leg = smin(limb(p, [hip[0], hip[1] + 0.05, hip[2]], kn, 0.125, 0.113, false, true), limb(p, kn, an, 0.11, 0.097, true, false), 0.03);
    // Lunar overshoe around the foot.
    const shoe = roundBox(p, [an[0], 0.065, 0.045], [0.076, 0.065, 0.168], 0.045);
    legs = Math.min(legs, smin(leg, shoe, 0.04));
  }
  // Arms and legs join the trunk smoothly at shoulders and hips, but not each other.
  return Math.min(smin(body, legs, 0.06), arms);
}

/** Grid of the polygonisation: a cube of 2.1 m around the body. */
const MC_RES = 96, MC_HALF = 1.05, MC_CY = 0.95, MC_CZ = -0.03;
let suitGeometry: THREE.BufferGeometry | null = null;

/** One seamless suit surface (built once per page), skinned to the bone segments. */
function buildSuitGeometry(): THREE.BufferGeometry {
  if (suitGeometry) return suitGeometry;
  const mc = new MarchingCubes(MC_RES, new THREE.MeshBasicMaterial(), false, false, 120000);
  mc.isolation = 0;
  const n = MC_RES, f = mc.field;
  const p: [number, number, number] = [0, 0, 0];
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        p[0] = ((x - n / 2) / (n / 2)) * MC_HALF;
        p[1] = ((y - n / 2) / (n / 2)) * MC_HALF + MC_CY;
        p[2] = ((z - n / 2) / (n / 2)) * MC_HALF + MC_CZ;
        // Far outside the body bounds: no need for the full field.
        const out = Math.abs(p[0]) > 0.7 || p[1] < -0.05 || p[1] > 1.85 || p[2] > 0.45 || p[2] < -0.45;
        f[z * n * n + y * n + x] = out ? -1 : -suitSdf(p);
      }
  mc.update();
  const count = mc.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = mc.positionArray[i * 3] * MC_HALF;
    pos[i * 3 + 1] = mc.positionArray[i * 3 + 1] * MC_HALF + MC_CY;
    pos[i * 3 + 2] = mc.positionArray[i * 3 + 2] * MC_HALF + MC_CZ;
    nor.set([mc.normalArray[i * 3], mc.normalArray[i * 3 + 1], mc.normalArray[i * 3 + 2]], i * 3);
  }
  mc.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  // Skin weights: inverse distance to each bone's segment (the 4 nearest), so the
  // cloth blends across a joint instead of folding at a seam.
  const segs: [number, V3, V3][] = [
    [BONE.pelvis, J.pelvis, J.spine], [BONE.spine, J.spine, [0, 1.65, 0]], [BONE.head, [0, 1.65, 0], J.head],
    [BONE.shoulderL, J.shoulder, J.elbow], [BONE.elbowL, J.elbow, J.wrist], [BONE.shoulderR, mir(J.shoulder), mir(J.elbow)], [BONE.elbowR, mir(J.elbow), mir(J.wrist)],
    [BONE.hipL, J.hip, J.knee], [BONE.kneeL, J.knee, J.ankle], [BONE.ankleL, J.ankle, [J.ankle[0], 0.05, 0.2]],
    [BONE.hipR, mir(J.hip), mir(J.knee)], [BONE.kneeR, mir(J.knee), mir(J.ankle)], [BONE.ankleR, mir(J.ankle), [-J.ankle[0], 0.05, 0.2]],
  ];
  const si = new Uint16Array(count * 4), sw = new Float32Array(count * 4);
  const d = new Float32Array(segs.length);
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    for (let s = 0; s < segs.length; s++) {
      const [, a, b] = segs[s];
      const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
      const t = Math.min(1, Math.max(0, ((x - a[0]) * bx + (y - a[1]) * by + (z - a[2]) * bz) / (bx * bx + by * by + bz * bz)));
      d[s] = Math.hypot(x - a[0] - bx * t, y - a[1] - by * t, z - a[2] - bz * t);
    }
    const order = [...d.keys()].sort((a, b) => d[a] - d[b]).slice(0, 4);
    let sum = 0;
    const w = order.map((s) => {
      const v = 1 / Math.pow(d[s] + 0.02, 6);
      sum += v;
      return v;
    });
    order.forEach((s, k) => {
      si[i * 4 + k] = segs[s][0];
      sw[i * 4 + k] = w[k] / sum;
    });
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  suitGeometry = g;
  return g;
}

/** Bone indices in the skeleton. */
const BONE = { pelvis: 0, spine: 1, head: 2, shoulderL: 3, elbowL: 4, wristL: 5, shoulderR: 6, elbowR: 7, wristR: 8, hipL: 9, kneeL: 10, ankleL: 11, hipR: 12, kneeR: 13, ankleR: 14 } as const;

export class Astronaut {
  readonly object = new THREE.Group();
  readonly camAnchor = new THREE.Object3D();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  onGround = true;
  speed = 0;
  /** A foot came down at (x, z): side −1 left, +1 right, 0 both (a jump landing). */
  onStep?: (x: number, z: number, yaw: number, v: number, side: number) => void;

  private bones: THREE.Bone[] = [];
  private gaitPhase = 0;
  private lastHalf = 0;
  private bob = 0;
  private lean = 0;
  private acc = 0;
  private prevAlong = 0;
  /** Knee-spring of the body (m, + down) and its rate: landings and jump crouch. */
  private squat = 0;
  private squatV = 0;
  /** Jump wind-up: seconds left of the crouch before take-off. */
  private jumpT = 0;
  /** Bank into a turn, rad (atan(v·ω/g)), and the turn rate. */
  private bank = 0;
  private omega = 0;
  private idleT = 0;
  private time = 0;
  private footY = { value: 0 };
  /** Joint bend for the cloth folds: elbows L/R, knees L/R; hips L/R, waist. */
  private bend = { value: new THREE.Vector4() };
  private bend2 = { value: new THREE.Vector4() };
  private mesh: THREE.SkinnedMesh;
  private materials: THREE.Material[] = [];
  /**
   * The gold visor mirrors the real surroundings (as in the famous visor reflections
   * of the Apollo photographs): a small cube camera at the helmet re-shoots the scene
   * every few frames while the astronaut is seen up close.
   */
  private visorRT = new THREE.WebGLCubeRenderTarget(96, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  private visorCam = new THREE.CubeCamera(0.3, 30000, this.visorRT);
  private visor!: THREE.Mesh;
  private visorFrame = 0;

  /**
   * @param ground surface height under a point (terrain or rock top)
   * @param solid  hardware the body cannot pass through (LM, rovers): true if a body of
   *               radius r centred at (x, z) would overlap it
   */
  constructor(
    private terrain: TerrainData,
    private ground: (x: number, z: number) => number,
    x: number,
    z: number,
    yaw: number,
    private solid: (x: number, z: number, r: number) => boolean = () => false,
  ) {
    this.mesh = this.buildModel();
    this.yaw = yaw;
    this.pos.set(x, ground(x, z), z);
    this.sync();
  }

  // ---------------------------------------------------------------- model

  /** Beta cloth: soft creases fixed on the fabric, lunar dust thickening towards the boots. */
  private fabric(color: number, dustK = 1, rough = 0.92, metal = 0, folds = true): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const footY = this.footY;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uFootY = footY;
      sh.uniforms.uDustK = { value: dustK };
      sh.uniforms.uBend = this.bend;
      sh.uniforms.uBend2 = this.bend2;
      sh.uniforms.uFolds = { value: folds ? 1 : 0 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSuitW;\nvarying vec3 vSuitO;\nvarying mat3 vRestToView;')
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
vSuitW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSuitO = position;
#ifdef USE_SKINNING
vRestToView = mat3(modelViewMatrix) * mat3(skinMatrix);
#else
vRestToView = mat3(modelViewMatrix);
#endif`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vSuitW;
varying vec3 vSuitO;
varying mat3 vRestToView;
uniform float uFootY, uDustK, uFolds;
uniform vec4 uBend, uBend2;
float sh3(vec3 p) { uvec3 v = uvec3(ivec3(floor(p)) + 1048576); v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z;
  return float(v.x) * (1.0 / 4294967295.0); }
float sn3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sh3(i), sh3(i + vec3(1,0,0)), f.x), mix(sh3(i + vec3(0,1,0)), sh3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(sh3(i + vec3(0,0,1)), sh3(i + vec3(1,0,1)), f.x), mix(sh3(i + vec3(0,1,1)), sh3(i + vec3(1,1,1)), f.x), f.y), f.z); }
// Folds of the pressurised cloth around joint j (rest pose): ridges across the limb axis
// within 'width' of the joint, deepest on the inner side of the bend ('crook') and the
// more the joint is bent. Spacing and course wander with noise - cloth never folds in
// ruled lines - and folds finer than ~3 px fade out (no moire at a distance).
// Returns the slope of the fold relief (rest-pose space), analytic: smooth per pixel.
vec3 fold(vec3 p, vec3 j, vec3 ax, vec3 crook, float bend, float width, float rmax, float per0, float seed, float px) {
  vec3 d = p - j; float s = dot(d, ax);
  vec3 rr = d - ax * s; float rl = length(rr);
  float side = 0.25 + 0.75 * smoothstep(-0.5, 0.8, dot(rr / max(rl, 1e-4), crook));
  float w = exp(-s * s / (width * width)) * smoothstep(rmax, rmax * 0.55, rl);
  float warp = (sn3(p * 17.0 + seed) - 0.5) * 3.4 + (sn3(p * 43.0 + seed * 1.7) - 0.5) * 1.3;
  float per = per0 * (0.75 + 0.6 * sn3(p * 7.0 + seed * 2.3));
  float aa = 1.0 - smoothstep(0.18, 0.4, px / per);
  float ph = s / per * 3.14159 + warp;
  // Profile sin φ + 0.25 sin 2φ: narrow valleys, broad crests, like cloth folds.
  return ax * (w * side * (0.25 + bend) * aa * (cos(ph) + 0.5 * cos(2.0 * ph)) * 3.14159 / per);
}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
// Grey lunar dust: thick on the boots and lower legs, in patches above.
float hFeet = vSuitW.y - uFootY;
// Patches from rotated octaves (no lattice-aligned blotches).
mat3 Rm = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60);
float patches = sn3(Rm * vSuitO * 4.0) * 0.65 + sn3(Rm * Rm * vSuitO * 13.0 + 3.1) * 0.35;
float dust = clamp(smoothstep(0.8, 0.1, hFeet) * (0.55 + 0.45 * patches) + 0.08 * smoothstep(0.45, 0.8, patches), 0.0, 1.0) * uDustK;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.41, 0.39), dust * 0.75);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
// Folds of the Beta cloth, fixed on the garment (rest-pose coordinates), deepening as
// the joints bend: elbows, knees, the groin, the waist, the ankles over the overshoes.
if (uFolds > 0.5) {
  vec3 p = vSuitO;
  float px = length(fwidth(p));
  vec3 g = vec3(0.0);
  g += fold(p, vec3(0.42, 1.27, 0.01), normalize(vec3(0.13, -0.62, 0.03)), vec3(0.0, 0.0, 1.0), uBend.x, 0.075, 0.15, 0.034, 1.3, px);
  g += fold(p, vec3(-0.42, 1.27, 0.01), normalize(vec3(-0.13, -0.62, 0.03)), vec3(0.0, 0.0, 1.0), uBend.y, 0.075, 0.15, 0.031, 5.9, px);
  g += fold(p, vec3(0.14, 0.5, 0.01), vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, -1.0), uBend.z, 0.085, 0.17, 0.038, 9.4, px);
  g += fold(p, vec3(-0.14, 0.5, 0.01), vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, -1.0), uBend.w, 0.085, 0.17, 0.035, 14.2, px);
  g += fold(p, vec3(0.13, 0.86, 0.05), vec3(0.15, -1.0, 0.0), vec3(0.0, 0.0, 1.0), uBend2.x, 0.07, 0.2, 0.04, 21.7, px);
  g += fold(p, vec3(-0.13, 0.86, 0.05), vec3(-0.15, -1.0, 0.0), vec3(0.0, 0.0, 1.0), uBend2.y, 0.07, 0.2, 0.043, 27.1, px);
  g += fold(p, vec3(0.0, 1.1, 0.02), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), uBend2.z, 0.07, 0.34, 0.045, 33.5, px);
  g += 0.7 * fold(p, vec3(0.14, 0.24, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), 0.35, 0.05, 0.14, 0.026, 41.0, px);
  g += 0.7 * fold(p, vec3(-0.14, 0.24, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), 0.35, 0.05, 0.14, 0.028, 47.3, px);
  // Fine creases all over (rotated lattice: no grid-aligned marks), finite differences.
  mat3 Rc = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60);
  vec3 q = Rc * p * 26.0;
  float n0 = sn3(q);
  vec3 gn = vec3(sn3(q + vec3(0.25, 0.0, 0.0)) - n0, sn3(q + vec3(0.0, 0.25, 0.0)) - n0, sn3(q + vec3(0.0, 0.0, 0.25)) - n0) * (26.0 / 0.25);
  g += 0.1 * (transpose(Rc) * gn) / 26.0 * 3.0 * (1.0 - smoothstep(0.004, 0.012, px));
  // Tilt the normal by the relief slope (fold depth ~7 mm), carried into view space
  // through the skin: follows the posed limb, no screen-space steps.
  vec3 gv = vRestToView * (g * 0.007);
  normal = normalize(normal - (gv - dot(gv, normal) * normal));
}`,
        );
    };
    m.customProgramCacheKey = () => `suit-fabric-${dustK}-${folds}`;
    this.materials.push(m);
    return m;
  }

  private buildModel(): THREE.SkinnedMesh {
    const plain = (color: number, rough = 0.9, metal = 0) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
      this.materials.push(m);
      return m;
    };
    const beta = this.fabric(0xe9e7e0), betaShade = this.fabric(0xd6d3cb, 0.5, 0.92, 0, false), pack = this.fabric(0xe4e2db, 0.2, 0.92, 0, false);
    const red = plain(0xa3291f, 0.75), sole = plain(0x86b6da, 0.6), glove = this.fabric(0x9ea6af, 0.6, 0.8, 0, false);
    const tips = plain(0x30508a, 0.6), dark = plain(0x2b2d32, 0.55), metal = plain(0xbcc0c6, 0.3, 0.85);
    // LEVA gold visor: a vacuum-deposited gold film (bronze-gold, mirror-smooth) under a
    // clear protective coat that adds its own white glint of the Sun.
    const gold = new THREE.MeshPhysicalMaterial({
      color: 0xd9a548, metalness: 1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02,
      envMap: this.visorRT.texture, envMapIntensity: 1.1,
    });
    this.materials.push(gold);
    const bubble = plain(0x9aa3ab, 0.05, 0.6), blue = plain(0x2c5ea8, 0.5);

    // Skeleton: bones at the rest-pose joints (positions relative to the parent).
    const mk = (parent: THREE.Bone | null, at: V3, from: V3 = [0, 0, 0]) => {
      const b = new THREE.Bone();
      b.position.set(at[0] - from[0], at[1] - from[1], at[2] - from[2]);
      parent?.add(b);
      this.bones.push(b);
      return b;
    };
    const pelvis = mk(null, J.pelvis), spine = mk(pelvis, J.spine, J.pelvis), head = mk(spine, J.head, J.spine);
    const shL = mk(spine, J.shoulder, J.spine), elL = mk(shL, J.elbow, J.shoulder), wrL = mk(elL, J.wrist, J.elbow);
    const shR = mk(spine, mir(J.shoulder), J.spine), elR = mk(shR, mir(J.elbow), mir(J.shoulder)), wrR = mk(elR, mir(J.wrist), mir(J.elbow));
    const hipL = mk(pelvis, J.hip, J.pelvis), knL = mk(hipL, J.knee, J.hip), anL = mk(knL, J.ankle, J.knee);
    const hipR = mk(pelvis, mir(J.hip), J.pelvis), knR = mk(hipR, mir(J.knee), mir(J.hip)), anR = mk(knR, mir(J.ankle), mir(J.knee));
    void head;
    const mesh = new THREE.SkinnedMesh(buildSuitGeometry(), beta);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.add(pelvis);
    mesh.updateMatrixWorld(true); // bind-pose inverses come from the bones' world matrices
    mesh.bind(new THREE.Skeleton(this.bones));
    mesh.frustumCulled = false;
    this.object.add(mesh);

    // Hard parts, attached to bones (positions relative to the bone, rest pose).
    const add = (g: THREE.BufferGeometry, m: THREE.Material, bone: THREE.Bone, at: V3, boneAt: V3) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(at[0] - boneAt[0], at[1] - boneAt[1], at[2] - boneAt[2]);
      o.castShadow = o.receiveShadow = true;
      bone.add(o);
      return o;
    };
    // Commander's red stripes (from Apollo 13): bands on the arms and legs.
    for (const [bone, at, rad, from] of [
      [shL, [0.39, 1.43, 0.005], 0.1, J.shoulder], [shR, [-0.39, 1.43, 0.005], 0.1, mir(J.shoulder)],
      [hipL, [0.14, 0.62, 0.007], 0.118, J.hip], [hipR, [-0.14, 0.62, 0.007], 0.118, mir(J.hip)],
    ] as const) {
      const ring = add(new THREE.TorusGeometry(rad, 0.022, 6, 22), red, bone, at, from);
      ring.rotation.x = Math.PI / 2;
      if (bone === shL || bone === shR) ring.rotation.y = (bone === shL ? -1 : 1) * 0.24;
    }
    // Neck ring and helmet: clear bubble, the LEVA shell, gold visor, eyeshade, red stripe.
    add(new THREE.CylinderGeometry(0.16, 0.175, 0.06, 24), metal, spine, [0, 1.7, 0.01], J.spine);
    const hc: V3 = [0, 1.83, 0.02];
    add(new THREE.SphereGeometry(0.2, 26, 18), bubble, spine, hc, J.spine);
    add(new THREE.SphereGeometry(0.215, 30, 20, Math.PI * 0.62, Math.PI * 1.76, 0, Math.PI * 0.72), this.fabric(0xe9e7e0, 0.4, 0.6, 0, false), spine, hc, J.spine);
    this.visor = add(new THREE.SphereGeometry(0.212, 40, 24, Math.PI * 0.14, Math.PI * 0.72, Math.PI * 0.22, Math.PI * 0.42), gold, spine, hc, J.spine);
    add(new THREE.SphereGeometry(0.219, 26, 8, Math.PI * 0.16, Math.PI * 0.68, Math.PI * 0.1, Math.PI * 0.12), betaShade, spine, hc, J.spine);
    add(new THREE.TorusGeometry(0.219, 0.013, 6, 28, Math.PI * 0.9), red, spine, hc, J.spine).rotation.set(0, Math.PI / 2, Math.PI * 0.05);
    // PLSS with the OPS on top, harness straps, VHF antenna.
    // PLSS snug against the back plate (back of the suit at z ≈ -0.21), OPS on top.
    add(new RoundedBoxGeometry(0.5, 0.64, 0.25, 3, 0.05), pack, spine, [0, 1.46, -0.335], J.spine);
    add(new RoundedBoxGeometry(0.46, 0.19, 0.23, 3, 0.04), betaShade, spine, [0, 1.875, -0.325], J.spine);
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.3), metal, spine, [0.19, 2.06, -0.36], J.spine);
    // RCU on the chest with the Hasselblad; red and blue oxygen connectors.
    add(new RoundedBoxGeometry(0.25, 0.15, 0.1, 2, 0.02), betaShade, spine, [0, 1.52, 0.22], J.spine);
    add(new THREE.BoxGeometry(0.23, 0.02, 0.08), dark, spine, [0, 1.6, 0.22], J.spine);
    for (const kx of [-0.07, 0, 0.07]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8), metal, spine, [kx, 1.615, 0.23], J.spine);
    add(new RoundedBoxGeometry(0.1, 0.1, 0.075, 2, 0.01), metal, spine, [0, 1.4, 0.29], J.spine);
    add(new THREE.CylinderGeometry(0.03, 0.032, 0.05, 16), dark, spine, [0, 1.4, 0.34], J.spine).rotation.x = Math.PI / 2;
    for (const [cx, m, cy] of [[0.17, red, 1.4], [0.17, blue, 1.32], [-0.17, red, 1.4], [-0.17, blue, 1.32]] as const) {
      add(new THREE.CylinderGeometry(0.024, 0.024, 0.05, 12), m, spine, [cx, cy, 0.19], J.spine).rotation.x = Math.PI / 2;
    }
    // Gloves: wrist disconnect ring, gauntlet, hand with the thumb apart, blue fingertips.
    for (const [wr, at] of [[wrL, J.wrist], [wrR, mir(J.wrist)]] as const) {
      add(new THREE.CylinderGeometry(0.083, 0.083, 0.05, 18), metal, wr, [at[0], at[1] + 0.02, at[2]], at);
      add(new THREE.CylinderGeometry(0.08, 0.072, 0.08, 16), glove, wr, [at[0], at[1] - 0.04, at[2]], at);
      const palm = add(new THREE.SphereGeometry(1, 16, 12), glove, wr, [at[0], at[1] - 0.13, at[2] + 0.01], at);
      palm.scale.set(0.052, 0.075, 0.04);
      add(new THREE.SphereGeometry(1, 12, 8), tips, wr, [at[0], at[1] - 0.2, at[2] + 0.015], at).scale.set(0.046, 0.03, 0.036);
      add(new THREE.SphereGeometry(1, 10, 8), glove, wr, [at[0] - Math.sign(at[0]) * 0.045, at[1] - 0.11, at[2] + 0.04], at).scale.set(0.018, 0.036, 0.018);
    }
    // Overshoe soles: light-blue ribbed silicone, 33.6 × 15.2 cm, 8 ribs.
    for (const [an, at] of [[anL, J.ankle], [anR, mir(J.ankle)]] as const) {
      add(new THREE.BoxGeometry(0.152, 0.022, 0.336), sole, an, [at[0], 0.011, 0.045], at);
      for (let k = 0; k < 8; k++) add(new THREE.BoxGeometry(0.13, 0.008, 0.02), sole, an, [at[0], -0.003, -0.1 + k * 0.041], at);
    }
    // The flag on the left upper arm.
    const flag = add(new THREE.PlaneGeometry(0.1, 0.065), plain(0xffffff), shL, [0.47, 1.5, 0.0], J.shoulder);
    (flag.material as THREE.MeshStandardMaterial).map = flagTexture();
    flag.rotation.set(0, Math.PI / 2, -0.24);
    // First-person eye point inside the helmet.
    this.camAnchor.position.set(0, 1.83 - J.spine[1], 0.1);
    spine.add(this.camAnchor);
    void [elL, elR, knL, knR];
    return mesh;
  }

  // ---------------------------------------------------------------- motion

  update(dt: number, input: EvaInput): void {
    dt = Math.min(dt, 0.05);
    const t = this.terrain;
    let along = this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
    if (this.onGround) {
      // Turning: v²/r ≤ μ·g → the angular rate is limited by traction when running.
      const vAbs = Math.abs(along);
      const omega = Math.min(1.6, (MU * G) / Math.max(vAbs, 0.25));
      this.yaw -= input.turn * omega * dt;
      this.omega = -input.turn * omega;
      const target = input.fwd >= 0 ? input.fwd * VMAX : input.fwd * VBACK;
      const rate = Math.abs(target) > Math.abs(along) ? ACCEL : DECEL;
      along += THREE.MathUtils.clamp(target - along, -rate * dt, rate * dt);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.vel.set(fx * along, 0, fz * along);
      // Kangaroo jump: first a crouch (the legs load), then off at 1.3 m/s:
      // h = v²/2g ≈ 0.52 m, 1.6 s aloft.
      if (input.jump && this.jumpT <= 0) this.jumpT = 0.22;
      if (this.jumpT > 0) {
        this.jumpT -= dt;
        if (this.jumpT <= 0) {
          this.vel.y = 1.3;
          this.onGround = false;
          this.squatV = -0.9; // the legs extend
        }
      }
    } else this.vel.y -= G * dt;

    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const run = Math.hypot(nx - this.pos.x, nz - this.pos.z);
    if (run > 1e-5) {
      const ux = (nx - this.pos.x) / run, uz = (nz - this.pos.z) / run;
      const hNew = t.height(nx, nz);
      const steep = Math.abs(t.height(nx + ux * 0.6, nz + uz * 0.6) - hNew) / 0.6 > MAX_SLOPE;
      const ax = nx + ux * BODY_R, az = nz + uz * BODY_R;
      const top = Math.max(this.ground(nx, nz), this.ground(ax, az)), terr = Math.max(hNew, t.height(ax, az));
      const rise = top > terr + 0.01 ? top - this.pos.y : -Infinity;
      // Against hardware: slide along it if one axis is free, else stop.
      if (!steep && this.solid(nx, nz, BODY_R)) {
        if (!this.solid(nx, this.pos.z, BODY_R)) this.pos.x = nx;
        else if (!this.solid(this.pos.x, nz, BODY_R)) this.pos.z = nz;
        this.vel.x = 0;
        this.vel.z = 0;
        along = 0;
      } else if (steep || rise > (this.onGround ? STEP : 0.02)) {
        this.vel.x = 0;
        this.vel.z = 0;
        along = 0;
      } else {
        this.pos.x = nx;
        this.pos.z = nz;
      }
    }
    const g = this.ground(this.pos.x, this.pos.z);
    if (this.onGround) {
      if (g < this.pos.y - 0.08) {
        this.onGround = false; // off the edge of a rock: free fall
        this.vel.y = 0;
      } else this.pos.y = g;
    } else {
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= g && this.vel.y < 0) {
        this.pos.y = g;
        // The legs take the landing: the body sinks with the arrival speed and springs back.
        this.squatV += Math.min(1.6, -this.vel.y * 0.9);
        this.vel.y = 0;
        this.onGround = true;
        this.onStep?.(this.pos.x, this.pos.z, this.yaw, Math.hypot(this.vel.x, this.vel.z), 0);
      }
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // Actual acceleration along the heading (smoothed) for the balance lean.
    this.acc += ((along - this.prevAlong) / dt - this.acc) * Math.min(1, dt * 6);
    this.prevAlong = along;
    this.animate(dt, along);
    this.sync();
  }

  /**
   * Gait cycle (two steps) advancing with the distance covered. Walk below ~0.5 m/s;
   * the skip (a gallop, the same leg always leading: the crews of Apollo 16 and 17
   * found it the least tiring) around 0.6-1.1 m/s; the lope above. Physics on top:
   * the lean atan(a/g) to speed up or stop, the bank atan(v·ω/g) into a turn, the knees
   * as a damped spring that takes each landing; at rest the body breathes and sways.
   */
  private animate(dt: number, along: number): void {
    this.time += dt;
    const v = Math.abs(along);
    const lope = THREE.MathUtils.smoothstep(v, LOPE_V * 0.8, LOPE_V * 1.3);
    const skip = THREE.MathUtils.smoothstep(v, 0.55, 0.75) * (1 - THREE.MathUtils.smoothstep(v, 1.0, 1.2));
    const stepLen = 0.4 + lope * (0.6 + 0.3 * Math.min(1, v / VMAX)); // 0.4 m walking .. ~1.3 m loping
    // Turning on the spot: small shuffling steps.
    const shuffle = this.onGround && v < 0.1 ? Math.min(1, Math.abs(this.omega) / 0.8) : 0;
    if (this.onGround && v > 0.03) this.gaitPhase += (v * dt) / (2 * stepLen);
    else if (shuffle > 0.05) this.gaitPhase += dt * 0.9 * shuffle;
    else this.gaitPhase += (Math.round(this.gaitPhase * 2) / 2 - this.gaitPhase) * Math.min(1, dt * 4);
    const ph = this.gaitPhase * Math.PI * 2;
    const amp = Math.max(Math.min(1, v / 0.35), shuffle * 0.35);
    // A foot comes down at the start of each step.
    const half = Math.floor(this.gaitPhase * 2);
    if (half !== this.lastHalf && this.onGround && (v > 0.05 || shuffle > 0.05)) {
      const side = half % 2 === 0 ? 1 : -1;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.onStep?.(this.pos.x - fz * side * 0.14 + fx * 0.12, this.pos.z + fx * side * 0.14 + fz * 0.12, this.yaw, Math.max(v, 0.2), side);
    }
    this.lastHalf = half;
    // Vertical motion of the body: a ballistic float at the end of each lope step,
    // t_f = FLIGHT·L/v, apex g·t_f²/8; the stance leg flexes under the weight.
    const stepT = (this.gaitPhase * 2) % 1;
    let targetBob = 0;
    if (this.onGround && v > 0.03) {
      const tf = (FLIGHT * stepLen) / Math.max(v, 0.3);
      const apex = (Math.max(lope, skip) * (G * tf * tf)) / 8;
      const u = (stepT - (1 - FLIGHT)) / FLIGHT;
      targetBob = u > 0 ? apex * 4 * u * (1 - u) : -0.022 * amp * Math.sin((Math.PI * stepT) / (1 - FLIGHT));
    }
    this.bob += (targetBob - this.bob) * Math.min(1, dt * 20);
    // Knee spring (ω ≈ 9 rad/s, damping ratio 0.55): crouch before a jump, give on landing.
    const squatTarget = this.jumpT > 0 ? 0.13 : 0;
    const k = 80, c = 2 * 0.55 * Math.sqrt(k);
    this.squatV += (k * (squatTarget - this.squat) - c * this.squatV) * dt;
    this.squat = THREE.MathUtils.clamp(this.squat + this.squatV * dt, -0.04, 0.22);
    // At rest: breathing (~15 a minute) and a slow, irregular sway of the weight.
    const still = this.onGround && v < 0.05 && shuffle < 0.05;
    this.idleT = still ? this.idleT + dt : 0;
    const rest = THREE.MathUtils.smoothstep(this.idleT, 0.5, 2);
    const breath = Math.sin(this.time * 1.6) * 0.006 * rest;
    const sway = (Math.sin(this.time * 0.37) * 0.6 + Math.sin(this.time * 0.61 + 1.3) * 0.4) * 0.025 * rest;
    // Balance: the body leans by atan(a/g) (forward to speed up, back to stop), plus a
    // slight standing stoop against the PLSS; it banks into a turn by atan(v·ω/g).
    const targetLean = 0.06 + Math.atan(THREE.MathUtils.clamp(this.acc, -1.2, 1.2) / G) + 0.06 * Math.min(1, v / VMAX) + 0.6 * this.squat;
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 4);
    const targetBank = this.onGround ? Math.atan((v * this.omega) / G) * 0.8 : this.bank;
    this.bank += (THREE.MathUtils.clamp(targetBank, -0.35, 0.35) - this.bank) * Math.min(1, dt * 5);
    const [pelvis, spine, , shL, elL, , shR, elR, , hipL, knL, anL, hipR, knR, anR] = this.bones;
    pelvis.position.y = J.pelvis[1] + this.bob - this.squat + breath * 0.5;
    pelvis.rotation.set(this.lean, 0, -this.bank + sway);
    spine.rotation.set(breath * 0.8, 0.05 * Math.sin(ph) * amp, -sway * 0.6);
    const air = !this.onGround;
    const hipA = (0.2 + 0.25 * lope) * amp, kneeA = (0.3 + 0.5 * lope) * amp;
    // The skip: the trailing leg follows ~0.35 of a cycle after the lead (not half).
    const offs = Math.PI * (1 - 0.35 * skip);
    const legs: [THREE.Bone, THREE.Bone, THREE.Bone, number][] = [[hipL, knL, anL, 0], [hipR, knR, anR, offs]];
    const sq = this.squat * 4.5; // knee flexion for the spring travel
    for (const [hip, knee, ankle, off] of legs) {
      const p = ph + off, sw = Math.sin(p);
      // The leg leans back with the body so the feet stay under the centre of mass;
      // it stays vertical under a banked or swaying pelvis.
      hip.rotation.x = air ? -0.3 - 0.4 * Math.max(0, -this.squatV) : -sw * hipA - 0.05 - this.lean * 0.9 - sq * 0.5;
      hip.rotation.z = this.bank - sway;
      knee.rotation.x = air ? 0.55 : 0.1 + kneeA * Math.max(0, Math.cos(p - 0.6)) + 0.08 * amp + sq;
      ankle.rotation.x = air ? -0.15 : -hip.rotation.x - knee.rotation.x - this.lean;
    }
    // Arms: held out and bent by the pressurised suit; running, the forearms come up and
    // forward for balance; a small counter-swing; raised a little in the air.
    const arms: [THREE.Bone, THREE.Bone, number][] = [[shL, elL, 0], [shR, elR, Math.PI]];
    for (const [sh, el, off] of arms) {
      sh.rotation.x = -0.12 * Math.sin(ph + off + Math.PI) * amp - 0.15 - 0.2 * lope - (air ? 0.25 : 0);
      el.rotation.x = -0.45 - 0.45 * lope - 0.15 * skip - 0.3 * this.squat;
    }
    // Cloth folds follow the joints.
    const b = this.bend.value, b2 = this.bend2.value;
    b.set(
      THREE.MathUtils.clamp(-elL.rotation.x / 1.1, 0, 1), THREE.MathUtils.clamp(-elR.rotation.x / 1.1, 0, 1),
      THREE.MathUtils.clamp(knL.rotation.x / 0.9, 0, 1), THREE.MathUtils.clamp(knR.rotation.x / 0.9, 0, 1),
    );
    b2.set(
      THREE.MathUtils.clamp(-hipL.rotation.x / 0.7, 0, 1), THREE.MathUtils.clamp(-hipR.rotation.x / 0.7, 0, 1),
      THREE.MathUtils.clamp(0.3 + this.lean * 1.5, 0, 1), 0,
    );
  }

  /** Seconds standing still (the camera may come round to the front). */
  get idleTime(): number {
    return this.idleT;
  }

  private sync(): void {
    this.object.position.copy(this.pos);
    this.object.rotation.set(0, this.yaw, 0);
    this.footY.value = this.pos.y;
    this.object.updateMatrixWorld(true);
  }

  get heading(): number {
    const h = (Math.atan2(Math.sin(this.yaw), -Math.cos(this.yaw)) * 180) / Math.PI;
    return h < 0 ? h + 360 : h;
  }

  /**
   * Re-shoot the visor reflection (every 3rd call). The astronaut is hidden meanwhile
   * (the visor must not mirror its own helmet from inside); `hide` lists other things
   * a cube face must not draw (screen-space effects such as the lens flare).
   */
  updateVisor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: (on: boolean) => void): void {
    if (this.visorFrame++ % 3 !== 0) return;
    this.visor.getWorldPosition(this.visorCam.position);
    this.visorCam.updateMatrixWorld();
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.object.visible = false;
    hide(true);
    this.visorCam.update(renderer, scene);
    hide(false);
    this.object.visible = true;
    renderer.shadowMap.autoUpdate = shadows;
  }

  /** Free the GPU resources (the suit surface itself is shared between EVAs). */
  dispose(): void {
    this.visorRT.dispose();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m !== this.mesh) m.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
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
