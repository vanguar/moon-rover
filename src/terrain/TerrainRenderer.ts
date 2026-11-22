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

  constructor(terrain: TerrainData, ortho: THREE.Texture, baked: THREE.Texture, quality: QualitySettings) {
    this.q = quality;
    const meta = terrain.meta;
    for (const t of [ortho, baked]) {
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.flipY = false;
      t.needsUpdate = true;
    }
    ortho.colorSpace = THREE.SRGBColorSpace;
    ortho.anisotropy = 8;
    ortho.generateMipmaps = true;
    ortho.minFilter = THREE.LinearMipmapLinearFilter;

    this.uniforms = {
      uRover: { value: new THREE.Vector2() },
      uRtRange: { value: quality.shadowRange },
    };
    const u = this.uniforms;
    this.material = makeLunar(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'terrain', (shader) => {
      Object.assign(shader.uniforms, {
        uOrtho: { value: ortho },
        uBaked: { value: baked },
        uMapSize: { value: new THREE.Vector2(meta.sizeX, meta.sizeZ) },
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
${NOISE_GLSL}`,
        )
        .replace(
          '#include <map_fragment>',
          `vec2 mapUv = (vWorldP.xz + 0.5 * uMapSize) / uMapSize;
// Orthophoto is a high-sun image: its brightness is mostly albedo.
float ortho = texture2D(uOrtho, mapUv).r;
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
vec3 regolith = vec3(1.0, 0.965, 0.92);
diffuseColor.rgb = regolith * clamp(ortho * 0.9 + albedoVar * 0.25, 0.02, 1.0);
// Baked far-field cast shadow of the DTM; faded out where the real-time shadow map is valid.
float baked = texture2D(uBaked, mapUv).r;
float rtW = 1.0 - smoothstep(uRtRange * 0.55, uRtRange * 0.85, length(vWorldP.xz - uRover));
float bakedSun = mix(smoothstep(0.25, 0.75, baked), 1.0, rtW);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
vec3 nW = normalize(normalize(vNormalW) - vec3(grad.x, 0.0, grad.y));
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

  setQuality(q: QualitySettings): void {
    this.q = q;
    this.uniforms.uRtRange.value = q.shadowRange;
    for (const c of this.chunks.values()) c.level = -1; // force rebuild at new LOD
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
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      c.mesh = m;
      this.group.add(m);
    }
    c.level = job.level;
  }

  private dispose(c: Chunk): void {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    this.chunks.delete(c.key);
  }
}
