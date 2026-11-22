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
  };
  private chunks = new Map<string, Chunk>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private jobs = new Map<number, { chunk: Chunk; level: number; worker: number }>();
  private nextId = 1;
  private q: QualitySettings;

  constructor(terrain: TerrainData, ortho: THREE.Texture, baked: THREE.Texture, quality: QualitySettings, orthoHi?: THREE.Texture) {
    this.q = quality;
    const meta = terrain.meta;
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
    };
    const u = this.uniforms;
    this.material = makeLunar(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'terrain', (shader) => {
      shader.defines = { ...(shader.defines ?? {}), CRATERLETS: this.craterletLevel() };
      Object.assign(shader.uniforms, {
        uOrtho: { value: ortho },
        uBaked: { value: baked },
        uMapSize: { value: new THREE.Vector2(meta.sizeX, meta.sizeZ) },
        uOrthoHi: { value: orthoHi ?? ortho },
        uHi: { value: hiRect },
        uDtmN: { value: dtmNormals },
        uNearN: { value: quality.lodDistances[1] },
        uRover: u.uRover,
        uRtRange: u.uRtRange,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;\nvarying vec3 vNormalW;')
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
${NOISE_GLSL}
// Sub-metre craters (below DTM and mesh resolution): one random crater per cell,
// parabolic bowl + raised rim; returns (height, d/dx, d/dz).
vec3 craterField(vec2 p, float cell, float seed) {
  vec2 c = floor(p / cell);
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
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
      float h, dh;
      if (q < 1.0) { float b = q * q; h = rim + depth * (b * (1.15 - 0.15 * b) - 1.0); dh = depth * (2.3 * q - 0.6 * q * q * q); }
      else { float t = 2.0 - q; h = rim * t * t * t; dh = -3.0 * rim * t * t; }
      acc += vec3(h, (r > 1e-4 ? d / r : vec2(0.0)) * dh / R);
    }
  }
  return acc;
}`,
        )
        .replace(
          '#include <map_fragment>',
          `vec2 mapUv = (vWorldP.xz + 0.5 * uMapSize) / uMapSize;
// Orthophoto is a high-sun image: its brightness is mostly albedo.
float ortho = texture2D(uOrtho, mapUv).r;
if (uHi.w > 0.5) {
  vec2 hu = (vWorldP.xz - uHi.xy) / uHi.z;
  vec2 e = smoothstep(vec2(0.0), vec2(0.03), hu) * smoothstep(vec2(0.0), vec2(0.03), 1.0 - hu);
  float wHi = e.x * e.y;
  if (wHi > 0.0) ortho = mix(ortho, texture2D(uOrthoHi, clamp(hu, 0.0, 1.0)).r, wHi);
}
// Regolith micro-relief: 5 octaves from 4 m down to ~5 cm, faded below pixel size.
float fp = max(length(fwidth(vWorldP.xz)), 1e-4);
vec2 grad = vec2(0.0);
float albedoVar = 0.0;
float freq = 0.3, amp = 0.16;
for (int o = 0; o < 6; o++) {
  float w = clamp(1.6 - fp * freq * 2.5, 0.0, 1.0);
  vec3 nd = lnoised(vWorldP.xz * freq + float(o) * 17.13);
  grad += nd.yz * amp * freq * w;
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
vec3 regolith = vec3(1.0, 0.965, 0.92);
diffuseColor.rgb = regolith * clamp(ortho * 0.9 + albedoVar * 0.25, 0.02, 1.0);
// Baked far-field cast shadow of the DTM; faded out where the real-time shadow map is valid.
float baked = texture2D(uBaked, mapUv).r;
// Near the rover only large-scale DTM shadows come from the bake (soft, 2 m);
// fine shadows come from the real-time map.
float rtW = 1.0 - smoothstep(uRtRange * 0.5, uRtRange * 0.8, length(vWorldP.xz - uRover));
float bakedSun = mix(smoothstep(0.2, 0.8, baked), smoothstep(0.05, 0.5, baked), rtW);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
// Far away the mesh is coarse: take the surface orientation from the 2 m DTM normal map.
vec2 sl = (texture2D(uDtmN, mapUv).rg - 0.5) * 5.0;
// Mirrored tiles outside the DTM window flip the slope sign.
sl *= 1.0 - 2.0 * mod(floor(mapUv), 2.0);
vec3 nDtm = normalize(vec3(-sl.x, 1.0, -sl.y));
float farW = smoothstep(uNearN * 0.5, uNearN, length(vWorldP.xz - cameraPosition.xz));
vec3 nBase = normalize(mix(normalize(vNormalW), nDtm, farW));
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
      w.postMessage({ type: 'init', meta, heights: terrain.heights });
      w.onmessage = (e: MessageEvent<BuildResult>) => this.onBuilt(i, e.data);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  private craterletLevel(): number {
    return this.q.level === 'low' ? 0 : this.q.level === 'medium' ? 1 : 2;
  }

  /** 2 m slope map of the DTM (RG8: dh/dx, dh/dz) for per-pixel normals at distance. */
  private buildNormalTexture(t: TerrainData): THREE.DataTexture {
    const w = t.w, h = t.h, px = t.meta.pixelSize;
    const data = new Uint8Array(w * h * 2);
    const H = t.heights;
    for (let j = 0; j < h; j++) {
      const j0 = Math.max(0, j - 1), j1 = Math.min(h - 1, j + 1);
      for (let i = 0; i < w; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(w - 1, i + 1);
        const sx = (H[j * w + i1] - H[j * w + i0]) / ((i1 - i0) * px);
        const sz = (H[j1 * w + i] - H[j0 * w + i]) / ((j1 - j0) * px);
        const o = (j * w + i) * 2;
        data[o] = Math.max(0, Math.min(255, Math.round((sx / 5 + 0.5) * 255)));
        data[o + 1] = Math.max(0, Math.min(255, Math.round((sz / 5 + 0.5) * 255)));
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

  setQuality(q: QualitySettings): void {
    this.q = q;
    this.uniforms.uRtRange.value = q.shadowRange;
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
    // Only near chunks render into the real-time shadow map; far terrain shadows are baked.
    c.mesh!.castShadow = job.level <= 1;
  }

  private dispose(c: Chunk): void {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    this.chunks.delete(c.key);
  }
}
