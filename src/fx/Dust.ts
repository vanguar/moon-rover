import * as THREE from 'three';
import { MOON_GRAVITY } from '../config';
import type { Rover } from '../rover/Rover';
import { WHEEL_RADIUS } from '../rover/Rover';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Regolith thrown by the wheels. In vacuum there is no drag and no suspension of
 * fines in gas: every grain flies a clean parabola under 1.62 m/s² and lands —
 * no dust cloud ever forms. Grains leave the rim with the rim point's velocity
 * (vehicle velocity + ω×r), so wheel slip throws a rooster tail backwards.
 */
/** Release angle above which the fender intercepts thrown regolith. */
const FENDER_START_DEG = 38;

export class Dust {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private ground: Float32Array;
  private age: Float32Array;
  private sizeAttr: Float32Array;
  private alive: Uint8Array;
  private cursor = 0;
  private carry = new Array(6).fill(0);
  private max: number;
  readonly uniforms = {
    uSun: { value: new THREE.Vector3() },
    uScale: { value: 400 },
  };

  constructor(private terrain: TerrainData, max: number, sunDir: THREE.Vector3) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.ground = new Float32Array(max);
    this.age = new Float32Array(max);
    this.sizeAttr = new Float32Array(max);
    this.alive = new Uint8Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.sizeAttr, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms.uSun.value.copy(sunDir);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float size;
        uniform vec3 uSun;
        uniform float uScale;
        varying float vBright;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size > 0.0 ? clamp(size * uScale / -mv.z, 1.0, 5.0) : 0.0;
          // Fine grains forward-scatter strongly: bright when backlit by the sun.
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 toCam = normalize(cameraPosition - wp);
          float fwd = max(dot(-toCam, uSun), 0.0);
          vBright = 0.35 + 2.5 * pow(fwd, 12.0) + 0.4 * max(dot(toCam, uSun), 0.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vBright;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          if (dot(c, c) > 0.25) discard;
          gl_FragColor = vec4(vec3(0.62, 0.6, 0.57) * vBright, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }

  setViewportHeight(h: number, fovDeg: number): void {
    this.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, gy: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.ground[i] = gy;
    this.age[i] = 0;
    this.sizeAttr[i] = 0.012 + Math.random() * 0.03;
    this.alive[i] = 1;
  }

  update(dt: number, rover: Rover): void {
    const lin = rover.body.linvel();
    const fwd = rover.forwardVector(new THREE.Vector3());
    const up = rover.upVector(new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
    for (let w = 0; w < 6; w++) {
      if (!rover.wheelContact[w]) continue;
      const rim = rover.wheelRimSpeed[w];
      if (Math.abs(rim) < 0.05) continue;
      const slip = Math.abs(rover.wheelSlip[w]);
      // Grains entrained per second scale with rim speed and with slip (shearing).
      const rate = Math.abs(rim) * 45 + slip * 160;
      this.carry[w] += rate * dt;
      const c = rover.wheelWorld[w];
      const gy = this.terrain.height(c.x, c.z);
      while (this.carry[w] >= 1) {
        this.carry[w] -= 1;
        // Release angle behind the contact patch (0 = contact point, 90° = rear of hub height).
        const thDeg = 5 + Math.random() * 85;
        // Grains released higher up the rim are caught by the fender (as on the LRV).
        if (thDeg > FENDER_START_DEG) continue;
        const th = THREE.MathUtils.degToRad(thDeg);
        const dir = Math.sign(rim) || 1;
        const s = Math.sin(th), co = Math.cos(th);
        // Rim point relative to hub: behind (−fwd) and below.
        const px = -fwd.x * s * dir * WHEEL_RADIUS - up.x * co * WHEEL_RADIUS;
        const py = -fwd.y * s * dir * WHEEL_RADIUS - up.y * co * WHEEL_RADIUS;
        const pz = -fwd.z * s * dir * WHEEL_RADIUS - up.z * co * WHEEL_RADIUS;
        // Tangential rim velocity ω×r: at the rear the rim moves up, at the bottom backwards.
        const tF = -co * rim, tU = s * rim * dir;
        const jitter = 0.08 * Math.abs(rim) + 0.05;
        const lat = (Math.random() - 0.5) * 0.5 * Math.abs(rim) + (w % 2 ? -1 : 1) * Math.random() * 0.15 * Math.abs(rim);
        const vx = lin.x + fwd.x * tF + up.x * tU + side.x * lat + (Math.random() - 0.5) * jitter;
        const vy = lin.y + fwd.y * tF + up.y * tU + side.y * lat + (Math.random() - 0.5) * jitter;
        const vz = lin.z + fwd.z * tF + up.z * tU + side.z * lat + (Math.random() - 0.5) * jitter;
        this.spawn(c.x + px, c.y + py + 0.02, c.z + pz, vx, vy, vz, gy - 0.05);
      }
    }

    const g = MOON_GRAVITY;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const k = i * 3;
      // Exact ballistic integration for constant gravity.
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt - 0.5 * g * dt * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.vel[k + 1] -= g * dt;
      this.age[i] += dt;
      if ((this.vel[k + 1] < 0 && this.pos[k + 1] < this.ground[i]) || this.age[i] > 12) {
        this.alive[i] = 0;
        this.sizeAttr[i] = 0;
      }
    }
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('size').needsUpdate = true;
  }
}
