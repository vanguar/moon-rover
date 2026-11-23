import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Terrain cast shadows for a moving Sun, computed on the GPU.
 *
 * For every texel of the playable window (and of the 56 km SLDEM surroundings) a
 * ray is marched toward the Sun over the height field — first the 2 m window,
 * then the far grid — so mountains tens of kilometres away shadow the site as on
 * the real Moon. The Sun is a 0.53° disc, so the edge gets a physical penumbra
 * (≈ 0.9 cm per metre of distance to the occluder).
 *
 * The work is split into horizontal bands rendered over several frames; a new pass
 * starts whenever the Sun has moved more than 0.1° (12 s at ×60 time).
 */
const BANDS = 64;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uNear;   // window heights (m above min), R16F/R32F, row 0 = north
uniform sampler2D uFar;    // far grid heights (same datum), row 0 = north
uniform vec2 uNearHalf;    // half size of the window, m
uniform float uFarHalf;    // half size of the far grid, m
uniform vec2 uNearTexel;   // metres per texel of uNear
uniform float uFarTexel;
uniform vec3 uSun;         // unit vector toward the Sun (game frame)
uniform float uMaxH;       // highest point of the whole field
uniform float uFarPass;    // 1: output covers the far grid, 0: the window
uniform float uHasFar;

// Height textures are float (no hardware filtering on many GPUs): interpolate by hand.
// Nearest samples turn a slope into 112 m steps that shadow each other in blocks.
float bilinear(sampler2D t, vec2 uv) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 st = uv * sz - 0.5;
  vec2 i = floor(st), f = st - i;
  ivec2 m = ivec2(sz) - 1;
  ivec2 a = clamp(ivec2(i), ivec2(0), m), b = clamp(ivec2(i) + 1, ivec2(0), m);
  float h00 = texelFetch(t, a, 0).r, h10 = texelFetch(t, ivec2(b.x, a.y), 0).r;
  float h01 = texelFetch(t, ivec2(a.x, b.y), 0).r, h11 = texelFetch(t, b, 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
float nearH(vec2 p) { return bilinear(uNear, (p + uNearHalf) / (2.0 * uNearHalf)); }
float farH(vec2 p) { return bilinear(uFar, (p + uFarHalf) / (2.0 * uFarHalf)); }
bool inNear(vec2 p) { return all(lessThan(abs(p), uNearHalf)); }
float heightAt(vec2 p) {
  if (uFarPass < 0.5 && inNear(p)) return nearH(p);
  return uHasFar > 0.5 ? farH(p) : nearH(clamp(p, -uNearHalf, uNearHalf));
}

void main() {
  vec2 p0 = uFarPass > 0.5 ? (vUv * 2.0 - 1.0) * uFarHalf : (vUv * 2.0 - 1.0) * uNearHalf;
  // Start above the surface by a slope-aware margin (the grid cannot resolve the
  // exact surface between samples): no self-shadowing stripes on slopes.
  float texel = uFarPass > 0.5 ? uFarTexel : uNearTexel.x;
  vec2 sunH = normalize(uSun.xz + 1e-6);
  float slope = (heightAt(p0 + sunH * texel) - heightAt(p0 - sunH * texel)) / (2.0 * texel);
  float h0 = heightAt(p0) + 0.6 + max(slope, 0.0) * texel * 0.5 + texel * 0.01;
  float sinEl = uSun.y;
  if (sinEl <= -0.0046) { gl_FragColor = vec4(0.0); return; }
  vec2 dir = normalize(uSun.xz + 1e-6);
  float tanEl = sinEl / max(length(uSun.xz), 1e-4);
  // Penumbra: the solar disc's half-width as a slope (0.265°).
  const float PEN = 0.0046;
  float lit = 1.0;
  float d = 0.0;
  float step0 = uFarPass > 0.5 ? uFarTexel : uNearTexel.x;
  float ds = step0;
  for (int i = 0; i < 220; i++) {
    d += ds;
    vec2 p = p0 + dir * d;
    bool near = uFarPass < 0.5 && inNear(p);
    if (!near && (uHasFar < 0.5 || any(greaterThan(abs(p), vec2(uFarHalf))))) break;
    float ray = h0 + d * tanEl;
    if (ray > uMaxH) break;
    float h = near ? nearH(p) : farH(p);
    // Fraction of the solar disc above the local horizon at this occluder.
    float k = (ray - h) / (d * PEN * 2.0) + 0.5;
    lit = min(lit, clamp(k, 0.0, 1.0));
    if (lit <= 0.0) break;
    // Fine steps near the point, longer ones far away (relative precision stays constant).
    ds = max(step0, d * 0.025) * (near ? 1.0 : max(1.0, uFarTexel / step0 * 0.5));
    if (near) ds = min(ds, 24.0);
  }
  gl_FragColor = vec4(lit, lit, lit, 1.0);
}`;

export class ShadowBaker {
  readonly near: THREE.WebGLRenderTarget;
  readonly far: THREE.WebGLRenderTarget | null;
  private mat: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private band = BANDS;
  private pending = new THREE.Vector3();
  private baked = new THREE.Vector3(0, -1, 0);
  private nearTex: THREE.DataTexture;
  private farTex: THREE.DataTexture | null = null;
  /** Called when a full pass is complete (the masks are consistent with the Sun). */
  onComplete?: () => void;

  constructor(private renderer: THREE.WebGLRenderer, terrain: TerrainData, mobile: boolean) {
    // Window heights at half resolution (4 m), max-pooled so thin ridges still cast shadows.
    const k = mobile ? 4 : 2;
    const n = Math.floor(terrain.w / k);
    const hs = new Float32Array(n * n);
    const H = terrain.heights, s = terrain.hScale, W = terrain.w;
    let maxH = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) m = Math.max(m, H[(j * k + b) * W + i * k + a]);
        const v = m * s;
        hs[j * n + i] = v;
        if (v > maxH) maxH = v;
      }
    }
    this.nearTex = new THREE.DataTexture(hs, n, n, THREE.RedFormat, THREE.FloatType);
    this.nearTex.minFilter = this.nearTex.magFilter = THREE.NearestFilter;
    this.nearTex.needsUpdate = true;
    const f = terrain.far;
    if (f) {
      const fh = new Float32Array(f.heights.length);
      for (let i = 0; i < fh.length; i++) {
        fh[i] = f.heights[i]; // already relative to the window's minimum
        if (fh[i] > maxH) maxH = fh[i];
      }
      this.farTex = new THREE.DataTexture(fh, f.n, f.n, THREE.RedFormat, THREE.FloatType);
      this.farTex.minFilter = this.farTex.magFilter = THREE.NearestFilter;
      this.farTex.needsUpdate = true;
    }
    const opts = { type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
    // Output mask: 2 m per texel on desktop (4 m on phones); bicubic sampling in the terrain shader.
    const size = mobile ? 2048 : 4096;
    this.near = new THREE.WebGLRenderTarget(size, size, opts);
    this.near.texture.wrapS = this.near.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.far = f ? new THREE.WebGLRenderTarget(mobile ? 512 : 1024, mobile ? 512 : 1024, opts) : null;
    // A render target's own scissor flag overrides the renderer's.
    this.near.scissorTest = true;
    if (this.far) this.far.scissorTest = true;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uNear: { value: this.nearTex },
        uFar: { value: this.farTex ?? this.nearTex },
        uNearHalf: { value: new THREE.Vector2(terrain.halfX, terrain.halfZ) },
        uFarHalf: { value: f ? f.half : 1 },
        uNearTexel: { value: new THREE.Vector2(terrain.meta.sizeX / n, terrain.meta.sizeZ / n) },
        uFarTexel: { value: f ? f.spacing : 1 },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uMaxH: { value: maxH + 1 },
        uFarPass: { value: 0 },
        uHasFar: { value: f ? 1 : 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
  }

  /** Request shadows for a new Sun direction (ignored for tiny moves). */
  setSun(dir: THREE.Vector3, force = false): void {
    if (!force && dir.angleTo(this.baked) < 1.75e-3 && this.band >= BANDS) return;
    if (!force && this.band < BANDS) return; // finish the pass in progress first
    this.pending.copy(dir);
    this.band = 0;
  }

  /** Render the whole mask now (startup, time jumps). */
  bakeAll(): void {
    while (this.band < BANDS) this.update(BANDS);
  }

  /** Advance the current pass by `n` bands (one per frame keeps it under ~1 ms). */
  update(n = 1): void {
    if (this.band >= BANDS) return;
    n = Math.min(n, BANDS - this.band);
    const r = this.renderer;
    const prevRt = r.getRenderTarget();
    this.mat.uniforms.uSun.value.copy(this.pending);
    for (const [rt, farPass] of [[this.near, 0], [this.far, 1]] as const) {
      if (!rt) continue;
      const h = rt.height / BANDS;
      this.mat.uniforms.uFarPass.value = farPass;
      r.setRenderTarget(rt);
      rt.scissor.set(0, Math.floor(this.band * h), rt.width, Math.ceil(h * n) + 1);
      rt.viewport.set(0, 0, rt.width, rt.height);
      r.render(this.scene, this.cam);
    }
    r.setRenderTarget(prevRt);
    this.band += n;
    if (this.band >= BANDS) {
      this.baked.copy(this.pending);
      this.onComplete?.();
    }
  }

  /** Lit fraction (0..1) of the terrain at a point, from the CPU height field (gameplay). */
  static litAt(t: TerrainData, x: number, z: number, sun: THREE.Vector3, lift = 1.5): number {
    if (sun.y <= -0.0046) return 0;
    const h = Math.hypot(sun.x, sun.z) || 1e-6;
    const dx = sun.x / h, dz = sun.z / h, tanEl = sun.y / h;
    const h0 = t.height(x, z) + lift;
    const maxH = t.meta.far ? t.meta.far.max : t.meta.maxHeight - t.meta.minHeight;
    let lit = 1, d = 0, ds = 2;
    for (let i = 0; i < 400; i++) {
      d += ds;
      const ray = h0 + d * tanEl;
      if (ray > maxH || d > 30000) break;
      const g = t.height(x + dx * d, z + dz * d);
      lit = Math.min(lit, Math.max(0, Math.min(1, (ray - g) / (d * 0.0092) + 0.5)));
      if (lit <= 0) break;
      ds = Math.max(2, d * 0.03);
    }
    return lit;
  }
}
