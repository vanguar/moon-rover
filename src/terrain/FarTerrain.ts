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
  private uniforms = { uNearR: { value: 3000 } };

  constructor(terrain: TerrainData, farShadow: THREE.Texture | undefined, mobile: boolean) {
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
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: 0x9a948c, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }), 'far', (shader) => {
      Object.assign(shader.uniforms, { uFarShadow: { value: farShadow ?? null }, uNearR: u.uNearR, uHasShadow: { value: farShadow ? 1 : 0 } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec2 vFarUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFarUv = uv;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWP;
varying vec2 vFarUv;
uniform sampler2D uFarShadow;
uniform float uHasShadow;
uniform float uNearR;
${NOISE_GLSL}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (length(vWP.xz - cameraPosition.xz) < uNearR) discard;`)
        .replace('#include <map_fragment>', `// Highland vs mare albedo: brighter at altitude (anorthositic massifs), mottled.
vec3 nA = lnoised(vWP.xz * 0.0016);
vec3 nB = lnoised(vWP.xz * 0.011 + 5.0);
float alt = smoothstep(150.0, 1800.0, vWP.y);
diffuseColor.rgb *= (0.8 + 0.12 * alt) * (0.88 + 0.18 * nA.x + 0.1 * nB.x);
vec2 fgrad = nA.yz * 0.0016 * 120.0 + nB.yz * 0.011 * 25.0;
float farSun = uHasShadow > 0.5 ? smoothstep(0.2, 0.8, texture2D(uFarShadow, vFarUv).r) : 1.0;`)
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

  setNearRadius(r: number): void {
    this.uniforms.uNearR.value = r;
  }
}
