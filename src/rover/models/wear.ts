import * as THREE from 'three';
import { NOISE_GLSL } from '../../render/lunar';

/**
 * Field wear for the procedural rover models: nothing that has been driven on the
 * Moon or Mars is factory-smooth. Applied to every standard material of a model:
 *
 *  - panel waviness ("oil canning") and small dents at 10–30 cm, millimetre grain:
 *    bump from screen-space derivatives of a noise height in the part's own frame
 *    (it moves with the part, no texture swimming);
 *  - roughness that varies (polished by handling, matte where dusty), fine scratches
 *    along one direction;
 *  - regolith dust: on upward faces and on the lower parts (thrown up by the wheels),
 *    lunar grey or Martian ochre.
 *
 * Plus geometric dents on large flat panels and fenders (dentGeometry).
 */
export interface WearOptions {
  /** Overall dust level 0..1 (shared uniform: the owner raises it as dust settles). */
  dust: { value: number };
  /** Dust colour (linear). */
  dustColor: THREE.Color;
  /** Height (model frame) below which wheel-thrown dust builds up. */
  lowY: number;
  /** World → rover-model matrix, updated by the owner every frame. */
  rootInv: { value: THREE.Matrix4 };
  /** Sandblasting by wind-driven grains 0..1 (Mars): matte, abraded surfaces. */
  blast?: { value: number };
}

const WEAR_PARS = /* glsl */ `
varying vec3 vWearP;
varying vec3 vWearN;
varying vec3 vWearWN;
varying float vWearY;
uniform float uWearDust;
uniform vec3 uWearDustCol;
uniform float uWearLowY;
uniform float uWearKind; // 0 metal, 1 paint/plastic, 2 foil
uniform mat4 uWearRootInv;
uniform float uWearBlast;
${NOISE_GLSL}
// Noise values shared by the normal, roughness and colour stages (computed once).
float gWearA = 0.0, gWearB = 0.0;
// One noise lookup on the plane facing the dominant normal axis (instead of three
// blended planes): a third of the cost on parts that can fill half the screen.
float wTri(vec3 p, vec3 w) {
  vec2 q = w.x > w.y && w.x > w.z ? p.yz : w.y > w.z ? p.xz + 13.1 : p.xy + 27.7;
  return lnoised(q).x;
}
`;

export function applyWear(root: THREE.Object3D, opt: WearOptions): void {
  const done = new Set<THREE.Material>();
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const s = m as THREE.MeshStandardMaterial;
      // (Materials of cached glTF models are shared between builds: patch them only once.)
      if (!s.isMeshStandardMaterial || done.has(s) || s.transparent || s.userData.noWear || s.userData.worn) continue;
      done.add(s);
      s.userData.worn = true;
      patch(s, opt);
    }
    void inv;
  });
}

function kindOf(m: THREE.MeshStandardMaterial): number {
  if (m.metalness > 0.8 && m.roughness < 0.45) return m.color.r > 0.6 && m.color.b < 0.45 ? 2 : 0;
  return m.metalness > 0.5 ? 0 : 1;
}

function patch(m: THREE.MeshStandardMaterial, opt: WearOptions): void {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  const kind = kindOf(m);
  m.customProgramCacheKey = () => `${prevKey()}-wear${kind}`;
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r);
    Object.assign(shader.uniforms, {
      uWearDust: opt.dust,
      uWearDustCol: { value: opt.dustColor },
      uWearLowY: { value: opt.lowY },
      uWearKind: { value: kind },
      uWearRootInv: opt.rootInv,
      uWearBlast: opt.blast ?? { value: 0 },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WEAR_PARS}`)
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
vWearP = position;
vWearN = normal;
vWearWN = normalize(mat3(modelMatrix) * normal);
vWearY = (uWearRootInv * modelMatrix * vec4(position, 1.0)).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WEAR_PARS}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec3 an = abs(normalize(vWearN));
  vec3 w = an / (an.x + an.y + an.z + 1e-4);
  float fw = length(fwidth(vWearP));
  // Panel waviness / dents (decimetres) and, on foil, crinkles.
  gWearA = wTri(vWearP * 6.0, w);
  gWearB = wTri(vWearP * (uWearKind > 1.5 ? 45.0 : 15.0) + 3.0, w);
  float H = gWearA * 0.0025 + gWearB * (uWearKind > 1.5 ? 0.0022 : 0.0012);
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec2 dH = vec2(dFdx(H), dFdy(H));
  normal = normalize(abs(det) * normal - sign(det) * (dH.x * r1 + dH.y * r2));
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
{
  vec3 an = abs(normalize(vWearN));
  vec3 w = an / (an.x + an.y + an.z + 1e-4);
  float n1 = gWearA;
  // Fine scratches along x (handling, tools, dust abrasion).
  float scr = smoothstep(0.93, 0.99, lnoised(vec2(vWearP.x * 3.0, (vWearP.y + vWearP.z) * 180.0)).x);
  roughnessFactor = clamp(roughnessFactor * (0.75 + 0.55 * n1) - scr * 0.15, 0.04, 1.0);
  // Sand-blasted: grains frost glossy surfaces matte (more on the edges facing the wind).
  roughnessFactor = mix(roughnessFactor, 0.92, uWearBlast * (0.5 + 0.5 * n1));
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 an = abs(normalize(vWearN));
  vec3 w = an / (an.x + an.y + an.z + 1e-4);
  float n2 = gWearA;
  float n3 = gWearB;
  // Grime and small chips on paint.
  if (uWearKind > 0.5 && uWearKind < 1.5) diffuseColor.rgb *= 0.9 + 0.12 * n2 - 0.25 * smoothstep(0.86, 0.95, n3);
  // Dust: upward faces and the lower body (thrown by the wheels), patchy.
  float up = smoothstep(0.3, 0.95, normalize(vWearWN).y);
  float low = 1.0 - smoothstep(uWearLowY - 0.15, uWearLowY + 0.35, vWearY);
  float dust = clamp((up * 0.55 + low * 0.6) * uWearDust * (0.55 + 0.7 * n2), 0.0, 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, uWearDustCol, dust);
  vWearDustAmt = dust;
}`,
      )
      .replace('#include <common>\n' + WEAR_PARS, `#include <common>\n${WEAR_PARS}\nfloat vWearDustAmt = 0.0;`)
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
// Dusty surfaces are matte and lose their metallic sheen.
material.roughness = mix(material.roughness, 0.95, vWearDustAmt);
material.diffuseColor = mix(material.diffuseColor, diffuseColor.rgb, vWearDustAmt * metalnessFactor);
material.specularColor = mix(material.specularColor, vec3(0.04), vWearDustAmt);`,
      );
  };
  m.needsUpdate = true;
}

/**
 * Dents for a panel geometry (subdivided): a few smooth depressions of a few
 * millimetres along the face normals, seeded so every rover keeps its own dings.
 */
export function dentGeometry(g: THREE.BufferGeometry, seed: number, count = 3, depth = 0.006, radius = 0.06): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dents = Array.from({ length: count }, () => ({
    c: new THREE.Vector3(bb.min.x + rnd() * (bb.max.x - bb.min.x), bb.min.y + rnd() * (bb.max.y - bb.min.y), bb.min.z + rnd() * (bb.max.z - bb.min.z)),
    r: radius * (0.6 + rnd()),
    d: depth * (0.4 + rnd()),
  }));
  const v = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    nn.fromBufferAttribute(n, i);
    let off = 0;
    for (const d of dents) {
      const q = v.distanceTo(d.c) / d.r;
      if (q < 1.6) off += d.d * Math.exp(-q * q * 2.2);
    }
    v.addScaledVector(nn, -off);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
