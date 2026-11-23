import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';
import { mulberry32 } from '../terrain/TerrainData';

export type WeatherMode = 'auto' | 'calm' | 'devils' | 'storm';

interface Devil {
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
  /** Envelope 0..1 (forms, lives, decays). */
  s: number;
}

const MAX_DEVILS = 8;
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
  /** Nearest dust devil influence at the rover 0..1. */
  devilNear = 0;
  /** Distance to the nearest active devil, m. */
  devilDist = Infinity;
  private devils: Devil[] = [];
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
  private stormPhase: 'calm' | 'rising' | 'peak' | 'fading' = 'calm';
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
        float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float n3(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float hg(float g, float c) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5); }
        // Column radius as a fraction of the bounding radius, by height fraction.
        float radiusAt(float y) {
          float skirt = 1.0 - smoothstep(0.0, 0.06, y);
          return mix(0.42, 0.75, smoothstep(0.0, 1.0, y)) + 0.25 * skirt;
        }
        void main() {
          float R = vS.x, H = vS.y;
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
            vec2 q = p.xz - vC.xz;
            float y = (p.y - vC.y) / H;
            float r = length(q) / R;
            float rr = radiusAt(y);
            float wall = exp(-pow((r - rr * 0.8) / (rr * 0.35 + 0.05), 2.0));
            float core = smoothstep(rr * 1.05, rr * 0.2, r) * 0.35;
            float ang = atan(q.y, q.x);
            float sw = ang * vP.z - y * 9.0 + uTime * 1.6 * vP.z;
            float nz = n3(vec3(cos(sw) * 2.0, sin(sw) * 2.0, y * 14.0 - uTime * 1.2) + vP.y * 13.0);
            nz = 0.35 + 0.65 * nz * n3(vec3(q * 0.15, y * 6.0 - uTime * 0.6) + vP.y);
            float dens = (wall + core) * nz * (1.0 - smoothstep(0.55, 1.0, y)) * (0.35 + 0.65 * (1.0 - y));
            dens += (1.0 - smoothstep(0.0, 0.05, y)) * smoothstep(1.0, 0.3, r) * 0.6 * nz;
            dens *= vP.x * 0.9 / max(R * 0.08, 0.6);
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
          float len = 0.02 + spd * 0.035;
          float wid = 0.006 + aSeed * 0.012;
          vec3 p = c + dir * position.x * len + side * position.y * wid;
          float d = length(cameraPosition - c);
          vA = uAmount * smoothstep(40.0, 10.0, d) * smoothstep(0.3, 1.5, d) * (0.4 + 0.6 * aSeed);
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
          float n = n2(p) * 0.5 + n2(p * 2.1) * 0.3 + n2(p * 4.3) * 0.2;
          float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x) * smoothstep(1.0, 0.2, vUv.y);
          float a = smoothstep(0.35, 0.8, n) * edge * uAmount * smoothstep(15.0, 60.0, vD);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a * 0.55);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.sheets = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), sheetMat, SHEETS);
    this.sheets.frustumCulled = false;
    this.sheets.renderOrder = 3;
    this.group.add(this.sheets);
  }

  setMode(m: WeatherMode): void {
    this.mode = m;
    if (m === 'storm') { this.stormPhase = 'rising'; this.stormT = 0; }
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
    (this.devilU.uAmb.value as THREE.Color).copy(amb);
    (this.devilU.uFogColor.value as THREE.Color).copy(fog);
    this.devilU.uFogDensity.value = fogDensity;
    (this.sheetU.uColor.value as THREE.Color).copy(fog).multiplyScalar(1.05);
  }

  private updateStorm(dt: number): void {
    // Automatic weather: an occasional regional storm every several minutes of driving.
    if (this.mode === 'auto' && this.stormPhase === 'calm') {
      this.stormTimer -= dt;
      if (this.stormTimer <= 0) { this.stormPhase = 'rising'; this.stormT = 0; }
    }
    this.stormT += dt;
    if (this.stormPhase === 'rising') {
      this.storm = Math.min(1, this.stormT / 45);
      if (this.storm >= 1) { this.stormPhase = 'peak'; this.stormT = 0; }
    } else if (this.stormPhase === 'peak') {
      this.storm = 1;
      if (this.mode === 'auto' && this.stormT > 120 + this.rnd() * 90) { this.stormPhase = 'fading'; this.stormT = 0; }
    } else if (this.stormPhase === 'fading') {
      this.storm = Math.max(0, 1 - this.stormT / 60);
      if (this.storm <= 0) { this.stormPhase = 'calm'; this.stormTimer = 300 + this.rnd() * 300; }
    }
    if (this.mode === 'storm' && this.stormPhase === 'calm') { this.stormPhase = 'rising'; this.stormT = 0; }
    const s = this.storm * this.storm * (3 - 2 * this.storm);
    this.tau = 0.62 + s * 3.6;
    // Wind: light afternoon breeze, gusting; storm winds 15–25 m/s.
    this.gustPh += dt;
    const gust = 1 + 0.35 * Math.sin(this.gustPh * 0.31) + 0.2 * Math.sin(this.gustPh * 1.13 + 2) + 0.12 * Math.sin(this.gustPh * 2.9);
    const speed = (3.5 + s * 17) * gust;
    const dir = Math.atan2(this.baseWind.z, this.baseWind.x) + Math.sin(this.gustPh * 0.05) * 0.3;
    this.wind.set(Math.cos(dir) * speed, 0, Math.sin(dir) * speed);
  }

  private spawnDevil(cx: number, cz: number): void {
    const a = this.rnd() * Math.PI * 2;
    const d = 250 + this.rnd() * 2200;
    const r = 4 + Math.pow(this.rnd(), 2) * 40;
    const drift = 0.5 + this.rnd();
    this.devils.push({
      x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d,
      vx: this.wind.x * drift, vz: this.wind.z * drift,
      r, h: r * (8 + this.rnd() * 14), life: 50 + this.rnd() * 160, age: 0,
      seed: this.rnd(), spin: this.rnd() < 0.5 ? 1 : -1, s: 0,
    });
  }

  update(dt: number, camera: THREE.Camera, rover: THREE.Vector3): void {
    this.time += dt;
    this.updateStorm(dt);
    const devilsOn = this.mode === 'devils' || (this.mode === 'auto' && this.storm < 0.3);
    // Dust devils: steady population while it is calm and convective.
    this.spawnTimer -= dt;
    const want = devilsOn ? (this.mode === 'devils' ? 6 : 3) : 0;
    if (this.spawnTimer <= 0 && this.devils.length < want) {
      this.spawnDevil(rover.x, rover.z);
      this.spawnTimer = this.mode === 'devils' ? 4 + this.rnd() * 6 : 15 + this.rnd() * 25;
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
      // Drift with the ambient wind plus a slow meander.
      d.vx += (this.wind.x * 0.9 - d.vx) * dt * 0.1 + Math.sin(this.time * 0.3 + d.seed * 20) * dt * 0.4;
      d.vz += (this.wind.z * 0.9 - d.vz) * dt * 0.1 + Math.cos(this.time * 0.27 + d.seed * 30) * dt * 0.4;
      d.x += d.vx * dt;
      d.z += d.vz * dt;
      const dist = Math.hypot(d.x - rover.x, d.z - rover.z);
      if (d.age > d.life || dist > 4000) {
        this.devils.splice(i, 1);
        continue;
      }
      if (dist < this.devilDist && d.s > 0.2) this.devilDist = dist - d.r * 0.5;
      this.devilNear = Math.max(this.devilNear, d.s * THREE.MathUtils.smoothstep(d.r * 3, d.r * 0.6, dist));
      if (n < MAX_DEVILS) {
        const y = this.terrain.height(d.x, d.z) - 1;
        m4.compose(p.set(d.x, y, d.z), q, sc.set(d.r, d.h, d.r));
        this.devilMesh.setMatrixAt(n, m4);
        this.devilParams.setXYZW(n, d.s, d.seed, d.spin, 0);
        n++;
      }
    }
    this.devilMesh.count = n;
    this.devilMesh.instanceMatrix.needsUpdate = true;
    this.devilParams.needsUpdate = true;
    this.devilU.uTime.value = this.time;

    // Blowing dust around the camera: wraps in an 80 m box.
    const cam = camera.position;
    const amt = Math.min(1, 0.06 + this.storm * 1.1 + this.devilNear * 0.8);
    this.blowU.uAmount.value = amt;
    (this.blowU.uWind.value as THREE.Vector3).copy(this.wind);
    const nb = this.blowSeed.length;
    const B = 80;
    for (let i = 0; i < nb; i++) {
      const k = i * 3, s = this.blowSeed[i];
      const sp = 0.6 + 0.8 * s;
      this.blowPos[k] += this.wind.x * sp * dt + Math.sin(this.time * 3 + i) * dt * 0.6;
      this.blowPos[k + 2] += this.wind.z * sp * dt + Math.cos(this.time * 2.7 + i) * dt * 0.6;
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
        const gy = this.terrain.height(this.sheetPos[k], this.sheetPos[k + 2]) - 5;
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
