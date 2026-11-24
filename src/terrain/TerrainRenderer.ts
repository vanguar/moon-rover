import * as THREE from 'three';
import type { QualitySettings } from '../config';
import { makeLunar, NOISE_GLSL } from '../render/lunar';
import { chunkIndex } from './chunkIndex';
import type { TerrainData } from './TerrainData';
import type { BuildResult } from './terrainWorker';

const CHUNK = 250;

interface Chunk {
  key: string;
  ix: number;
  iz: number;
  level: number;
  pending: number; // level being built, -1 if none
  mesh: THREE.Mesh | null;
}

/**
 * Streams terrain chunks around the camera. Each chunk picks a LOD level from its
 * distance; geometry is built in web workers; skirts hide cracks between levels.
 */
export class TerrainRenderer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshLambertMaterial;
  readonly uniforms: {
    uRover: { value: THREE.Vector2 };
    uRtRange: { value: number };
    uLodD: { value: THREE.Vector4 };
    /** Direction to the Sun (world), for sub-pixel cast shadows of pebbles and craterlets. */
    uSun: { value: THREE.Vector3 };
    uSunShadow: { value: THREE.Vector3 };
    uBaked: { value: THREE.Texture };
    uFarShadow: { value: THREE.Texture };
    uOne: { value: number };
    /** Mars: share of diffuse light (1 − direct transmission); fades photographed shading. */
    uDiffuse: { value: number };
    uDet: { value: THREE.Texture | null };
    uDetRect: { value: THREE.Vector4 };
    uDetSlots: { value: Float32Array };
    uDetRes: { value: number };
    uDetSlopes: { value: number };
  };
  private chunks = new Map<string, Chunk>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private jobs = new Map<number, { chunk: Chunk; level: number; worker: number }>();
  private nextId = 1;
  private q: QualitySettings;
  private mars: boolean;

  constructor(
    terrain: TerrainData,
    ortho: THREE.Texture,
    baked: THREE.Texture,
    quality: QualitySettings,
    orthoHi?: THREE.Texture,
    farShadow?: THREE.Texture,
    farAlbedo?: THREE.Texture,
  ) {
    this.q = quality;
    const meta = terrain.meta;
    this.mars = meta.body === 'mars';
    for (const t of [ortho, baked]) {
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.flipY = false;
      t.needsUpdate = true;
    }
    ortho.colorSpace = THREE.SRGBColorSpace;
    const hiRect = new THREE.Vector4(0, 0, 1, 0);
    if (orthoHi && meta.orthoHi) {
      orthoHi.flipY = false;
      orthoHi.colorSpace = THREE.SRGBColorSpace;
      orthoHi.anisotropy = 8;
      orthoHi.wrapS = orthoHi.wrapT = THREE.ClampToEdgeWrapping;
      orthoHi.needsUpdate = true;
      const h = meta.orthoHi;
      hiRect.set(h.x - h.size / 2, h.z - h.size / 2, h.size, 1);
    }
    const dtmNormals = this.buildNormalTexture(terrain);
    ortho.anisotropy = 8;
    ortho.generateMipmaps = true;
    ortho.minFilter = THREE.LinearMipmapLinearFilter;

    this.uniforms = {
      uRover: { value: new THREE.Vector2() },
      uRtRange: { value: quality.shadowRange },
      uLodD: { value: new THREE.Vector4(...quality.lodDistances) },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uSunShadow: { value: new THREE.Vector3(1, 0, 0) },
      uBaked: { value: baked },
      uFarShadow: { value: farShadow ?? baked },
      uOne: { value: 1 },
      uDiffuse: { value: 0 },
      uDet: { value: null },
      uDetRect: { value: new THREE.Vector4(0, 0, 256, 0) },
      uDetSlots: { value: new Float32Array(9).fill(-1) },
      uDetRes: { value: 512 },
      uDetSlopes: { value: 0 },
    };
    const u = this.uniforms;
    this.material = makeLunar(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'terrain', (shader) => {
      shader.defines = { ...(shader.defines ?? {}), CRATERLETS: this.craterletLevel(), MARS: this.mars ? 1 : 0 };
      Object.assign(shader.uniforms, {
        uOrtho: { value: ortho },
        uBaked: u.uBaked,
        uMapSize: { value: new THREE.Vector2(meta.sizeX, meta.sizeZ) },
        uOrthoHi: { value: orthoHi ?? ortho },
        uHi: { value: hiRect },
        uDtmN: { value: dtmNormals },
        uNearN: { value: quality.lodDistances[1] },
        uFarShadow: u.uFarShadow,
        uFarHalf: { value: terrain.far ? terrain.far.half : 1e6 },
        uHasFar: { value: farShadow && terrain.far ? 1 : 0 },
        uFarAlb: { value: farAlbedo ?? ortho },
        uHasFarAlb: { value: farAlbedo ? 1 : 0 },
        uRover: u.uRover,
        uRtRange: u.uRtRange,
        uLodD: u.uLodD,
        uSunShadow: u.uSunShadow,
        uOne: u.uOne,
        uFive: { value: 5 },
        uDiffuse: u.uDiffuse,
        uDet: u.uDet,
        uDetRect: u.uDetRect,
        uDetSlots: u.uDetSlots,
        uDetRes: u.uDetRes,
        uDetSlopes: u.uDetSlopes,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;\nvarying vec3 vNormalW;\nattribute vec2 aMorph;\nuniform vec4 uLodD;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
// Geomorphing: toward the far end of its LOD range a vertex slides onto the next
// coarser surface, so the switch to the coarser mesh is invisible (no popping).
{
  vec2 wxz = (modelMatrix * vec4(transformed, 1.0)).xz;
  float lodT = aMorph.y < 0.5 ? uLodD.x : aMorph.y < 1.5 ? uLodD.y : aMorph.y < 2.5 ? uLodD.z : uLodD.w;
  float dCam = length(wxz - cameraPosition.xz);
  transformed.y += aMorph.x * smoothstep(0.62 * lodT, 0.94 * lodT, dCam);
}`,
        )
        .replace(
          '#include <fog_vertex>',
          '#include <fog_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvNormalW = normalize(mat3(modelMatrix) * objectNormal);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldP;
varying vec3 vNormalW;
uniform sampler2D uOrtho;
uniform sampler2D uBaked;
uniform vec2 uMapSize;
uniform vec2 uRover;
uniform float uRtRange;
uniform sampler2D uOrthoHi;
uniform vec4 uHi;
uniform sampler2D uDtmN;
uniform float uNearN;
uniform sampler2D uFarShadow;
uniform float uFarHalf;
uniform float uHasFar;
uniform sampler2D uFarAlb;
uniform float uHasFarAlb;
// Loop bounds come from uniforms (always 1 / 5): the D3D shader compiler (ANGLE on
// Windows) would otherwise unroll the nested loops into a huge program that takes
// seconds to compile at start-up.
uniform int uOne;
uniform int uFive;
uniform vec3 uSunShadow; // (horizontal direction to the Sun, cot(elevation))
uniform float uDiffuse;
uniform sampler2D uDet;
uniform vec4 uDetRect;
uniform float uDetSlots[9];
uniform float uDetRes;
uniform float uDetSlopes;
// Set by the photo-tile block, used for the normal: 1 m DTM slopes and their weight.
vec2 gDetSlope = vec2(0.0);
float gDetW = 0.0;
// 1 m DTM slope at a world point from the tile atlas (w = 0 if that tile is not loaded).
vec2 detSlopeAt(vec2 p, out float ok) {
  vec2 tp = (p - uDetRect.xy) / uDetRect.z;
  vec2 ij = floor(tp);
  vec2 sl = mod(ij, 3.0);
  int si = int(sl.x + sl.y * 3.0 + 0.5);
  ok = abs(uDetSlots[si] - (ij.x + ij.y * 4096.0)) < 0.5 ? 1.0 : 0.0;
  float h = 0.5 / uDetRes;
  vec2 sv = texture2D(uDet, sl / 3.0 + clamp(fract(tp), h, 1.0 - h) / 3.0).gb * 2.0 - 1.0;
  return sign(sv) * sv * sv * 2.0;
}
${NOISE_GLSL}
// Cast shadows of sub-metre craters (low Sun: the up-Sun inner wall is in shadow).
// Marches the bowl profile toward the Sun; returns 1 lit .. 0 shadowed.
float craterShadow(vec2 p, float cell, float seed, vec2 s2, float tanEl) {
  vec2 c = floor(p / cell);
  float lit = 1.0;
  for (int j = -uOne; j <= uOne; j++) {
    for (int i = -uOne; i <= uOne; i++) {
      vec2 id = mod(c + vec2(float(i), float(j)), 4096.0);
      if (lhash12(id + seed) > 0.32) continue;
      vec2 ctr = (c + vec2(float(i), float(j)) + vec2(lhash12(id + seed + 17.3), lhash12(id + seed + 41.7))) * cell;
      float R = cell * (0.12 + 0.33 * lhash12(id + seed + 7.1));
      vec2 d = p - ctr;
      if (dot(d, d) > R * R) continue;
      float fresh = lhash12(id + seed + 3.3);
      float depth = 2.0 * R * (0.025 + 0.09 * fresh * fresh);
      float rim = depth * (0.12 + 0.25 * fresh);
      float q0 = length(d) / R, b0 = 1.0 - q0 * q0;
      float h0 = -depth * b0 * b0;
      for (int k = 1; k <= uFive; k++) {
        float sk = float(k) * 0.4 * R;
        float q = length(d + s2 * sk) / R;
        float b = max(1.0 - q * q, 0.0);
        float e = (q - 1.0) / 0.38;
        float hk = -depth * b * b + rim * exp(-e * e);
        lit = min(lit, smoothstep(-0.004, 0.004, h0 + sk * tanEl - hk));
      }
    }
  }
  return lit;
}
// Lunar rock fragments lying on the regolith: one irregular clast per occupied cell.
// Returns (dh/dx, dh/dz, coverage, cast shadow on the soil: 1 lit .. 0); tone = clast albedo factor.
vec4 clastField(vec2 p, float cell, float seed, float density, vec2 s2, float cotEl, out float tone) {
  vec2 c = floor(p / cell);
  vec4 acc = vec4(0.0, 0.0, 0.0, 1.0);
  float best = 0.0;
  tone = 1.0;
  for (int j = -uOne; j <= uOne; j++) {
    for (int i = -uOne; i <= uOne; i++) {
      vec2 id = mod(c + vec2(float(i), float(j)), 4096.0);
      if (lhash12(id + seed) > density) continue;
      vec2 ctr = (c + vec2(float(i), float(j)) + vec2(lhash12(id + seed + 5.1), lhash12(id + seed + 9.7))) * cell;
      // Size-frequency: many small fragments, few large ones.
      float R = cell * (0.06 + 0.26 * pow(lhash12(id + seed + 2.3), 2.6));
      vec2 d = p - ctr;
      // Cheap reject: beyond the clast and its longest possible shadow.
      float reach = R * 1.4 + min(R * cotEl, 3.0 * cell);
      if (dot(d, d) > reach * reach) continue;
      float a = lhash12(id + seed + 7.7) * 6.2832;
      vec2 e = vec2(dot(d, vec2(cos(a), sin(a))), dot(d, vec2(-sin(a), cos(a)))) * vec2(1.0, 1.0 + 0.7 * lhash12(id + seed + 1.9));
      float ang = atan(e.y, e.x);
      // Angular outline (impact fragments are blocky, not round).
      float r = length(e) * (1.0 + 0.16 * sin(ang * 3.0 + lhash12(id + seed + 3.3) * 6.28) + 0.1 * sin(ang * 5.0 + seed) + 0.05 * sin(ang * 9.0));
      float H = R * (0.55 + 0.45 * lhash12(id + seed + 4.4));
      if (r < R) {
        float q = r / R;
        float k = sqrt(max(1.0 - q * q, 1e-3));
        float h = H * k;
        if (h > best) {
          best = h;
          // Rounded-blocky profile; faceted by a little noise so tops are not flat plates.
          float sl = clamp(-H / R * q / max(k, 0.12), -5.0, 5.0);
          vec3 fn = lnoised((p - ctr) / R * 2.3 + id);
          acc.xy = (r > 1e-5 ? d / length(d) : vec2(0.0)) * sl + fn.yz * 0.35;
          acc.z = smoothstep(1.0, 0.86, q);
          // Breccias and anorthosite are brighter than the soil, basalts darker; dust-coated tops.
          // Basalt (darker) to breccia/anorthosite (brighter) than the soil; mottled grain.
          tone = (0.55 + 0.75 * lhash12(id + seed + 6.6)) * (0.8 + 0.4 * fn.x) * (0.85 + 0.3 * lnoised(p * 90.0 + id).x);
        }
      } else {
        // Shadow of the clast on the soil, swept down-Sun (length H·cot(elevation)).
        float L = min(H * cotEl, 3.0 * cell);
        float t = dot(d, -s2);
        float perp = length(d + s2 * t);
        float w = R * 0.85 * sqrt(max(1.0 - t / (L + 0.5 * R), 0.0));
        if (t > 0.0 && w > 1e-4) acc.w = min(acc.w, smoothstep(w * 0.75, w, perp)); // (smoothstep with equal edges is undefined)
      }
    }
  }
  return acc;
}
// Sub-metre craters (below DTM and mesh resolution): one random crater per cell,
// parabolic bowl + raised rim; returns (height, d/dx, d/dz).
vec3 craterField(vec2 p, float cell, float seed) {
  vec2 c = floor(p / cell);
  vec3 acc = vec3(0.0);
  for (int j = -uOne; j <= uOne; j++) {
    for (int i = -uOne; i <= uOne; i++) {
      vec2 id = mod(c + vec2(float(i), float(j)), 4096.0);
      if (lhash12(id + seed) > 0.32) continue;
      vec2 ctr = (c + vec2(float(i), float(j)) + vec2(lhash12(id + seed + 17.3), lhash12(id + seed + 41.7))) * cell;
      float R = cell * (0.12 + 0.33 * lhash12(id + seed + 7.1));
      vec2 d = p - ctr;
      float r = length(d);
      if (r > 2.0 * R) continue;
      float q = r / R;
      float fresh = lhash12(id + seed + 3.3);
      float depth = 2.0 * R * (0.025 + 0.09 * fresh * fresh);
      float rim = depth * (0.12 + 0.25 * fresh);
      float h = 0.0, dh = 0.0;
      if (q < 1.0) { float b = 1.0 - q * q; h -= depth * b * b; dh += 4.0 * depth * q * b; }
      float e = (q - 1.0) / 0.38;
      float g = exp(-e * e);
      h += rim * g;
      dh += rim * g * (-2.0 * e / 0.38);
      acc += vec3(h, (r > 1e-4 ? d / r : vec2(0.0)) * dh / R);
    }
  }
  return acc;
}
// Cubic B-spline texture filtering from 4 bilinear taps (Sigg & Hadwiger): smooth
// magnification without the diamond/stair pattern of plain bilinear filtering.
vec4 texBicubic(sampler2D t, vec2 uv) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 st = uv * sz - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 1.0 + i + 0.5) / sz, h1 = (w3 / g1 + 1.0 + i + 0.5) / sz;
  // Mip selection from the smooth uv, not from the tap coordinates: those jump at
  // texel borders and would pick a blurry mip there (a grid of squares on the ground).
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  return g0.y * (g0.x * textureGrad(t, vec2(h0.x, h0.y), gx, gy) + g1.x * textureGrad(t, vec2(h1.x, h0.y), gx, gy))
       + g1.y * (g0.x * textureGrad(t, vec2(h0.x, h1.y), gx, gy) + g1.x * textureGrad(t, vec2(h1.x, h1.y), gx, gy));
}
// Pebbles and gravel (Mars): one rounded clast per cell with a random size,
// elongation and orientation; returns (height, d/dx, d/dz, coverage).
vec4 pebbleField(vec2 p, float cell, float seed, float density) {
  vec2 c = floor(p / cell);
  vec4 acc = vec4(0.0);
  for (int j = -uOne; j <= uOne; j++) {
    for (int i = -uOne; i <= uOne; i++) {
      vec2 id = mod(c + vec2(float(i), float(j)), 4096.0);
      if (lhash12(id + seed) > density) continue;
      vec2 ctr = (c + vec2(float(i), float(j)) + vec2(lhash12(id + seed + 5.1), lhash12(id + seed + 9.7))) * cell;
      float R = cell * (0.12 + 0.3 * pow(lhash12(id + seed + 2.3), 1.8));
      float a = lhash12(id + seed + 7.7) * 6.2832;
      vec2 d = p - ctr;
      vec2 e = vec2(dot(d, vec2(cos(a), sin(a))), dot(d, vec2(-sin(a), cos(a)))) * vec2(1.0, 1.0 + 0.6 * lhash12(id + seed + 1.9));
      // Irregular outline: the radius wobbles with direction.
      float ang = atan(e.y, e.x);
      float r = length(e) * (1.0 + 0.18 * sin(ang * 3.0 + lhash12(id + seed + 3.3) * 6.28) + 0.08 * sin(ang * 5.0 + seed));
      if (r >= R) continue;
      float q = r / R;
      float k = sqrt(max(1.0 - q * q, 1e-3));
      float h = 0.55 * R * k;
      if (h > acc.x) {
        float dh = -0.55 * q / k;
        acc.x = h;
        acc.yz = (r > 1e-5 ? d / r : vec2(0.0)) * dh;
        acc.w = smoothstep(1.0, 0.82, q);
      }
    }
  }
  return acc;
}`,
        )
        .replace(
          '#include <map_fragment>',
          `float microLit = 1.0;
vec2 mapUv = (vWorldP.xz + 0.5 * uMapSize) / uMapSize;
// Inside the DTM window: 1; outside (SLDEM terrain): 0, with a 150 m blend.
vec2 edgeD = 0.5 * uMapSize - abs(vWorldP.xz);
float wIn = uHasFar > 0.5 ? smoothstep(0.0, 150.0, min(edgeD.x, edgeD.y)) : 1.0;
// Orthophoto is a high-sun image: its brightness is mostly albedo.
// Outside the window use its mean (top mip) as a neutral mare albedo.
float outside = uHasFarAlb > 0.5 ? texture2D(uFarAlb, (vWorldP.xz + uFarHalf) / (2.0 * uFarHalf)).r : textureLod(uOrtho, vec2(0.5), 12.0).r;
float ortho = mix(outside, texBicubic(uOrtho, mapUv).r, wIn);
if (uHi.w > 0.5) {
  vec2 hu = (vWorldP.xz - uHi.xy) / uHi.z;
  vec2 e = smoothstep(vec2(0.0), vec2(0.03), hu) * smoothstep(vec2(0.0), vec2(0.03), 1.0 - hu);
  float wHi = e.x * e.y;
  if (wHi > 0.0) ortho = mix(ortho, texBicubic(uOrthoHi, clamp(hu, 0.0, 1.0)).r, wHi);
}
// Full-resolution photo tiles around the rover (HiRISE 25 cm / NAC 50 cm), where a
// screen pixel is small enough to show them. Brightness matched to the base photo
// by their local means (the base map has frame seams removed).
if (uDetRect.w > 0.5) {
  vec2 tp = (vWorldP.xz - uDetRect.xy) / uDetRect.z;
  vec2 ij = floor(tp);
  vec2 sl = mod(ij, 3.0);
  int si = int(sl.x + sl.y * 3.0 + 0.5);
  float want = ij.x + ij.y * 4096.0;
  float texM = uDetRect.z / uDetRes;
  float fpD = length(fwidth(vWorldP.xz));
  float wD = (abs(uDetSlots[si] - want) < 0.5 ? 1.0 : 0.0) * (1.0 - smoothstep(texM * 2.0, texM * 6.0, fpD));
  if (wD > 0.0) {
    vec2 lc = fract(tp);
    // Fade the outer 2 % of each tile: no seam where a neighbour is still loading.
    wD *= smoothstep(0.0, 0.02, min(min(lc.x, 1.0 - lc.x), min(lc.y, 1.0 - lc.y))) * 0.6 + 0.4;
    float h = 0.5 / uDetRes;
    vec2 base = sl / 3.0;
    vec3 detT = texture2D(uDet, base + clamp(lc, h, 1.0 - h) / 3.0).rgb;
    // The atlas holds raw bytes: albedo is sRGB-encoded, slopes are square-root coded.
    float det = pow(detT.r, 2.2);
    if (uDetSlopes > 0.5) {
      vec2 sv = detT.gb * 2.0 - 1.0;
      gDetSlope = sign(sv) * sv * sv * 2.0;
      gDetW = wD;
      // Cast shadows of the metre-scale relief: integrate the height along the Sun
      // direction from the slopes (dh = slope · dir · ds) and compare with the ray.
      float tanEl = 1.0 / max(uSunShadow.z, 0.03);
      float rise = 0.0, lit = 1.0, ds = 1.0;
      // 6 steps of 1 m (the slope data is 1 m): ~2 ms on an integrated GPU, near the rover only.
      if (fpD < texM * 2.5) for (int k = 1; k <= uFive + uOne; k++) {
        float dist = float(k) * ds;
        float okS;
        vec2 sl2 = detSlopeAt(vWorldP.xz + uSunShadow.xy * dist, okS);
        rise += dot(sl2, uSunShadow.xy) * ds * okS;
        lit = min(lit, smoothstep(-0.03, 0.06, dist * tanEl - rise + 0.02));
      }
      microLit = min(microLit, mix(1.0, lit, wD));
    }
    float o = 6.0 / uDetRect.z / 3.0;
    float detLow = 0.25 * (pow(texture2D(uDet, base + clamp(lc + vec2(o * 3.0, 0.0), h, 1.0 - h) / 3.0).r, 2.2)
                        + pow(texture2D(uDet, base + clamp(lc - vec2(o * 3.0, 0.0), h, 1.0 - h) / 3.0).r, 2.2)
                        + pow(texture2D(uDet, base + clamp(lc + vec2(0.0, o * 3.0), h, 1.0 - h) / 3.0).r, 2.2)
                        + pow(texture2D(uDet, base + clamp(lc - vec2(0.0, o * 3.0), h, 1.0 - h) / 3.0).r, 2.2));
    float baseLow = textureLod(uOrtho, mapUv, 3.0).r;
    det *= clamp(baseLow / max(detLow, 0.01), 0.5, 2.0);
    ortho = mix(ortho, det, wD);
  }
}
// Regolith micro-relief: 5 octaves from 4 m down to ~5 cm, faded below pixel size.
float fp = max(length(fwidth(vWorldP.xz)), 1e-4);
vec2 grad = vec2(0.0);
float albedoVar = 0.0;
float freq = 0.3, amp = 0.16;
for (int o = 0; o < 6; o++) {
  float w = clamp(1.6 - fp * freq * 2.5, 0.0, 1.0);
  // Each octave in its own rotated frame: value noise on an axis-aligned lattice
  // otherwise shows up as squares.
  float ra = float(o) * 1.13 + 0.4;
  mat2 rot = mat2(cos(ra), sin(ra), -sin(ra), cos(ra));
  vec3 nd = lnoised(rot * vWorldP.xz * freq + float(o) * 17.13);
  nd.yz = nd.yz * rot;
#if MARS > 0
  // HiRISE DTM (1 m) already holds the metre-scale relief: only sub-metre octaves here,
  // or a low evening Sun turns them into fake "plasticine" waves.
  grad += nd.yz * amp * freq * w * (o < 3 ? 0.12 : 0.6);
#else
  grad += nd.yz * amp * freq * w;
#endif
  albedoVar += (nd.x - 0.5) * w * (o < 3 ? 0.10 : 0.05);
  freq *= 2.6; amp *= 0.33;
}
// Craterlets: 0.6 m and 2 m cells, faded when smaller than a pixel.
#if CRATERLETS > 0
float wc1 = clamp(1.5 - fp * 1.5, 0.0, 1.0);
if (wc1 > 0.0) grad += craterField(vWorldP.xz, 2.2, 11.0).yz * wc1;
#endif
#if CRATERLETS > 1
float wc2 = clamp(1.5 - fp * 5.0, 0.0, 1.0);
if (wc2 > 0.0) grad += craterField(vWorldP.xz, 0.7, 29.0).yz * wc2;
#endif
#if MARS > 0
// In a dust storm the light is diffuse: shading still left in the HiRISE photograph
// (ripples below the DTM resolution) must not read as shadows — fade it to the local mean.
ortho = mix(ortho, textureLod(uOrthoHi, clamp((vWorldP.xz - uHi.xy) / uHi.z, 0.0, 1.0), 4.0).r, uDiffuse * 0.75 * step(0.5, uHi.w));
// Mars: dark basaltic sand and rock vs. bright ferric dust (HiRISE RED is a panchromatic albedo).
// The broad noise octaves are muted here: the HiRISE albedo already carries the large-scale pattern.
float alb = clamp(ortho * 0.9 + albedoVar * 0.08, 0.02, 1.0);
// (linear) Stretch the contrast around the scene mean; Mars is about twice as bright as the lunar mare.
// Seen from the ground the plain is evener than in the orbital image (the albedo
// contrast of dust vs. sand is compressed by the low view angle and forward scattering).
alb = clamp(0.135 + (alb - 0.135) * 0.8, 0.015, 1.0);
// Two materials, not light and shadow: dark basaltic sand is nearly neutral grey
// (slightly cool), bright ferric dust is a warm butterscotch. The fraction follows the
// albedo relative to its surroundings, so every dark patch also changes hue.
float aLocal = textureLod(uOrtho, mapUv, 5.0).r * 0.9;
float dustF = smoothstep(0.82, 1.18, alb / max(aLocal, 0.01));
vec3 darkSoil = vec3(0.66, 0.6, 0.57), brightDust = vec3(1.3, 0.84, 0.54);
// Brightness difference kept smaller than in the orbital photo; the hue carries it.
float albM = mix(aLocal, alb, 0.75);
diffuseColor.rgb = albM * mix(darkSoil, brightDust, dustF) * 1.9;
// Wind ripples (~12 cm wavelength) across the sand, faded with distance; they lie on the dark sand.
// Sand covers the dark (low-albedo) areas; dust and pavement the bright ones.
float sandy = 1.0 - dustF;
float wr = clamp(1.6 - fp * 9.0, 0.0, 1.0) * sandy;
if (wr > 0.0) {
  // Asymmetric wind ripples (gentle stoss, steep lee), wavelength ~12 cm, crests wander.
  vec2 rd = vec2(0.94, 0.34);
  float ph = dot(vWorldP.xz, rd) * 52.0 + lnoised(vWorldP.xz * 0.9).x * 7.0 + lnoised(vWorldP.xz * 3.1 + 4.0).x * 2.0;
  // Skewed sine: h = sin(φ + 0.55·sin φ) — gentle stoss, steeper lee, continuous slope (no steps).
  float sk = ph + 0.55 * sin(ph);
  float slopeR = cos(sk) * (1.0 + 0.55 * cos(ph));
  grad += rd * slopeR * 0.06 * wr;
  diffuseColor.rgb *= 1.0 + 0.04 * wr * sin(sk);
}
// Pebbles and gravel lying on the surface (Jezero floor): two size classes, more on the
// pavement than in the sand; dark basalt with a thin dust coat on top.
float wp1 = clamp(1.6 - fp * 3.5, 0.0, 1.0);
float wp2 = clamp(1.6 - fp * 10.0, 0.0, 1.0);
float pebbleMask = 0.0;
if (wp1 > 0.0) {
  vec4 pb = pebbleField(vWorldP.xz, 0.3, 61.0, mix(0.16, 0.06, sandy));
  grad += pb.yz * wp1 * 0.8;
  pebbleMask = max(pebbleMask, pb.w * wp1);
}
if (wp2 > 0.0) {
  vec4 pg = pebbleField(vWorldP.xz, 0.09, 83.0, mix(0.4, 0.18, sandy));
  grad += pg.yz * wp2 * 0.6;
  pebbleMask = max(pebbleMask, pg.w * wp2 * 0.85);
}
// Fine granule speckle below the pebbles.
float wsp = clamp(1.5 - fp * 25.0, 0.0, 1.0);
// Granule speckle: smooth noise (cell hashes drew visible squares from a low camera).
if (wsp > 0.0) diffuseColor.rgb *= 1.0 + (lnoised(mat2(0.8, 0.6, -0.6, 0.8) * vWorldP.xz * 55.0).x - 0.5) * 0.22 * wsp;
// Clasts: dark grey basalt, partly dust-coated (varies clast to clast).
vec3 basalt = vec3(0.075, 0.062, 0.055) * (0.8 + 0.5 * lnoised(vWorldP.xz * 9.0 + 3.7).x);
diffuseColor.rgb = mix(diffuseColor.rgb, mix(basalt, diffuseColor.rgb, 0.3), pebbleMask * 0.8);
#else
// Lunar regolith: a nearly neutral, faintly warm grey (reflectance rises slowly toward the red).
// Calibrated on Apollo 15 Hasselblad frames (docs/REALISM.md): ground/massif brightness ratio ≈ 1 : 1.6.
vec3 regolith = vec3(1.0, 0.985, 0.965) * 1.5;
// Albedo variation is relative (±~18 %), not added: in dark areas an additive term
// dominated the photo and drew the noise lattice.
float alb = clamp(ortho * 0.9 * (1.0 + albedoVar * 1.2), 0.005, 1.0);
// Soft shoulder above ~1.35× the local mean: the brightest photo patches (fresh ejecta,
// the LM's blast zone) are only 10–40 % brighter in true albedo than the mature soil.
float aMean = textureLod(uOrtho, mapUv, 7.0).r * 0.9;
float aRel = alb / max(aMean, 0.01);
alb = aMean * (aRel < 1.35 ? aRel : 1.35 + (aRel - 1.35) * 0.35);
diffuseColor.rgb = regolith * alb;
// Sun geometry for sub-pixel cast shadows.
vec2 s2 = uSunShadow.xy;
float cotEl = uSunShadow.z;
microLit = 1.0;
// Cast shadows inside craterlets: the most expensive part of the shader (9 cells ×
// 5 march steps), only on High and Ultra.
#if CRATERLETS > 1
if (wc1 > 0.0) microLit = min(microLit, mix(1.0, craterShadow(vWorldP.xz, 2.2, 11.0, s2, 1.0 / cotEl), wc1));
#endif
#if CRATERLETS > 2
if (wc2 > 0.0) microLit = min(microLit, mix(1.0, craterShadow(vWorldP.xz, 0.7, 29.0, s2, 1.0 / cotEl), wc2));
#endif
// Rock fragments and clods: more on bright (fresh, blocky) ejecta, as on every Apollo
// surface photograph; brighter than the soil, with hard shadows down-Sun.
float fresh = smoothstep(0.9, 1.6, ortho / max(textureLod(uOrtho, mapUv, 6.0).r, 0.02));
float wl1 = clamp(1.6 - fp * 2.2, 0.0, 1.0);
float wl2 = clamp(1.6 - fp * 7.0, 0.0, 1.0);
float clastMask = 0.0, clastTone = 1.0, tn;
if (wl1 > 0.0) {
  vec4 cl = clastField(vWorldP.xz, 0.55, 61.0, mix(0.07, 0.3, fresh), s2, cotEl, tn);
  grad += cl.xy * wl1;
  clastMask = cl.z * wl1;
  clastTone = tn;
  microLit = min(microLit, mix(1.0, cl.w, wl1));
}
#if CRATERLETS < 2
wl2 = 0.0; // fine gravel only on High and Ultra
#endif
if (wl2 > 0.0) {
  vec4 cg = clastField(vWorldP.xz, 0.14, 83.0, mix(0.22, 0.45, fresh), s2, cotEl, tn);
  grad += cg.xy * wl2 * 0.8;
  if (cg.z * wl2 > clastMask) { clastMask = cg.z * wl2 * 0.9; clastTone = tn; }
  microLit = min(microLit, mix(1.0, cg.w, wl2 * 0.9));
}
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * clastTone * 1.15, clastMask);
// Granular speckle of the soil itself (cm-sized aggregates).
float wsp = clamp(1.5 - fp * 25.0, 0.0, 1.0);
if (wsp > 0.0) {
  vec3 gn = lnoised(vWorldP.xz * 38.0);
  grad += gn.yz * 0.012 * wsp;
  diffuseColor.rgb *= 1.0 + (lnoised(mat2(0.8, 0.6, -0.6, 0.8) * vWorldP.xz * 70.0).x - 0.5) * 0.16 * wsp;
}
#endif
// Baked far-field cast shadow of the DTM; faded out where the real-time shadow map is valid.
float baked = texBicubic(uBaked, mapUv).r;
// Near the rover only large-scale DTM shadows come from the bake (soft, 2 m);
// fine shadows come from the real-time map.
float rtW = 1.0 - smoothstep(uRtRange * 0.5, uRtRange * 0.8, length(vWorldP.xz - uRover));
// The mask already carries the physical penumbra of the solar disc.
float bakedSun = smoothstep(0.02, 0.98, baked);
rtW *= 0.0; // the same mask everywhere: no edge where the real-time shadow map ends
if (wIn < 1.0) {
  float farS = smoothstep(0.02, 0.98, texture2D(uFarShadow, (vWorldP.xz + uFarHalf) / (2.0 * uFarHalf)).r);
  bakedSun = mix(farS, bakedSun, wIn);
}
bakedSun *= microLit;`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
// Far away the mesh is coarse: take the surface orientation from the 2 m DTM normal map.
vec2 sl = (texBicubic(uDtmN, mapUv).rg - 0.5) * 2.0;
sl = sign(sl) * sl * sl * 5.0;
// Mirrored tiles outside the DTM window flip the slope sign.
sl *= 1.0 - 2.0 * mod(floor(mapUv), 2.0);
vec3 nDtm = normalize(vec3(-sl.x, 1.0, -sl.y));
float farW = smoothstep(uNearN * 0.5, uNearN, length(vWorldP.xz - cameraPosition.xz));
vec3 nBase = normalize(mix(normalize(vNormalW), nDtm, farW * wIn));
// Near the rover on Mars: relief shading from the 1 m HiRISE DTM (the mesh is 2 m).
if (gDetW > 0.0) nBase = normalize(mix(nBase, normalize(vec3(-gDetSlope.x, 1.0, -gDetSlope.y)), gDetW * 0.85));
vec3 nW = normalize(nBase - vec3(grad.x, 0.0, grad.y));
normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`,
        )
        .replace(
          '#include <lights_fragment_begin>',
          THREE.ShaderChunk.lights_fragment_begin.replace(
            'getDirectionalLightInfo( directionalLight, directLight );',
            'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= bakedSun;',
          ),
        );
    });

    const nWorkers = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < nWorkers; i++) {
      const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', meta, heights: terrain.heights, far: terrain.far });
      w.onmessage = (e: MessageEvent<BuildResult>) => this.onBuilt(i, e.data);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  private craterletLevel(): number {
    if (this.mars) return this.q.level === 'low' || this.q.level === 'medium' ? 0 : 1;
    return this.q.level === 'low' ? 0 : this.q.level === 'medium' ? 1 : this.q.level === 'high' ? 2 : 3;
  }

  /** 2 m slope map of the DTM (RG8: dh/dx, dh/dz) for per-pixel normals at distance. */
  private buildNormalTexture(t: TerrainData): THREE.DataTexture {
    const w = t.w, h = t.h, px = t.meta.pixelSize;
    const data = new Uint8Array(w * h * 2);
    const H = t.heights, k = t.hScale;
    for (let j = 0; j < h; j++) {
      const j0 = Math.max(0, j - 1), j1 = Math.min(h - 1, j + 1);
      for (let i = 0; i < w; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(w - 1, i + 1);
        const sx = ((H[j * w + i1] - H[j * w + i0]) * k) / ((i1 - i0) * px);
        const sz = ((H[j1 * w + i] - H[j0 * w + i]) * k) / ((j1 - j0) * px);
        const o = (j * w + i) * 2;
        // Square-root encoding: fine steps near zero slope, where nearly all the ground
        // is (linear 8-bit steps of 0.02 drew contour-like banding at low Sun).
        const enc = (v: number) => Math.sign(v) * Math.sqrt(Math.min(Math.abs(v) / 5, 1));
        data[o] = Math.max(0, Math.min(255, Math.round((enc(sx) * 0.5 + 0.5) * 255)));
        data[o + 1] = Math.max(0, Math.min(255, Math.round((enc(sz) * 0.5 + 0.5) * 255)));
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  /** Terrain cast-shadow masks recomputed for the current Sun (ShadowBaker). */
  setShadowMaps(near: THREE.Texture, far: THREE.Texture | null): void {
    this.uniforms.uBaked.value = near;
    if (far) this.uniforms.uFarShadow.value = far;
  }

  /** Attach the streamed full-resolution photo tiles. */
  setDetail(tex: THREE.Texture, rect: THREE.Vector4, slots: Float32Array, res: number, slopes = false): void {
    const u = this.uniforms;
    u.uDetSlopes.value = slopes ? 1 : 0;
    u.uDet.value = tex;
    u.uDetRect.value = rect;
    u.uDetSlots.value = slots;
    u.uDetRes.value = res;
  }

  /** Sun direction (world, unit) for the sub-pixel cast shadows. */
  setSun(dir: THREE.Vector3): void {
    this.uniforms.uSun.value.copy(dir);
    const h = Math.hypot(dir.x, dir.z) || 1e-6;
    this.uniforms.uSunShadow.value.set(dir.x / h, dir.z / h, Math.min(30, h / Math.max(dir.y, 0.02)));
  }

  setQuality(q: QualitySettings): void {
    this.q = q;
    this.uniforms.uRtRange.value = q.shadowRange;
    this.uniforms.uLodD.value.set(...(q.lodDistances as [number, number, number, number]));
    for (const c of this.chunks.values()) c.level = -1; // force rebuild at new LOD
    this.material.customProgramCacheKey = () => `lunar-terrain-${this.craterletLevel()}`;
    this.material.needsUpdate = true;
  }

  private levelFor(ix: number, iz: number, cam: THREE.Vector3): number {
    const x0 = ix * CHUNK - CHUNK / 2, z0 = iz * CHUNK - CHUNK / 2;
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + CHUNK));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + CHUNK));
    const d = Math.hypot(dx, dz);
    const t = this.q.lodDistances;
    let l = 0;
    while (l < t.length && d > t[l]) l++;
    return l;
  }

  /** Is the full-detail ground ready under the given point? */
  readyAt(x: number, z: number): boolean {
    const ix = Math.round(x / CHUNK), iz = Math.round(z / CHUNK);
    const c = this.chunks.get(`${ix},${iz}`);
    return !!c && c.mesh !== null;
  }

  pendingCount(): number {
    return this.jobs.size;
  }

  update(cam: THREE.Vector3, rover: THREE.Vector3): void {
    this.uniforms.uRover.value.set(rover.x, rover.z);
    const R = this.q.drawDistance;
    const i0 = Math.floor((cam.x - R) / CHUNK + 0.5), i1 = Math.ceil((cam.x + R) / CHUNK - 0.5);
    const j0 = Math.floor((cam.z - R) / CHUNK + 0.5), j1 = Math.ceil((cam.z + R) / CHUNK - 0.5);
    const want: { c: Chunk; level: number; d: number }[] = [];
    const seen = new Set<string>();
    for (let iz = j0; iz <= j1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const d = Math.hypot(ix * CHUNK - cam.x, iz * CHUNK - cam.z);
        if (d > R + CHUNK * 0.71) continue;
        const key = `${ix},${iz}`;
        seen.add(key);
        let c = this.chunks.get(key);
        if (!c) {
          c = { key, ix, iz, level: -1, pending: -1, mesh: null };
          this.chunks.set(key, c);
        }
        const level = this.levelFor(ix, iz, cam);
        if (c.level !== level && c.pending !== level) want.push({ c, level, d });
      }
    }
    for (const [key, c] of this.chunks) {
      if (!seen.has(key)) this.dispose(c);
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      const wi = this.freeWorker();
      if (wi < 0) break;
      this.request(w.c, w.level, wi);
    }
  }

  private freeWorker(): number {
    let best = -1;
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i] < 2 && (best < 0 || this.busy[i] < this.busy[best])) best = i;
    }
    return best;
  }

  private request(c: Chunk, level: number, wi: number): void {
    const id = this.nextId++;
    const segs = this.q.lodSegments[Math.min(level, this.q.lodSegments.length - 1)];
    c.pending = level;
    this.jobs.set(id, { chunk: c, level, worker: wi });
    this.busy[wi]++;
    this.workers[wi].postMessage({
      type: 'build', id, cx: c.ix * CHUNK, cz: c.iz * CHUNK, size: CHUNK, segs,
      skirt: 2 + (CHUNK / segs) * 1.5,
      level, morph: level < this.q.lodSegments.length - 1 && level < this.q.lodDistances.length,
    });
  }

  private onBuilt(wi: number, r: BuildResult): void {
    this.busy[wi]--;
    const job = this.jobs.get(r.id);
    this.jobs.delete(r.id);
    if (!job) return;
    const c = job.chunk;
    if (this.chunks.get(c.key) !== c) return; // disposed meanwhile
    if (c.pending === job.level) c.pending = -1;
    const n = this.q.lodSegments[Math.min(job.level, this.q.lodSegments.length - 1)];
    if ((n + 1) * (n + 1) + 4 * n !== r.positions.length / 3) return; // quality changed meanwhile
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3, true));
    g.setAttribute('aMorph', new THREE.BufferAttribute(r.morph, 2));
    g.setIndex(chunkIndex(n));
    const half = CHUNK / 2;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-half, r.minY, -half), new THREE.Vector3(half, r.maxY, half));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    if (c.mesh) {
      c.mesh.geometry.dispose();
      c.mesh.geometry = g;
    } else {
      const m = new THREE.Mesh(g, this.material);
      m.position.set(c.ix * CHUNK, 0, c.iz * CHUNK);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      c.mesh = m;
      this.group.add(m);
    }
    c.level = job.level;
    // Terrain shadows come from the GPU mask (2 m) and the shader's micro-shadows; the
    // real-time map holds only the rover, rocks and hardware, so its square edge never shows.
    c.mesh!.castShadow = false;
  }

  private dispose(c: Chunk): void {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    this.chunks.delete(c.key);
  }
}
