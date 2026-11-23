import * as THREE from 'three';
import { azElToDir } from './Sky';

/**
 * Martian daytime sky. Suspended dust (≈1.5 µm, optical depth τ ≈ 0.5–0.9 in
 * clear weather) absorbs blue and scatters strongly forward: the sky is
 * butterscotch, brighter and hazier toward the horizon, and around the Sun the
 * forward-scattered light is bluish — most visibly at sunset. In a dust storm
 * (τ 3–8) the sky goes dark brown, the Sun fades to a dim disc and then vanishes,
 * and the light becomes diffuse.
 *
 * The same model (in JS) gives the aerial-perspective colour for the fog and the
 * colours of the sky and ground fill lights.
 */
const SKY_GLSL = /* glsl */ `
uniform vec3 uSun;
uniform float uTau;
uniform float uTime;
uniform float uCloud;
vec3 marsSky(vec3 d) {
  float el = max(d.y, -0.02);
  float sunEl = uSun.y;
  float mu = dot(d, uSun);
  float ang = acos(clamp(mu, -1.0, 1.0));
  float storm = smoothstep(0.8, 4.0, uTau);
  // Daylight level: falls off as the Sun nears the horizon; storms darken everything.
  float day = smoothstep(-0.12, 0.35, sunEl) * (0.35 + 0.65 * smoothstep(-0.05, 0.6, sunEl));
  day *= exp(-max(uTau - 0.6, 0.0) * 0.28);
  // Path length through the dusty layer: brighter, lighter toward the horizon.
  float air = 1.0 / (el + 0.1);
  vec3 zen = vec3(0.30, 0.19, 0.115);
  vec3 hor = vec3(0.68, 0.44, 0.27);
  vec3 col = mix(zen, hor, 1.0 - exp(-air * 0.32));
  // Forward-scattering aureole: blue core near the Sun, warm wide glow.
  float blueCore = exp(-ang / mix(0.11, 0.3, storm)) * (1.0 - storm * 0.8);
  float glow = exp(-ang / mix(0.55, 1.2, storm));
  vec3 blue = vec3(0.42, 0.56, 0.86);
  col += blue * blueCore * (0.9 + 1.4 * smoothstep(0.35, 0.0, sunEl));
  col += vec3(0.85, 0.62, 0.42) * glow * 0.45;
  // Antisolar side slightly darker; storms flatten everything into brown murk.
  col *= 0.85 + 0.15 * (mu * 0.5 + 0.5);
  col = mix(col, vec3(0.30, 0.19, 0.12) * (0.8 + 0.4 * glow), storm);
  // Thin water-ice cirrus, drifting (bright in forward scatter).
  if (uCloud > 0.0 && d.y > 0.02) {
    vec2 p = d.xz / (d.y + 0.15) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float c = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { c += a * (sin(p.x * 1.7 + sin(p.y * 2.3)) * 0.5 + 0.5) * (sin(p.y * 3.1 + p.x * 0.6) * 0.5 + 0.5); p *= 2.13; a *= 0.5; }
    c = smoothstep(0.42, 0.75, c) * uCloud * (1.0 - storm) * smoothstep(0.02, 0.25, d.y);
    col = mix(col, vec3(0.85, 0.82, 0.8) * (0.55 + 1.2 * glow), c * 0.35);
  }
  return col * day;
}
`;

export class MarsSky {
  readonly mesh: THREE.Mesh;
  readonly sunDir: THREE.Vector3;
  readonly uniforms = {
    uSun: { value: new THREE.Vector3() },
    uTau: { value: 0.6 },
    uTime: { value: 0 },
    uCloud: { value: 0.6 },
    uSunR: { value: THREE.MathUtils.degToRad(0.35 / 2) },
    uBright: { value: 6.5 },
  };
  private sunDisc: THREE.Mesh;

  constructor(sunAz: number, sunEl: number) {
    this.sunDir = azElToDir(sunAz, sunEl);
    this.uniforms.uSun.value.copy(this.sunDir);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec3 vD;
        uniform float uBright;
        ${SKY_GLSL}
        void main() {
          vec3 d = normalize(vD);
          gl_FragColor = vec4(marsSky(d) * uBright, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(9000, 64, 32), mat);
    this.mesh.renderOrder = -11;
    this.mesh.frustumCulled = false;

    // The Sun from Mars: 0.35° (0.66 × the size seen from Earth), dimmed and reddened through the dust.
    const discMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec3 uSun;
        uniform float uTau;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float am = 1.0 / max(uSun.y, 0.03);
          float trans = exp(-uTau * am * 0.9);
          float blur = 0.08 + 0.5 * smoothstep(1.0, 5.0, uTau);
          float disc = 1.0 - smoothstep(0.32 - blur * 0.3, 0.32 + blur, r);
          float halo = exp(-r * 5.0) * 0.25;
          vec3 c = vec3(1.0, 0.93, 0.85) * (disc * 60.0 + halo * 6.0) * trans;
          gl_FragColor = vec4(c, (disc + halo) * min(1.0, trans * 30.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const dist = 8800;
    const size = dist * Math.tan(this.uniforms.uSunR.value) * 2 * 3.2;
    this.sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(size, size), discMat);
    this.sunDisc.position.copy(this.sunDir).multiplyScalar(dist);
    this.sunDisc.lookAt(0, 0, 0);
    this.sunDisc.renderOrder = -10;
    this.sunDisc.frustumCulled = false;
    this.mesh.add(this.sunDisc);
  }

  /** CPU copy of the sky model (linear RGB, before uBright), for fog and fill lights. */
  colorAt(d: THREE.Vector3, out: THREE.Color): THREE.Color {
    const u = this.uniforms;
    const tau = u.uTau.value;
    const s = this.sunDir;
    const ss = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const el = Math.max(d.y, -0.02);
    const mu = d.dot(s);
    const ang = Math.acos(Math.min(1, Math.max(-1, mu)));
    const storm = ss(0.8, 4, tau);
    let day = ss(-0.12, 0.35, s.y) * (0.35 + 0.65 * ss(-0.05, 0.6, s.y));
    day *= Math.exp(-Math.max(tau - 0.6, 0) * 0.28);
    const air = 1 / (el + 0.1);
    const k = 1 - Math.exp(-air * 0.32);
    let r = 0.3 + (0.68 - 0.3) * k, g = 0.19 + (0.44 - 0.19) * k, b = 0.115 + (0.27 - 0.115) * k;
    const lerp = (a: number, c: number, t: number) => a + (c - a) * t;
    const blueCore = Math.exp(-ang / lerp(0.11, 0.3, storm)) * (1 - storm * 0.8);
    const glow = Math.exp(-ang / lerp(0.55, 1.2, storm));
    const bc = 0.9 + 1.4 * ss(0.35, 0, s.y);
    r += 0.42 * blueCore * bc + 0.85 * glow * 0.45;
    g += 0.56 * blueCore * bc + 0.62 * glow * 0.45;
    b += 0.86 * blueCore * bc + 0.42 * glow * 0.45;
    const side = 0.85 + 0.15 * (mu * 0.5 + 0.5);
    r *= side; g *= side; b *= side;
    const m = 0.8 + 0.4 * glow;
    r = lerp(r, 0.3 * m, storm);
    g = lerp(g, 0.19 * m, storm);
    b = lerp(b, 0.12 * m, storm);
    return out.setRGB(r * day, g * day, b * day);
  }

  update(camera: THREE.Camera, time: number, tau: number): void {
    this.mesh.position.copy(camera.position);
    this.uniforms.uTime.value = time;
    this.uniforms.uTau.value = tau;
  }

  /** Direct-beam transmission (effective, forward scattering folded in). */
  directTransmission(): number {
    const am = 1 / Math.max(this.sunDir.y, 0.05);
    return Math.exp(-this.uniforms.uTau.value * am * 0.45);
  }
}
