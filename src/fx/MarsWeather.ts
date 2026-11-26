import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';
import { mulberry32 } from '../terrain/TerrainData';
import { DevilDust } from './DevilDust';
import { StormFront } from './StormFront';

export type WeatherMode = 'auto' | 'calm' | 'devils' | 'storm';

interface Devil {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  h: number;
  life: number;
  age: number;
  seed: number;
  spin: number;
  /** Downwind bend of the column top (wind shear). */
  bend: number;
  /** Own course off the ambient wind, rad: devils are steered by local convection too. */
  course: number;
  /** Envelope 0..1 (forms, lives, decays). */
  s: number;
}

const MAX_DEVILS = 8;
/** Storm front: first seen this far out, m; speed, m/s; the storm sets in over its last metres. */
const FRONT_START = 4500;
const FRONT_SPEED = 22;
const FRONT_ARRIVE = 500;
const BLOW_N = 2600;
const SHEETS = 14;

/**
 * Martian weather around the rover.
 *
 * Dust devils: convective vortices of the afternoon, metres to tens of metres
 * wide and up to hundreds of metres tall (Perseverance filmed many crossing the
 * Jezero floor at 5–10 m/s). Each is drawn by ray-marching a swirling dust
 * column inside a bounding cylinder: density peaks in the vortex wall and in the
 * debris skirt at the base, lit with forward scattering.
 *
 * Dust storms: the optical depth climbs from ~0.6 to 3–5, winds rise to
 * 15–25 m/s, saltating sand and suspended dust stream past, the sky darkens and
 * the light turns diffuse. Thin air means even storm winds push a rover with
 * only a few tens of newtons — the real hazard is the loss of solar power.
 */
export class MarsWeather {
  readonly group = new THREE.Group();
  mode: WeatherMode = 'auto';
  /** Optical depth τ of the dust. */
  tau = 0.62;
  /** Surface wind, m/s (x east, z south). */
  readonly wind = new THREE.Vector3(3, 0, -1.5);
  /** 0..1 storm strength (drives particles, sound). */
  storm = 0;
  /** Dust settled on the ground by storms, 0..1 (fades slowly in calm wind). */
  settled = 0;
  /** Nearest dust devil influence at the rover 0..1. */
  devilNear = 0;
  /** Distance to the nearest active devil, m. */
  devilDist = Infinity;
  private devils: Devil[] = [];
  private devilId = 0;
  /** Particles at the devils' feet and their dark tracks. */
  readonly feet: DevilDust;
  private devilMesh: THREE.InstancedMesh;
  private devilParams: THREE.InstancedBufferAttribute;
  private devilU: Record<string, THREE.IUniform>;
  private blow: THREE.InstancedMesh;
  private blowPos: Float32Array;
  private blowSeed: Float32Array;
  private blowU: Record<string, THREE.IUniform>;
  private sheets: THREE.InstancedMesh;
  private sheetU: Record<string, THREE.IUniform>;
  private sheetPos: Float32Array;
  private rnd = mulberry32(2021);
  private time = 0;
  private stormTimer = 240 + Math.random() * 240;
  private stormPhase: 'calm' | 'approach' | 'peak' | 'fading' = 'calm';
  /** The storm's leading edge: a wall of dust coming in from the side. */
  readonly front: StormFront;
  /** Front distance from the rover, m, and the world angle it comes from. */
  private frontDist = 0;
  private frontAng = 0;
  /** Camera heading (world angle of the view direction), for where the storm appears. */
  private camAng = 0;
  private strikeTimer = 3;
  /** Lightning struck the ground at (x, z), dist metres from the rover. */
  onStrike?: (x: number, z: number, dist: number) => void;
  private stormT = 0;
  private spawnTimer = 3;
  private gustPh = Math.random() * 100;
  private baseWind = new THREE.Vector3(3, 0, -1.5);

  constructor(private terrain: TerrainData, sunDir: THREE.Vector3, quality: number) {
    // ---- Dust devils.
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 28, 1, false);
    cyl.translate(0, 0.5, 0);
    this.devilU = {
      uSun: { value: sunDir.clone() },
      uTime: { value: 0 },
      uLight: { value: new THREE.Color(1, 0.8, 0.6) },
      uAmb: { value: new THREE.Color(0.4, 0.28, 0.2) },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
    };
    const devilMat = new THREE.ShaderMaterial({
      uniforms: this.devilU,
      vertexShader: /* glsl */ `
        attribute vec4 aP; // strength, seed, spin, wall
        varying vec3 vW;
        varying vec3 vC;
        varying vec3 vS; // r, h, base y
        varying vec4 vP;
        void main() {
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vC = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), 0.0);
          vP = aP;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW;
        varying vec3 vC;
        varying vec3 vS;
        varying vec4 vP;
        uniform vec3 uSun;
        uniform float uTime;
        uniform vec3 uLight;
        uniform vec3 uAmb;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec2 uWindDir;
        float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float n3(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float hg(float g, float c) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5); }
        // Column radius as a fraction of the bounding radius, by height fraction.
        float radiusAt(float y) {
          // Debris skirt at the foot (the inflow layer), a narrow waist, then a column
          // widening upward as it entrains air.
          float skirt = 1.0 - smoothstep(0.0, 0.07, y);
          return mix(0.38, 0.8, smoothstep(0.05, 1.0, y)) + 0.75 * skirt * skirt;
        }
        void main() {
          // Bounding cylinder radius R = 3.6 × the column radius rc (room for the bent, swaying axis).
          float R = vS.x, H = vS.y, rc = R / 3.6;
          vec3 ro = cameraPosition, rd = normalize(vW - cameraPosition);
          // Ray vs. vertical cylinder (centre vC, radius R).
          vec2 oc = ro.xz - vC.xz;
          float a = dot(rd.xz, rd.xz), b = dot(oc, rd.xz), c = dot(oc, oc) - R * R;
          float disc = b * b - a * c;
          if (disc <= 0.0 || a < 1e-6) discard;
          float sq = sqrt(disc);
          float t0 = max((-b - sq) / a, 0.0), t1 = (-b + sq) / a;
          // Clip to the slab vC.y .. vC.y + H.
          if (abs(rd.y) > 1e-5) {
            float ya = (vC.y - ro.y) / rd.y, yb = (vC.y + H - ro.y) / rd.y;
            t0 = max(t0, min(ya, yb));
            t1 = min(t1, max(ya, yb));
          }
          if (t1 <= t0) discard;
          const int N = 14;
          float dt = (t1 - t0) / float(N);
          float trans = 1.0;
          vec3 col = vec3(0.0);
          float phase = 0.7 * hg(0.6, dot(rd, uSun)) + 0.3;
          vec2 sunH = normalize(uSun.xz + 1e-4);
          for (int i = 0; i < N; i++) {
            float t = t0 + (float(i) + 0.5 + 0.5 * h3(vW * 7.0 + float(i))) * dt;
            vec3 p = ro + rd * t;
            float y = (p.y - vC.y) / H;
            // Axis: wind shear bends the top downwind (stronger wind aloft); the column also
            // meanders and sways, more so with height.
            vec2 axis = uWindDir * vP.w * y * y * rc * 2.6
              + vec2(sin(uTime * 0.37 + y * 4.0 + vP.y * 20.0), cos(uTime * 0.29 + y * 3.1 + vP.y * 11.0)) * rc * 0.55 * y;
            vec2 q = p.xz - vC.xz - axis;
            float r = length(q) / rc;
            float rr = radiusAt(y);
            float wall = exp(-pow((r - rr * 0.8) / (rr * 0.35 + 0.05), 2.0));
            float core = smoothstep(rr * 1.05, rr * 0.2, r) * 0.35;
            float ang = atan(q.y, q.x);
            // Rotating, rising spiral streaks: dust is carried round (~2.5 rad/s) and lifted.
            // Angular speed falls with radius and height (Rankine: Ω ∝ 1/r² outside the core).
            float omega = 3.2 / (0.6 + r * r) * (1.0 - 0.5 * y);
            float sw = ang - vP.z * (uTime * omega - y * 9.0);
            // Upper column: laminar — a few smooth helical dust sheets winding up the wall.
            float helix = 0.5 + 0.5 * sin(sw * 3.0 + y * 22.0 * vP.z);
            float lamN = mix(0.55, 1.0, smoothstep(0.25, 0.9, helix)) * (0.75 + 0.25 * n3(vec3(cos(sw), sin(sw), y * 4.0 - uTime * 0.6) * 1.5 + vP.y * 13.0));
            // Foot: turbulent — fast, small, intermittent eddies and bursts of debris.
            float tA = n3(vec3(cos(sw) * 5.0, sin(sw) * 5.0, y * 60.0 - uTime * 6.0) + vP.y * 7.0);
            float tB = n3(vec3(q / rc * 3.0, y * 40.0 - uTime * 4.5) + vP.y * 3.0);
            float tC = n3(vec3(q / rc * 7.0 + uTime * 1.3, y * 90.0) + vP.y);
            float turbN = smoothstep(0.25, 0.85, tA * 0.5 + tB * 0.35 + tC * 0.25) * 1.4;
            float lam = smoothstep(0.06, 0.3, y);
            float nz = mix(turbN, lamN, lam) * (0.6 + 0.4 * n3(vec3(q / rc * 0.8, y * 5.0 - uTime * 0.7) + vP.y));
            float dens = (wall + core) * nz * (1.0 - smoothstep(0.55, 1.0, y)) * (0.35 + 0.65 * (1.0 - y));
            // Dense debris skirt hugging the ground, wider than the column.
            dens += (1.0 - smoothstep(0.0, 0.07, y)) * smoothstep(1.6, 0.4, r) * 0.9 * nz;
            dens *= vP.x * 1.3 / max(rc * 0.3, 0.6);
            float lit = 0.55 + 0.45 * dot(normalize(q + 1e-4), sunH);
            // Martian dust: single-scattering albedo ~0.9 in red, lower in blue.
            vec3 c = (uLight * phase * lit + uAmb) * vec3(0.92, 0.66, 0.46);
            float a1 = 1.0 - exp(-dens * dt * 0.6);
            col += trans * a1 * c;
            trans *= 1.0 - a1;
            if (trans < 0.03) break;
          }
          float alpha = 1.0 - trans;
          if (alpha < 0.004) discard;
          col /= max(alpha, 1e-3);
          float dist = length(vC - cameraPosition);
          float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
          col = mix(col, uFogColor, fog);
          gl_FragColor = vec4(col, alpha * (1.0 - fog * 0.6));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
    });
    this.devilMesh = new THREE.InstancedMesh(cyl, devilMat, MAX_DEVILS);
    this.devilParams = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEVILS * 4), 4);
    this.devilMesh.geometry.setAttribute('aP', this.devilParams);
    this.devilMesh.count = 0;
    this.devilMesh.frustumCulled = false;
    this.devilMesh.renderOrder = 3;
    this.group.add(this.devilMesh);
    this.feet = new DevilDust(terrain);
    this.group.add(this.feet.points, this.feet.track);

    // ---- Blowing sand and dust: streaks in a box around the camera, advected by the wind.
    const n = Math.round(BLOW_N * quality);
    this.blowPos = new Float32Array(n * 3);
    this.blowSeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.blowPos[i * 3] = (this.rnd() - 0.5) * 80;
      this.blowPos[i * 3 + 1] = Math.pow(this.rnd(), 2.2) * 14;
      this.blowPos[i * 3 + 2] = (this.rnd() - 0.5) * 80;
      this.blowSeed[i] = this.rnd();
    }
    this.blowU = {
      uWind: { value: new THREE.Vector3() },
      uAmount: { value: 0 },
      uLight: this.devilU.uLight,
      uAmb: this.devilU.uAmb,
      uSun: this.devilU.uSun,
    };
    const blowMat = new THREE.ShaderMaterial({
      uniforms: this.blowU,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform vec3 uWind;
        uniform float uAmount;
        uniform vec3 uSun;
        varying float vA;
        varying vec2 vUv;
        varying float vPh;
        void main() {
          vUv = uv;
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec3 v = uWind * (0.6 + 0.8 * aSeed);
          float spd = length(v) + 0.01;
          vec3 dir = v / spd;
          vec3 toCam = normalize(cameraPosition - c);
          vec3 side = normalize(cross(dir, toCam) + 1e-4);
          // Size spectrum: most grains are tiny specks, a few coarse sand grains and
          // larger dust clumps (power law in the seed).
          float sz = 0.002 + 0.03 * pow(aSeed, 4.0);
          float len = sz + spd * (0.01 + 0.03 * aSeed);
          float wid = sz;
          vec3 p = c + dir * position.x * len + side * position.y * wid;
          float d = length(cameraPosition - c);
          vA = uAmount * smoothstep(40.0, 10.0, d) * smoothstep(0.3, 1.5, d) * (0.5 + 0.5 * aSeed);
          vPh = 0.7 * pow(max(dot(-toCam, uSun), 0.0), 4.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        varying vec2 vUv;
        varying float vPh;
        uniform vec3 uLight;
        uniform vec3 uAmb;
        void main() {
          vec2 q = vUv - 0.5;
          float a = exp(-dot(q * vec2(2.0, 5.0), q * vec2(2.0, 5.0)) * 4.0) * vA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uLight * (0.35 + vPh) + uAmb, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    this.blow = new THREE.InstancedMesh(quad, blowMat, n);
    quad.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.blowSeed, 1));
    this.blow.frustumCulled = false;
    this.blow.renderOrder = 4;
    this.group.add(this.blow);

    // ---- Dust sheets: large soft billboards drifting with the wind (visible fronts of the storm).
    this.sheetPos = new Float32Array(SHEETS * 3);
    for (let i = 0; i < SHEETS; i++) {
      const a = this.rnd() * Math.PI * 2, d = 60 + this.rnd() * 500;
      this.sheetPos.set([Math.cos(a) * d, 0, Math.sin(a) * d], i * 3);
    }
    this.sheetU = {
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uColor: { value: new THREE.Color() },
      uFogColor: this.devilU.uFogColor,
    };
    const sheetMat = new THREE.ShaderMaterial({
      uniforms: this.sheetU,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vSeed;
        varying float vD;
        void main() {
          vUv = uv;
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
          vSeed = fract(c.x * 0.013 + c.z * 0.007);
          vec3 toCam = cameraPosition - c;
          toCam.y = 0.0;
          vec3 f = normalize(toCam + 1e-4);
          vec3 r = vec3(f.z, 0.0, -f.x);
          vec3 p = c + r * position.x * sx + vec3(0.0, 1.0, 0.0) * (position.y + 0.5) * sy;
          vD = length(cameraPosition - c);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vSeed;
        varying float vD;
        uniform float uTime;
        uniform float uAmount;
        uniform vec3 uColor;
        float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          vec2 p = vUv * vec2(3.0, 2.0) + vec2(-uTime * 0.05, -uTime * 0.02) + vSeed * 10.0;
          // Rotated octaves (no grid-aligned blobs).
          mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
          float n = n2(p) * 0.5 + n2(R * p * 2.1 + 3.1) * 0.3 + n2(R * R * p * 4.3 + 7.7) * 0.2;
          // Soft on every side; the base fades out well above where the sheet meets the
          // ground, so no hard line where it cuts the terrain.
          float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x)
                     * smoothstep(1.0, 0.3, vUv.y) * smoothstep(0.0, 0.35, vUv.y);
          float a = smoothstep(0.3, 0.85, n) * edge * uAmount * smoothstep(25.0, 90.0, vD);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a * 0.55);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.front = new StormFront({
      uLight: this.devilU.uLight, uAmb: this.devilU.uAmb, uSun: this.devilU.uSun,
      uFogColor: this.devilU.uFogColor, uFogDensity: this.devilU.uFogDensity,
    });
    this.group.add(this.front.group);
    this.sheets = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), sheetMat, SHEETS);
    this.sheets.frustumCulled = false;
    this.sheets.renderOrder = 3;
    this.group.add(this.sheets);
  }

  setMode(m: WeatherMode): void {
    this.mode = m;
    if (m === 'storm' && this.stormPhase !== 'approach' && this.stormPhase !== 'peak') this.startFront();
    if (m === 'calm' || m === 'devils') { if (this.stormPhase !== 'calm') { this.stormPhase = 'fading'; this.stormT = 0; } }
  }

  /** Cycle the weather from the toolbar / B key. */
  cycle(): WeatherMode {
    const order: WeatherMode[] = ['auto', 'calm', 'devils', 'storm'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
    return this.mode;
  }

  /** Light colours for the dust (sun-lit and sky-lit parts), linear. */
  setLighting(sun: THREE.Color, amb: THREE.Color, fog: THREE.Color, fogDensity: number): void {
    (this.devilU.uLight.value as THREE.Color).copy(sun);
    this.feet.setLight(new THREE.Color(0.92, 0.66, 0.46).multiply(sun.clone().multiplyScalar(0.55).add(amb)));
    (this.devilU.uAmb.value as THREE.Color).copy(amb);
    (this.devilU.uFogColor.value as THREE.Color).copy(fog);
    this.devilU.uFogDensity.value = fogDensity;
    (this.sheetU.uColor.value as THREE.Color).copy(fog).multiplyScalar(1.05);
  }

  private updateStorm(dt: number): void {
    // Automatic weather: an occasional regional storm every several minutes of driving.
    if (this.mode === 'auto' && this.stormPhase === 'calm') {
      this.stormTimer -= dt;
      if (this.stormTimer <= 0) this.startFront();
    }
    this.stormT += dt;
    if (this.stormPhase === 'approach') {
      // The front rolls in at ~22 m/s; the storm proper begins as its edge reaches the rover.
      this.frontDist -= FRONT_SPEED * dt;
      this.storm = THREE.MathUtils.smoothstep(-this.frontDist, -FRONT_ARRIVE, 150);
      if (this.frontDist < -150) { this.stormPhase = 'peak'; this.stormT = 0; this.storm = 1; }
    } else if (this.stormPhase === 'peak') {
      this.storm = 1;
      if (this.mode === 'auto' && this.stormT > 120 + this.rnd() * 90) { this.stormPhase = 'fading'; this.stormT = 0; }
    } else if (this.stormPhase === 'fading') {
      this.storm = Math.max(0, 1 - this.stormT / 60);
      if (this.storm <= 0) { this.stormPhase = 'calm'; this.stormTimer = 300 + this.rnd() * 300; }
    }
    if (this.mode === 'storm' && this.stormPhase === 'calm') this.startFront();
    const s = this.storm * this.storm * (3 - 2 * this.storm);
    this.tau = 0.62 + s * 3.6;
    // Fallout builds over a few minutes of storm, then is slowly blown off again.
    this.settled = Math.min(1, Math.max(0, this.settled + (s > 0.4 ? s * dt / 90 : -dt / 600)));
    // Wind: light afternoon breeze, gusting; storm winds 15–25 m/s.
    this.gustPh += dt;
    const gust = 1 + 0.35 * Math.sin(this.gustPh * 0.31) + 0.2 * Math.sin(this.gustPh * 1.13 + 2) + 0.12 * Math.sin(this.gustPh * 2.9);
    const speed = (5 + s * 16) * gust;
    // In a storm the wind veers unpredictably (turbulent gusts on several time scales).
    const veer = s * (0.5 * Math.sin(this.gustPh * 0.23 + 1) + 0.3 * Math.sin(this.gustPh * 0.61) + 0.18 * Math.sin(this.gustPh * 1.7 + 4));
    const dir = Math.atan2(this.baseWind.z, this.baseWind.x) + Math.sin(this.gustPh * 0.05) * 0.3 + veer;
    this.wind.set(Math.cos(dir) * speed, 0, Math.sin(dir) * speed);
  }

  /**
   * A storm is born out on the plain, off to one side of where the camera looks (so it
   * can be watched coming), FRONT_START metres away; the wind turns to blow from it.
   */
  private startFront(): void {
    this.stormPhase = 'approach';
    this.stormT = 0;
    const side = this.rnd() < 0.5 ? -1 : 1;
    this.frontAng = this.camAng + side * (0.45 + this.rnd() * 0.5);
    this.frontDist = FRONT_START;
    const ws = Math.hypot(this.baseWind.x, this.baseWind.z) || 3;
    this.baseWind.set(-Math.cos(this.frontAng) * ws, 0, -Math.sin(this.frontAng) * ws);
  }

  private spawnDevil(cx: number, cz: number): void {
    // Mostly upwind (they drift toward the rover), 150–1200 m out; now and then close.
    const wl = Math.hypot(this.wind.x, this.wind.z) || 1;
    const up = Math.atan2(-this.wind.z / wl, -this.wind.x / wl);
    const a = up + (this.rnd() - 0.5) * 2.4;
    const d = this.rnd() < 0.25 ? 60 + this.rnd() * 120 : 150 + this.rnd() * 1050;
    const r = 3 + Math.pow(this.rnd(), 2) * 30;
    const drift = 0.5 + this.rnd();
    this.devils.push({
      id: this.devilId++,
      x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d,
      vx: this.wind.x * drift, vz: this.wind.z * drift,
      r, h: r * (8 + this.rnd() * 14), life: 50 + this.rnd() * 160, age: 0,
      seed: this.rnd(), spin: this.rnd() < 0.5 ? 1 : -1, s: 0, bend: 0.25 + this.rnd() * 0.6,
      course: (this.rnd() - 0.5) * 2.8,
    });
  }

  update(dt: number, camera: THREE.Camera, rover: THREE.Vector3): void {
    this.time += dt;
    this.updateStorm(dt);
    const devilsOn = this.mode === 'devils' || (this.mode === 'auto' && this.storm < 0.3);
    // Dust devils: steady population while it is calm and convective.
    this.spawnTimer -= dt;
    const want = devilsOn ? (this.mode === 'devils' ? 7 : 4) : 0;
    if (this.spawnTimer <= 0 && this.devils.length < want) {
      this.spawnDevil(rover.x, rover.z);
      this.spawnTimer = this.mode === 'devils' ? 3 + this.rnd() * 5 : 8 + this.rnd() * 14;
    }
    this.devilNear = 0;
    this.devilDist = Infinity;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    let n = 0;
    for (let i = this.devils.length - 1; i >= 0; i--) {
      const d = this.devils[i];
      d.age += dt;
      const fadeIn = Math.min(1, d.age / 12), fadeOut = Math.min(1, (d.life - d.age) / 15);
      d.s = Math.max(0, Math.min(fadeIn, fadeOut)) * (devilsOn ? 1 : Math.max(0, 1 - this.storm * 3));
      // Devils travel roughly with the ambient wind (Perseverance saw 3–10 m/s) but each on
      // its own course, wandering on several time scales: their tracks curve and cross
      // instead of running in parallel (cf. HiRISE images of devil tracks).
      // Near the ground the convective wind keeps veering: the paths meander on several
      // time scales and now and then curl into a loop.
      const wander = d.course + 1.0 * Math.sin(this.time * 0.09 + d.seed * 40) + 0.6 * Math.sin(this.time * 0.29 + d.seed * 71)
        + 0.35 * Math.sin(this.time * 0.83 + d.seed * 13) + 1.6 * Math.max(0, Math.sin(this.time * 0.05 + d.seed * 97) - 0.75) * 4;
      const cw = Math.cos(wander), sw = Math.sin(wander);
      const tx = (this.wind.x * cw - this.wind.z * sw) * 1.3, tz = (this.wind.x * sw + this.wind.z * cw) * 1.3;
      d.vx += (tx - d.vx) * dt * 0.3 + Math.sin(this.time * 0.9 + d.seed * 20) * dt * 1.5;
      d.vz += (tz - d.vz) * dt * 0.3 + Math.cos(this.time * 0.7 + d.seed * 30) * dt * 1.5;
      d.x += d.vx * dt;
      d.z += d.vz * dt;
      const dist = Math.hypot(d.x - rover.x, d.z - rover.z);
      if (d.age > d.life || dist > 4000) {
        this.devils.splice(i, 1);
        continue;
      }
      if (dist < this.devilDist && d.s > 0.2) this.devilDist = dist - d.r * 0.5;
      // Eases in from 4 radii to the core (the arguments were swapped before: it switched on at once).
      this.devilNear = Math.max(this.devilNear, d.s * (1 - THREE.MathUtils.smoothstep(dist, d.r * 0.5, d.r * 4)));
      if (n < MAX_DEVILS) {
        const y = this.terrain.height(d.x, d.z) - 1;
        m4.compose(p.set(d.x, y, d.z), q, sc.set(d.r * 3.6, d.h, d.r * 3.6));
        this.devilMesh.setMatrixAt(n, m4);
        this.devilParams.setXYZW(n, d.s, d.seed, d.spin, d.bend);
        n++;
      }
    }
    this.devilMesh.count = n;
    this.devilMesh.instanceMatrix.needsUpdate = true;
    this.devilParams.needsUpdate = true;
    this.feet.update(dt, this.devils, camera.position);
    this.devilU.uTime.value = this.time;
    const wl = Math.hypot(this.wind.x, this.wind.z) || 1;
    (this.devilU.uWindDir.value as THREE.Vector2).set(this.wind.x / wl, this.wind.z / wl);

    // Blowing dust around the camera: wraps in an 80 m box.
    const cam = camera.position;
    const fwd = camera.getWorldDirection(p);
    this.camAng = Math.atan2(fwd.z, fwd.x);
    // The front: fades in far out, fades as it passes over (inside, the storm haze takes over).
    const approaching = this.stormPhase === 'approach';
    const wallAmt = approaching ? (1 - THREE.MathUtils.smoothstep(this.frontDist, FRONT_START - 600, FRONT_START)) * THREE.MathUtils.smoothstep(this.frontDist, -100, 250) : 0;
    this.front.update(dt, cam, this.terrain.height(cam.x, cam.z), Math.max(this.frontDist, 1), this.frontAng, wallAmt, this.rnd);
    // Inside the front zone (its leading 350 m and the first ~40 s of the storm) lightning
    // strikes the ground around the rover - now and then the rover itself.
    const inFront = (approaching && Math.abs(this.frontDist) < 350) || (this.stormPhase === 'peak' && this.stormT < 40);
    if (inFront) {
      this.strikeTimer -= dt;
      if (this.strikeTimer <= 0) {
        this.strikeTimer = 3 + this.rnd() * 9;
        // Distance: mostly tens to hundreds of metres; ~1 in 6 close enough to hit the rover.
        const d = this.rnd() < 0.17 ? this.rnd() * 10 : 15 + Math.pow(this.rnd(), 1.5) * 260;
        const a = this.rnd() * Math.PI * 2;
        const x = rover.x + Math.cos(a) * d, z = rover.z + Math.sin(a) * d;
        this.front.strike(x, z, this.terrain.height(x, z), cam, this.rnd);
        this.onStrike?.(x, z, d);
      }
    } else this.strikeTimer = 2 + this.rnd() * 4;
    const amt = Math.min(1, 0.06 + this.storm * 1.1 + this.devilNear * 0.8);
    this.blowU.uAmount.value = amt;
    (this.blowU.uWind.value as THREE.Vector3).copy(this.wind);
    const nb = this.blowSeed.length;
    const B = 80;
    for (let i = 0; i < nb; i++) {
      const k = i * 3, s = this.blowSeed[i];
      const sp = 0.6 + 0.8 * s;
      // Turbulent swirl, much stronger in a storm: grains do not all fly the same way.
      const sw = 0.6 + this.storm * 4;
      this.blowPos[k] += this.wind.x * sp * dt + (Math.sin(this.time * 3 + i) + Math.sin(this.time * 0.8 + i * 0.37)) * dt * sw;
      this.blowPos[k + 2] += this.wind.z * sp * dt + (Math.cos(this.time * 2.7 + i) + Math.cos(this.time * 0.9 + i * 0.53)) * dt * sw;
      this.blowPos[k + 1] += Math.sin(this.time * 1.9 + i * 1.3) * dt * 0.4;
      let x = this.blowPos[k] - cam.x, z = this.blowPos[k + 2] - cam.z;
      if (x > B / 2) x -= B; else if (x < -B / 2) x += B;
      if (z > B / 2) z -= B; else if (z < -B / 2) z += B;
      this.blowPos[k] = cam.x + x;
      this.blowPos[k + 2] = cam.z + z;
    }
    if (amt > 0.01) {
      for (let i = 0; i < nb; i++) {
        const k = i * 3;
        const gy = this.terrain.height(this.blowPos[k], this.blowPos[k + 2]);
        m4.makeTranslation(this.blowPos[k], gy + 0.05 + this.blowPos[k + 1] * (0.3 + this.storm), this.blowPos[k + 2]);
        this.blow.setMatrixAt(i, m4);
      }
      this.blow.count = nb;
      this.blow.instanceMatrix.needsUpdate = true;
    } else this.blow.count = 0;

    // Storm sheets: drift with the wind, respawn upwind of the camera.
    this.sheetU.uTime.value = this.time;
    this.sheetU.uAmount.value = this.storm;
    if (this.storm > 0.01) {
      const wl = Math.hypot(this.wind.x, this.wind.z) || 1;
      for (let i = 0; i < SHEETS; i++) {
        const k = i * 3;
        this.sheetPos[k] += this.wind.x * dt;
        this.sheetPos[k + 2] += this.wind.z * dt;
        const dx = this.sheetPos[k] - cam.x, dz = this.sheetPos[k + 2] - cam.z;
        if (Math.hypot(dx, dz) > 650) {
          const a = this.rnd() * 1.6 - 0.8;
          const ux = -this.wind.x / wl, uz = -this.wind.z / wl;
          const d = 300 + this.rnd() * 300;
          this.sheetPos[k] = cam.x + (ux * Math.cos(a) - uz * Math.sin(a)) * d;
          this.sheetPos[k + 2] = cam.z + (ux * Math.sin(a) + uz * Math.cos(a)) * d;
        }
        const w = 120 + (i % 5) * 60, h = 40 + (i % 3) * 35;
        const gy = this.terrain.height(this.sheetPos[k], this.sheetPos[k + 2]) - 2;
        m4.compose(p.set(this.sheetPos[k], gy, this.sheetPos[k + 2]), q, sc.set(w, h, 1));
        this.sheets.setMatrixAt(i, m4);
      }
      this.sheets.count = SHEETS;
      this.sheets.instanceMatrix.needsUpdate = true;
    } else this.sheets.count = 0;
  }

  /** Devil positions for the minimap. */
  devilList(): { x: number; z: number; r: number; s: number }[] {
    return this.devils.map((d) => ({ x: d.x, z: d.z, r: d.r, s: d.s }));
  }
}
