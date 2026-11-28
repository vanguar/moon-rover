import * as THREE from 'three';
import type { MarsSkyState } from '../astro/marsSky';
import { buildMilkyWayMap, buildStars } from './Sky';

/**
 * The night sky of Mars, over the dusty day sky (MarsSky):
 * - the stars (Yale Bright Star Catalogue) and the photographic Milky Way, turning
 *   with the planet (src/astro/marsSky.ts), dimmed by the dust (optical depth tau);
 * - Phobos: a dark, lumpy disc ~0.2 deg across (a third of our Moon), lit by the Sun
 *   in phases, eclipsed in Mars's shadow near midnight; it rises in the west and sets
 *   in the east twice a sol;
 * - Deimos: a bright star-like point; the Earth: a blue-white evening or morning star.
 */
/** Area of the overlap of two discs of radii a and b with centres d apart. */
function discOverlap(d: number, a: number, b: number): number {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2;
  const x = (d * d + a * a - b * b) / (2 * d * a), y = (d * d + b * b - a * a) / (2 * d * b);
  return a * a * Math.acos(x) + b * b * Math.acos(y) - 0.5 * Math.sqrt((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));
}

export class MarsNight {
  readonly group = new THREE.Group();
  private celestial = new THREE.Group();
  private stars: THREE.Points;
  private milky: THREE.Mesh | null = null;
  private phobos: THREE.Mesh;
  private phobosMat: THREE.ShaderMaterial;
  private points: THREE.Points;
  /** Fraction of the Sun's disc covered by Phobos (0 most of the time). */
  eclipse = 0;
  /** Angle Phobos - Sun (rad). */
  sunSep = Math.PI;

  constructor(stars: Float32Array | undefined) {
    this.stars = buildStars(stars, 2000);
    this.celestial.add(this.stars);
    // Inside the day-sky sphere (radius 9000), drawn over it.
    this.celestial.scale.setScalar(0.93);
    this.group.add(this.celestial);
    this.stars.renderOrder = -10;

    // Phobos: an irregular body (27 x 22 x 18 km), albedo ~0.07, lit only by the Sun.
    const g = new THREE.IcosahedronGeometry(1, 3);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const lump = 1 + 0.08 * Math.sin(v.x * 4.1 + 1) * Math.sin(v.y * 3.7 + 2) + 0.05 * Math.sin(v.z * 6.3);
      // Stickney crater: a 9 km dent on one end.
      const st = Math.max(0, v.dot(new THREE.Vector3(0.9, 0.2, 0.38).normalize()) - 0.82) * 1.4;
      v.multiplyScalar(lump - st);
      p.setXYZ(i, v.x * 1.0, v.y * 0.83, v.z * 0.68);
    }
    g.computeVertexNormals();
    this.phobosMat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uLight: { value: 1 }, uAlpha: { value: 1 } },
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec3 vN; uniform vec3 uSun; uniform float uLight; uniform float uAlpha;
        void main() {
          float l = max(dot(normalize(vN), uSun), 0.0);
          // Dark carbonaceous grey-brown; lit side bright against the night sky.
          vec3 c = vec3(0.62, 0.56, 0.5) * (l * uLight + 0.015);
          gl_FragColor = vec4(c, uAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.phobos = new THREE.Mesh(g, this.phobosMat);
    this.phobos.renderOrder = -9;
    this.phobos.frustumCulled = false;
    this.group.add(this.phobos);

    // Deimos and the Earth as points.
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    pg.setAttribute('size', new THREE.Float32BufferAttribute(new Float32Array(2), 1));
    const pm = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: Math.min(2, window.devicePixelRatio || 1) } },
      vertexShader: `attribute float size; varying vec3 vC; uniform float uScale;
        void main(){ vC = color; gl_PointSize = size * uScale; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vC; void main(){ vec2 c = gl_PointCoord - 0.5; gl_FragColor = vec4(vC * exp(-dot(c, c) * 10.0), 1.0); }`,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(pg, pm);
    this.points.renderOrder = -9;
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  setMilkyWay(tex: THREE.Texture): void {
    if (this.milky) return;
    this.milky = buildMilkyWayMap(tex, new THREE.Matrix4());
    this.milky.renderOrder = -10;
    this.celestial.add(this.milky);
  }

  /**
   * @param s the sky state; @param fix rotation aligning it with the Mars24 Sun;
   * @param dark 0 by day .. 1 in full night; @param tau dust optical depth.
   */
  update(camera: THREE.Camera, s: MarsSkyState, fix: THREE.Quaternion, dark: number, tau: number): void {
    this.group.position.copy(camera.position);
    const rot = new THREE.Quaternion().setFromRotationMatrix(s.icrf);
    this.celestial.quaternion.copy(fix).multiply(rot);
    // Dust: zenith transmission exp(-tau); the eye sees the stars as the sky darkens.
    const clear = Math.exp(-tau * 0.8);
    const um = (this.stars.material as THREE.ShaderMaterial).uniforms;
    um.uAdapt.value = dark * (0.75 + 0.25 * clear);
    this.stars.visible = dark > 0.02;
    if (this.milky) {
      (this.milky.material as THREE.ShaderMaterial).uniforms.uAdapt.value = dark * clear;
      this.milky.visible = dark > 0.3;
    }
    const sun = s.sun.clone().applyQuaternion(fix);
    // Phobos.
    const ph = s.moons[0];
    const dir = ph.dir.clone().applyQuaternion(fix);
    const R = 8300, rad = R * Math.tan(11.1 / ph.dist);
    this.phobos.position.copy(dir).multiplyScalar(R);
    this.phobos.scale.setScalar(rad);
    // Tidally locked: its long axis points at Mars (straight down from it, roughly).
    this.phobos.lookAt(this.group.position);
    this.phobosMat.uniforms.uSun.value.copy(sun);
    this.phobosMat.uniforms.uLight.value = ph.eclipsed ? 0.02 : 1;
    // Faint by day (seen through the bright dusty sky), plain at night; gone below the horizon.
    // In front of the Sun it is a black silhouette (its night side) on the disc.
    const sep = dir.angleTo(sun);
    this.sunSep = dir.y > 0 ? sep : Math.PI;
    const nearSun = 1 - THREE.MathUtils.smoothstep(sep, 0.01, 0.03);
    this.phobosMat.uniforms.uAlpha.value = Math.max((0.25 + 0.75 * dark), nearSun) * THREE.MathUtils.smoothstep(dir.y, -0.01, 0.02);
    // Covered fraction: overlap of two discs (the Sun ~0.17 deg in radius from Mars, Phobos
    // ~0.1 deg; its true outline is irregular - a disc is close enough for the light).
    const rs = 0.0030, rp = Math.atan(11.1 / ph.dist);
    this.eclipse = dir.y > 0 ? discOverlap(sep, rs, rp) / (Math.PI * rs * rs) : 0;
    // Deimos and the Earth.
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const size = this.points.geometry.getAttribute('size') as THREE.BufferAttribute;
    const de = s.moons[1], dd = de.dir.clone().applyQuaternion(fix).multiplyScalar(8300);
    pos.setXYZ(0, dd.x, dd.y, dd.z);
    const lit = de.eclipsed ? 0.03 : 0.5 + 0.5 * Math.cos(de.phaseAngle);
    const dv = dark * clear * lit * THREE.MathUtils.smoothstep(de.dir.y, -0.01, 0.02);
    col.setXYZ(0, 1.6 * dv, 1.5 * dv, 1.35 * dv);
    size.setX(0, 4.2);
    const ed = s.earth.clone().applyQuaternion(fix).multiplyScalar(8300);
    pos.setXYZ(1, ed.x, ed.y, ed.z);
    // Brightest near conjunction... and lost in the Sun's glare when close to it.
    const glare = THREE.MathUtils.smoothstep(s.earth.angleTo(s.sun), 0.12, 0.35);
    const ev = THREE.MathUtils.smoothstep(dark, 0.05, 0.4) * clear * glare * (0.6 + 0.4 * Math.cos(s.earthPhase)) * Math.min(1.6, 1 / (s.earthDist * s.earthDist)) * THREE.MathUtils.smoothstep(s.earth.y, -0.01, 0.02);
    col.setXYZ(1, 1.1 * ev, 1.35 * ev, 1.9 * ev);
    size.setX(1, 4.8);
    pos.needsUpdate = col.needsUpdate = size.needsUpdate = true;
  }
}
