import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Bootprints of the lunar overshoes (A7L-B): 33.6 × 15.2 cm, eight transverse ribs
 * (NASM). Lunar regolith is cohesive and does not slump, so the prints keep sharp
 * walls and a crisp tread 1–2.5 cm deep (AS11-40-5878), and they never fade - no wind.
 * A hop lands both feet side by side; a fast one drags the toe and throws a smear
 * of soil forward.
 *
 * Drawn as quads lying on the ground with a height field evaluated in the shader:
 * the print is lit by the real Sun - its sun-side wall in shadow, the far wall bright -
 * and multiplied onto the terrain (like the dust-devil tracks), so it takes the
 * soil's own colour. Every print differs a little: depth, angle, smear.
 */
const N = 900;
const LEN = 0.336, WID = 0.152;
/** Quad size: the print plus room for the raised rim and the forward smear. */
const QL = 0.62, QW = 0.26;

export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private params: THREE.InstancedBufferAttribute;
  private head = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private n = [0, 1, 0];

  constructor(private terrain: TerrainData, sunDir: THREE.Vector3, curvK: number) {
    const geo = new THREE.PlaneGeometry(QL, QW);
    geo.rotateX(-Math.PI / 2); // local x: along the foot (toe +x), local z: across, y: up
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    geo.setAttribute('aParam', this.params);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: sunDir }, uCurvK: { value: curvK } },
      vertexShader: /* glsl */ `
        attribute vec3 aParam;
        uniform vec3 uSun;
        uniform float uCurvK;
        varying vec2 vQ;
        varying vec3 vSunL;
        varying vec3 vP;
        void main() {
          // Plane y became local -z (rotateX(-π/2)), so vQ = (local x, local z).
          vQ = (uv - 0.5) * vec2(${QL.toFixed(3)}, -${QW.toFixed(3)});
          vP = aParam;
          mat3 R = mat3(instanceMatrix);
          vSunL = normalize(transpose(R) * uSun);
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vec2 dc = w.xz - cameraPosition.xz;
          w.y -= dot(dc, dc) * uCurvK; // the terrain's own curvature drop
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vQ;
        varying vec3 vSunL;
        varying vec3 vP; // depth (m), smear 0..1, seed
        float sole(vec2 q) {
          // Rounded sole outline, a little narrower at the heel; the print sits 6 cm back
          // in the quad (room for the smear ahead of the toe).
          q.x += 0.06;
          float hw = ${(WID / 2).toFixed(4)} - 0.012 * smoothstep(0.05, -0.16, q.x);
          vec2 d = abs(q) - vec2(${(LEN / 2).toFixed(4)} - 0.05, hw - 0.05);
          return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.05;
        }
        float hgt(vec2 q) {
          float s = sole(q);
          float inside = smoothstep(0.004, -0.004, s);
          // Eight transverse ribs pressed in (the sole's ribs leave grooves' negative).
          float x = (q.x + 0.06) / ${LEN.toFixed(3)} + 0.5;
          float ribs = smoothstep(0.25, 0.55, abs(fract(x * 8.0 + vP.z * 0.3) - 0.5) * 2.0);
          float h = -vP.x * inside + 0.005 * ribs * inside;
          // Soil pushed up around the edge, and flung forward by a dragging toe.
          h += 0.004 * exp(-pow(s / 0.012, 2.0)) * (1.0 - inside);
          float ahead = smoothstep(0.0, 0.2, q.x - 0.1) * smoothstep(0.28, 0.12, q.x - 0.1) * smoothstep(0.08, 0.0, abs(q.y));
          h += vP.y * 0.006 * ahead;
          return h;
        }
        void main() {
          float e = 0.004;
          float h = hgt(vQ);
          vec2 g = vec2(hgt(vQ + vec2(e, 0.0)) - h, hgt(vQ + vec2(0.0, e)) - h) / e;
          // Local frame: x along the foot, z across (vQ = (x, z)).
          vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
          float flatLit = max(vSunL.y, 0.05);
          float lit = max(dot(n, vSunL), 0.0) / flatLit;
          // Cast shadow inside the print: the sun-side wall shades the floor.
          vec2 sh = vec2(vSunL.x, vSunL.z);
          float lh = length(sh);
          float tanEl = vSunL.y / max(lh, 1e-3);
          if (lh > 1e-3) {
            vec2 st = sh / lh * (vP.x / max(tanEl, 0.08));
            if (hgt(vQ + st) > h + 0.003) lit *= 0.25;
          }
          float k = mix(1.0, clamp(lit, 0.1, 1.8), smoothstep(0.03, 0.0, sole(vQ) - 0.012) + vP.y * 0.5 * step(0.1, vQ.x));
          gl_FragColor = vec4(vec3(k * 0.5), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Both feet of a landing at (x, z), body heading yaw, horizontal speed v (m/s). */
  land(x: number, z: number, yaw: number, v: number, rnd: () => number = Math.random): void {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    for (const side of [-1, 1]) {
      const px = x - fz * side * 0.14 + fx * (rnd() - 0.5) * 0.08, pz = z + fx * side * 0.14 + fz * (rnd() - 0.5) * 0.08;
      this.add(px, pz, yaw + (rnd() - 0.5) * 0.2 + side * 0.06, 0.012 + rnd() * 0.013 + 0.004 * Math.min(1, v / 2), Math.min(1, v / 2) * (0.4 + 0.6 * rnd()), rnd());
    }
  }

  private add(x: number, z: number, yaw: number, depth: number, smear: number, seed: number): void {
    const t = this.terrain;
    t.normal(x, z, this.n, 0.3);
    // The print lies on the ground: tilt to the slope, then turn to the heading
    // (local +x is the toe: heading yaw means forward = (sin yaw, cos yaw)).
    this.q.setFromUnitVectors(this.up, new THREE.Vector3(this.n[0], this.n[1], this.n[2]))
      .multiply(new THREE.Quaternion().setFromAxisAngle(this.up, yaw - Math.PI / 2));
    this.m4.compose(new THREE.Vector3(x, t.height(x, z) + 0.005, z), this.q, new THREE.Vector3(1, 1, 1));
    const i = this.head;
    this.head = (this.head + 1) % N;
    this.mesh.setMatrixAt(i, this.m4);
    this.params.setXYZ(i, depth, smear, seed);
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.params.needsUpdate = true;
  }
}
