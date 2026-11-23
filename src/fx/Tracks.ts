import * as THREE from 'three';
import type { Rover } from '../rover/Rover';
import type { RoverSpec } from '../rover/specs';
import { hash2, type TerrainData } from '../terrain/TerrainData';
import { world } from '../world';

const SEG_LEN = 0.25;
const PER_TRACK = 3000;
/** The rut quad is wider than the wheel to hold the berms of displaced soil. */
const BERM = 1.45;

/**
 * Bekker pressure–sinkage parameters (n = 1): kc [N/m²], kφ [N/m³]. Typical
 * values for lunar regolith (Apollo soil mechanics) and for Martian soil
 * simulants; the local value varies along the path (loose sand, crust, pavement).
 */
const SOIL = {
  moon: { kc: 1400, kphi: 820000 },
  mars: { kc: 1400, kphi: 650000 },
};

/** Grouser imprint pattern along the rut (green channel: 1 = bar). */
function treadTexture(tread: RoverSpec['tread']): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#fff';
  g.lineWidth = tread === 'cleat' ? 10 : 7;
  g.lineCap = 'round';
  g.beginPath();
  if (tread === 'chevron') {
    for (const y of [8, 40]) {
      g.moveTo(2, y);
      g.lineTo(32, y + 18);
      g.lineTo(62, y);
    }
  } else {
    for (const y of [12, 44]) {
      g.moveTo(4, y);
      g.lineTo(60, y + (tread === 'grouser' ? 5 : 0));
    }
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/**
 * Wheel ruts as relief, not decals.
 *
 * Depth: Bekker pressure–sinkage for a rigid wheel, W = (kc/b + kφ)·b·√(2r)·z^1.5,
 * from the actual normal load on each wheel (so the downhill wheels on a slope
 * and the outer wheels in a turn cut deeper), a soil that varies along the path,
 * and slip sinkage. Profile: a trough with berms of displaced soil on both
 * sides, grouser imprints at the bottom. The tread phase advances with the
 * wheel's rim travel, so slipping wheels smear and compress the pattern.
 *
 * Shading: the rut's slopes are lit by the real Sun — the wall facing the Sun
 * is bright, the opposite wall dark — and fresh (undusted, compacted) soil is a
 * little darker. The result is applied as a 2× multiplicative modulation of the
 * terrain already drawn underneath, so the ground's own albedo is preserved.
 */
export class Tracks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private uv: Float32Array;
  private side: Float32Array;
  private depth: Float32Array;
  private last: (THREE.Vector3 | null)[] = [];
  private lastL: THREE.Vector3[] = [];
  private lastR: THREE.Vector3[] = [];
  private lastD: number[] = [];
  private lastV: number[] = [];
  private lastSide: THREE.Vector3[] = [];
  private rim: number[] = [];
  private head: number[] = [0, 0, 0, 0];
  private wheels: number[] = [];
  private halfW = 0.12;
  private segLen = SEG_LEN;
  private spec!: RoverSpec;
  private mat: THREE.ShaderMaterial;
  private slot = [0, 1, 2, 3];

  constructor(private terrain: TerrainData, spec: RoverSpec, sunDir: THREE.Vector3) {
    const quads = PER_TRACK * 4;
    this.pos = new Float32Array(quads * 4 * 3);
    this.uv = new Float32Array(quads * 4 * 2);
    this.side = new Float32Array(quads * 4 * 3);
    this.depth = new Float32Array(quads * 4);
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aDepth', new THREE.BufferAttribute(this.depth, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTread: { value: treadTexture(spec.tread) },
        uSun: { value: sunDir }, // shared: follows the moving Sun
        uAmb: { value: world().atmosphere ? 0.55 : 0.06 },
        uHalfW: { value: 0.12 },
        uFresh: { value: world().atmosphere ? 0.84 : 0.9 },
        uCurvK: { value: 0.5 / world().radius },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSide;
        attribute float aDepth;
        uniform float uCurvK;
        varying vec2 vUv;
        varying vec3 vSide;
        varying float vDepth;
        varying vec3 vW;
        void main() {
          vUv = uv;
          vSide = aSide;
          vDepth = aDepth;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vec2 dc = w.xz - cameraPosition.xz;
          w.y -= dot(dc, dc) * uCurvK;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTread;
        uniform vec3 uSun;
        uniform float uAmb;
        uniform float uHalfW;
        uniform float uFresh;
        varying vec2 vUv;
        varying vec3 vSide;
        varying float vDepth;
        varying vec3 vW;
        float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hsh(vec2(i, 3.0)), hsh(vec2(i + 1.0, 3.0)), f); }
        // Cross profile (in units of the local sinkage) at across-coordinate u (|u| = 1 at the wheel edge).
        float profile(float u, float v) {
          float a = abs(u + (vn(v * 0.9) - 0.5) * 0.12);
          float edge = 1.0 + (vn(v * 2.7 + 7.0) - 0.5) * 0.18; // ragged walls
          float trough = 1.0 - smoothstep(edge - 0.22, edge + 0.04, a);
          float berm = exp(-pow((a - edge - 0.12) / (0.11 + 0.05 * vn(v * 1.3)), 2.0)) * (0.3 + 0.25 * vn(v * 0.7 + 2.0));
          float imprint = texture2D(uTread, vec2(clamp(a * 0.5 + 0.5, 0.0, 1.0), v)).g * trough;
          return -trough - 0.45 * imprint + berm;
        }
        void main() {
          float u = (vUv.x * 2.0 - 1.0) * ${BERM.toFixed(2)};
          float v = vUv.y;
          float d = vDepth;
          if (d <= 0.0) discard;
          float h0 = profile(u, v);
          float e = 0.03;
          // Slopes across (per metre) and along the rut (tread pitch = 4 half-widths).
          float sA = (profile(u + e, v) - profile(u - e, v)) / (2.0 * e) * d / uHalfW;
          float sF = (profile(u, v + e) - profile(u, v - e)) / (2.0 * e) * d / (uHalfW * 4.0);
          vec3 side = normalize(vSide);
          vec3 fwd = normalize(cross(side, vec3(0.0, 1.0, 0.0)));
          vec3 n = normalize(vec3(0.0, 1.0, 0.0) - side * sA - fwd * sF);
          float L = max(dot(n, uSun), 0.0), L0 = max(uSun.y, 0.02);
          // Self-shadowing of the trough when the Sun is low: the near wall hides the floor.
          float wallShade = 1.0 - smoothstep(0.0, 1.0, -h0) * smoothstep(0.35, 0.05, uSun.y) * 0.25;
          float f = (uAmb + L * wallShade) / (uAmb + L0);
          // Freshly turned, compacted soil is darker than the dusted surface.
          float fresh = mix(1.0, uFresh, clamp(-h0, 0.0, 1.0));
          float m = f * fresh;
          // Fade the far end of the rut set and the outer berm margin.
          float fade = (1.0 - smoothstep(80.0, 160.0, length(vW - cameraPosition))) * (1.0 - smoothstep(1.3, ${BERM.toFixed(2)}, abs(u)));
          m = mix(1.0, m, fade);
          gl_FragColor = vec4(vec3(clamp(m * 0.5, 0.0, 1.0)), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.setRover(spec);
  }

  /** Light balance: sky/ambient irradiance relative to the direct Sun. */
  setAmbient(ratio: number): void {
    this.mat.uniforms.uAmb.value = ratio;
  }

  /** New rover: new rut width and tread; old ruts stay on the ground. */
  setRover(spec: RoverSpec): void {
    this.spec = spec;
    this.wheels = spec.trackWheels.slice(0, 4);
    this.halfW = (spec.wheelWidth / 2) * BERM;
    this.mat.uniforms.uHalfW.value = spec.wheelWidth / 2;
    this.segLen = Math.min(SEG_LEN, spec.wheelRadius * 0.6);
    this.last = this.wheels.map(() => null);
    this.lastL = this.wheels.map(() => new THREE.Vector3());
    this.lastR = this.wheels.map(() => new THREE.Vector3());
    this.lastSide = this.wheels.map(() => new THREE.Vector3(1, 0, 0));
    this.lastD = this.wheels.map(() => 0);
    this.lastV = this.wheels.map(() => 0);
    this.rim = this.wheels.map(() => 0);
    const old = this.mat.uniforms.uTread.value as THREE.Texture;
    old.dispose();
    this.mat.uniforms.uTread.value = treadTexture(spec.tread);
  }

  /** Bekker sinkage of a rigid wheel (n = 1) for load W [N], with local soil variability and slip. */
  private sinkage(load: number, x: number, z: number, slip: number): number {
    const s = this.spec;
    const soil = world().atmosphere ? SOIL.mars : SOIL.moon;
    // Soil strength varies along the path: loose drifts, crusted patches, pavement.
    const v = 0.5 * hash2(Math.floor(x / 3), Math.floor(z / 3), 17) + 0.5 * hash2(Math.floor(x / 0.9), Math.floor(z / 0.9), 29);
    const soft = 0.45 + 1.3 * v;
    const k = (soil.kc / s.wheelWidth + soil.kphi) / soft;
    const zs = Math.pow(Math.max(load, 0) / (k * s.wheelWidth * Math.sqrt(2 * s.wheelRadius)), 2 / 3);
    // Slip sinkage: a spinning wheel digs itself in.
    return THREE.MathUtils.clamp(zs * (1 + 1.6 * Math.min(1, Math.abs(slip))), 0.001, 0.09);
  }

  update(rover: Rover, dt = 1 / 60): void {
    let dirty = false;
    const fwd = rover.forwardVector(new THREE.Vector3());
    for (let t = 0; t < this.wheels.length; t++) {
      const w = this.wheels[t];
      // Tread phase follows the rim, not the ground: slip compresses/smears the imprint.
      this.rim[t] += Math.abs(rover.wheelRimSpeed[w]) * dt;
      if (!rover.wheelContact[w]) {
        this.last[t] = null;
        continue;
      }
      const c = rover.wheelWorld[w];
      const p = new THREE.Vector3(c.x, 0, c.z);
      const prev = this.last[t];
      const speed = Math.abs(rover.speed) + 1e-3;
      const slip = (Math.abs(rover.wheelRimSpeed[w]) - Math.abs(rover.speed)) / Math.max(speed, Math.abs(rover.wheelRimSpeed[w]), 0.05);
      const d = this.sinkage(rover.wheelLoad[w], c.x, c.z, slip);
      const pitch = (this.spec.wheelWidth / 2) * 4;
      if (!prev) {
        this.last[t] = p;
        this.edges(p, fwd, this.lastL[t], this.lastR[t], this.lastSide[t]);
        this.lastD[t] = d;
        this.lastV[t] = this.rim[t] / pitch;
        continue;
      }
      const dist = Math.hypot(p.x - prev.x, p.z - prev.z);
      if (dist < this.segLen) continue;
      if (dist > 3) {
        this.last[t] = p;
        this.edges(p, fwd, this.lastL[t], this.lastR[t], this.lastSide[t]);
        this.lastV[t] = this.rim[t] / pitch;
        continue;
      }
      const dir = new THREE.Vector3(p.x - prev.x, 0, p.z - prev.z).normalize();
      const L = new THREE.Vector3(), R = new THREE.Vector3(), S = new THREE.Vector3();
      this.edges(p, dir, L, R, S);
      const q = this.slot[t] * PER_TRACK + this.head[this.slot[t]];
      this.head[this.slot[t]] = (this.head[this.slot[t]] + 1) % PER_TRACK;
      const v0 = this.lastV[t], v1 = this.rim[t] / pitch;
      const verts = [this.lastL[t], this.lastR[t], L, R];
      const sides = [this.lastSide[t], this.lastSide[t], S, S];
      const depths = [this.lastD[t], this.lastD[t], d, d];
      const uvs = [0, v0, 1, v0, 0, v1, 1, v1];
      for (let k = 0; k < 4; k++) {
        this.pos.set([verts[k].x, verts[k].y, verts[k].z], (q * 4 + k) * 3);
        this.side.set([sides[k].x, sides[k].y, sides[k].z], (q * 4 + k) * 3);
        this.depth[q * 4 + k] = depths[k];
      }
      this.uv.set(uvs, q * 8);
      this.lastL[t].copy(L);
      this.lastR[t].copy(R);
      this.lastSide[t].copy(S);
      this.lastD[t] = d;
      this.lastV[t] = v1;
      this.last[t] = p;
      dirty = true;
    }
    if (dirty) {
      const g = this.mesh.geometry;
      for (const n of ['position', 'uv', 'aSide', 'aDepth']) g.getAttribute(n).needsUpdate = true;
    }
  }

  private edges(p: THREE.Vector3, dir: THREE.Vector3, L: THREE.Vector3, R: THREE.Vector3, side: THREE.Vector3): void {
    side.set(-dir.z, 0, dir.x);
    const sx = side.x * this.halfW, sz = side.z * this.halfW;
    L.set(p.x + sx, 0, p.z + sz);
    R.set(p.x - sx, 0, p.z - sz);
    L.y = this.terrain.height(L.x, L.z) + 0.012;
    R.y = this.terrain.height(R.x, R.z) + 0.012;
  }
}
