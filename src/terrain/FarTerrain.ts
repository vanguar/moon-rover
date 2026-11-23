import * as THREE from 'three';
import { makeLunar, NOISE_GLSL } from '../render/lunar';
import type { TerrainData } from './TerrainData';

/**
 * The real landscape beyond the near-terrain chunks: SLDEM2015 (LOLA + Kaguya)
 * heights on a 112 m grid over 56 × 56 km — Hadley Delta, Mons Hadley, the
 * Apennine front. One static mesh; fragments inside the near-chunk radius are
 * discarded. Lunar curvature is applied in the shared lunar vertex code.
 */
export class FarTerrain {
  readonly mesh: THREE.Mesh;
  private uniforms = { uNearR: { value: 3000 }, uFarShadow: { value: null as THREE.Texture | null } };

  constructor(terrain: TerrainData, farShadow: THREE.Texture | undefined, mobile: boolean, farAlbedo?: THREE.Texture, ortho?: THREE.Texture) {
    const f = terrain.far!;
    const stride = mobile ? 2 : 1;
    const n = Math.floor((f.n - 1) / stride) + 1;
    const pos = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const sp = f.spacing * stride;
    const half = (f.n - 1) * f.spacing / 2;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -half + i * sp, z = -half + j * sp;
        pos[k * 3] = x;
        pos[k * 3 + 1] = terrain.farHeight(x, z);
        pos[k * 3 + 2] = z;
        const hx = terrain.farHeight(x + f.spacing, z) - terrain.farHeight(x - f.spacing, z);
        const hz = terrain.farHeight(x, z + f.spacing) - terrain.farHeight(x, z - f.spacing);
        const l = Math.hypot(hx, 2 * f.spacing, hz);
        nor[k * 3] = -hx / l;
        nor[k * 3 + 1] = (2 * f.spacing) / l;
        nor[k * 3 + 2] = -hz / l;
        uv[k * 2] = i / (n - 1);
        uv[k * 2 + 1] = j / (n - 1);
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let o = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + n, c = a + 1, d = b + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = c;
        idx[o++] = c; idx[o++] = b; idx[o++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();

    if (farShadow) {
      farShadow.flipY = false;
      farShadow.wrapS = farShadow.wrapT = THREE.ClampToEdgeWrapping;
      farShadow.needsUpdate = true;
    }
    const u = this.uniforms;
    const mars = terrain.meta.body === 'mars';
    if (farAlbedo) {
      farAlbedo.flipY = false;
      farAlbedo.colorSpace = THREE.SRGBColorSpace;
      farAlbedo.wrapS = farAlbedo.wrapT = THREE.ClampToEdgeWrapping;
      farAlbedo.needsUpdate = true;
    }
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: mars ? 0xffffff : 0x989690, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }), 'far', (shader) => {
      u.uFarShadow.value = u.uFarShadow.value ?? farShadow ?? null;
      Object.assign(shader.uniforms, {
        uFarShadow: u.uFarShadow, uNearR: u.uNearR, uHasShadow: { value: farShadow ? 1 : 0 }, uFarAlb: { value: farAlbedo ?? null },
        uOrtho: { value: ortho ?? null }, uMapSize: { value: new THREE.Vector2(terrain.meta.sizeX, terrain.meta.sizeZ) },
      });
      shader.defines = { ...(shader.defines ?? {}), FAR_ALB: farAlbedo ? 1 : 0, ORTHO: ortho && !mars ? 1 : 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec2 vFarUv;\nvarying vec3 vWN;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFarUv = uv;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWP;
varying vec2 vFarUv;
varying vec3 vWN;
uniform sampler2D uFarShadow;
uniform sampler2D uFarAlb;
uniform float uHasShadow;
uniform float uNearR;
uniform sampler2D uOrtho;
uniform vec2 uMapSize;
${NOISE_GLSL}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (length(vWP.xz - cameraPosition.xz) < uNearR) discard;`)
        .replace('#include <map_fragment>', `// Highland vs mare albedo: brighter at altitude (anorthositic massifs), mottled.
vec3 nA = lnoised(vWP.xz * 0.0016);
vec3 nB = lnoised(vWP.xz * 0.011 + 5.0);
float alt = smoothstep(150.0, 1800.0, vWP.y);
#if FAR_ALB > 0
// Mars: CTX 6 m albedo mosaic, tinted like the near terrain.
float fa = texture2D(uFarAlb, vFarUv).r * (0.92 + 0.12 * nB.x);
fa = clamp(0.13 + (fa - 0.13) * 1.3, 0.015, 1.0);
diffuseColor.rgb = fa * mix(vec3(0.8, 0.6, 0.48), vec3(1.3, 0.8, 0.5), smoothstep(0.05, 0.3, fa)) * 1.9;
#elif ORTHO > 0
// Same albedo as the near terrain (orthophoto inside the 8 km window, its mean outside),
// so the hand-over from the near chunks is seamless. Highland massifs (anorthositic)
// are ~1.5–1.8× brighter than the mare, the steepest slopes a little brighter still
// (fresher, less mature regolith).
vec2 mUv = (vWP.xz + 0.5 * uMapSize) / uMapSize;
vec2 eD = 0.5 * uMapSize - abs(vWP.xz);
float wWin = smoothstep(0.0, 150.0, min(eD.x, eD.y));
float oMean = textureLod(uOrtho, vec2(0.5), 12.0).r;
// Outside the window: continue the albedo at the window's edge (blurred), relaxing over
// ~3 km toward highland regolith, ~1.6× the mare (Hadley Delta, Mons Hadley).
float outD = max(-min(eD.x, eD.y), 0.0);
float edgeA = textureLod(uOrtho, clamp(mUv, 0.005, 0.995), 6.0).r;
float farA = mix(edgeA, oMean * 1.6, smoothstep(0.0, 3000.0, outD));
float oA = mix(farA, texture2D(uOrtho, clamp(mUv, 0.0, 1.0)).r, wWin);
float var = (0.9 + 0.14 * nA.x + 0.1 * nB.x) * (1.0 + 0.12 * (1.0 - smoothstep(0.75, 0.95, normalize(vWN).y)));
diffuseColor.rgb = vec3(1.0, 0.985, 0.965) * 1.5 * oA * mix(var, 1.0, wWin);
#else
diffuseColor.rgb *= (0.8 + 0.12 * alt) * (0.88 + 0.18 * nA.x + 0.1 * nB.x);
#endif
vec2 fgrad = nA.yz * 0.0016 * 120.0 + nB.yz * 0.011 * 25.0;
float farSun = uHasShadow > 0.5 ? smoothstep(0.02, 0.98, texture2D(uFarShadow, vFarUv).r) : 1.0;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
vec3 nWf = normalize(inverseTransformDirection(normal, viewMatrix) - vec3(fgrad.x, 0.0, fgrad.y) * 0.25);
normal = normalize((viewMatrix * vec4(nWf, 0.0)).xyz);`)
        .replace(
          '#include <lights_fragment_begin>',
          THREE.ShaderChunk.lights_fragment_begin.replace(
            'getDirectionalLightInfo( directionalLight, directLight );',
            'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= farSun;',
          ),
        );
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  setShadowMap(t: THREE.Texture): void {
    this.uniforms.uFarShadow.value = t;
  }

  setNearRadius(r: number): void {
    this.uniforms.uNearR.value = r;
  }
}
