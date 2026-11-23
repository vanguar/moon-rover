import * as THREE from 'three';
import type { Rover } from '../rover/Rover';
import type { TerrainData } from '../terrain/TerrainData';
import { world } from '../world';

/** Release angle above which the fender intercepts thrown regolith (as on the LRV). */
const FENDER_START_DEG = 38;
/** Camera shutter time: grains are drawn as streaks of length v·t. */
const SHUTTER = 1 / 60;

/**
 * Regolith thrown by the wheels. In vacuum there is no drag and no gas to hold
 * fines aloft: every grain flies a clean parabola under 1.62 m/s² and lands —
 * no dust cloud ever forms. Grains leave the rim with the rim point's velocity
 * (vehicle velocity + ω×r), so wheel slip throws a rooster tail backwards.
 *
 * Rendering: each grain clump is a camera-facing streak stretched along its
 * velocity (motion blur), lit by the sun with a forward-scattering
 * Henyey–Greenstein phase function, and it receives shadows — dust flying
 * through the rover's shadow is dark, backlit dust glows.
 */
export class Dust {
  readonly mesh: THREE.InstancedMesh;
  private pos: Float32Array;
  private vel: Float32Array;
  private ground: Float32Array;
  private age: Float32Array;
  private size: Float32Array;
  private alive: Uint8Array;
  private cursor = 0;
  private carry = new Array(8).fill(0);
  /** Wind at the surface (Mars), m/s; grains relax toward it by aerodynamic drag. */
  readonly wind = new THREE.Vector3();
  private max: number;

  constructor(private terrain: TerrainData, max: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.ground = new Float32Array(max);
    this.age = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alive = new Uint8Array(max);

    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgb(255,255,255)');
    grd.addColorStop(0.5, 'rgb(140,140,140)');
    grd.addColorStop(1, 'rgb(0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 32, 32);
    const alpha = new THREE.CanvasTexture(c);

    const mat = new THREE.MeshLambertMaterial({ color: world().id === 'mars' ? 0xb48a66 : 0x9a948b, alphaMap: alpha, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_lambert_pars_fragment>',
        /* glsl */ `
varying vec3 vViewPosition;
struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
// Henyey–Greenstein mix: strong forward lobe (fine grains) + weak backscatter.
float hg(float g, float c) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5); }
void RE_Direct_Dust( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float c = dot( -directLight.direction, geometryViewDir );
	float phase = 0.75 * hg( 0.55, c ) + 0.25 * hg( -0.3, c );
	reflectedLight.directDiffuse += directLight.color * phase * 0.6 * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Dust
#define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
`,
      );
    };
    mat.customProgramCacheKey = () => 'dust';
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 2;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, gy: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.ground[i] = gy;
    this.age[i] = 0;
    // Clumps of fines, 2–12 mm (individual 70 µm grains are invisible).
    this.size[i] = 0.002 + Math.pow(Math.random(), 3) * 0.01;
    this.alive[i] = 1;
  }

  update(dt: number, rover: Rover, camera: THREE.Camera): void {
    const lin = rover.body.linvel();
    const fwd = rover.forwardVector(new THREE.Vector3());
    const up = rover.upVector(new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
    const WHEEL_RADIUS = rover.wheelRadius;
    // Small rovers kick up proportionally less material.
    const scale = Math.min(1, rover.wheelRadius / 0.3) * (6 / rover.n);
    for (let w = 0; w < rover.n; w++) {
      if (!rover.wheelContact[w]) continue;
      const rim = rover.wheelRimSpeed[w];
      if (Math.abs(rim) < 0.05) continue;
      const slip = Math.abs(rover.wheelSlip[w]);
      // Part of the throw lands on the vehicle itself (fenders stop most of it on the LRV).
      rover.dustCoat = Math.min(1, rover.dustCoat + (Math.abs(rim) * 0.0006 + slip * 0.002) * dt * (rover.spec.crew ? 0.5 : 1));
      // Grains entrained per second scale with rim speed and with slip (shearing).
      this.carry[w] += (Math.abs(rim) * 110 + slip * 300) * dt * scale;
      const c = rover.wheelWorld[w];
      const gy = this.terrain.height(c.x, c.z);
      while (this.carry[w] >= 1) {
        this.carry[w] -= 1;
        // Release angle behind the contact patch (0 = contact point, 90° = rear at hub height).
        const thDeg = 5 + Math.random() * 85;
        if (rover.spec.crew && thDeg > FENDER_START_DEG) continue;
        const th = THREE.MathUtils.degToRad(thDeg);
        const dir = Math.sign(rim) || 1;
        const s = Math.sin(th), co = Math.cos(th);
        const px = -fwd.x * s * dir * WHEEL_RADIUS - up.x * co * WHEEL_RADIUS;
        const py = -fwd.y * s * dir * WHEEL_RADIUS - up.y * co * WHEEL_RADIUS;
        const pz = -fwd.z * s * dir * WHEEL_RADIUS - up.z * co * WHEEL_RADIUS;
        // Tangential rim velocity ω×r: at the rear the rim moves up, at the bottom backwards.
        const tF = -co * rim, tU = s * rim * dir;
        const jitter = 0.1 * Math.abs(rim) + 0.04;
        const lat = (Math.random() - 0.5) * 0.45 * Math.abs(rim);
        const vx = lin.x + fwd.x * tF + up.x * tU + side.x * lat + (Math.random() - 0.5) * jitter;
        const vy = lin.y + fwd.y * tF + up.y * tU + side.y * lat + (Math.random() - 0.5) * jitter;
        const vz = lin.z + fwd.z * tF + up.z * tU + side.z * lat + (Math.random() - 0.5) * jitter;
        const wx = (Math.random() - 0.5) * 0.2;
        this.spawn(c.x + px + side.x * wx, c.y + py + 0.02, c.z + pz + side.z * wx, vx, vy, vz, gy - 0.05);
      }
    }

    // Exact ballistic integration (constant gravity, no drag) + streak instances.
    const g = world().gravity;
    // Mars: Stokes-like drag; fines (small clumps) follow the wind, coarse grains fly ballistic.
    const air = world().atmosphere;
    const wx = this.wind.x, wz = this.wind.z;
    const cam = camera.position;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const k = i * 3;
      if (air) {
        // Relaxation time ~ size: 2 mm clumps settle in ~0.3 s, 12 mm in ~2 s.
        const kd = Math.min(1, dt / (this.size[i] * 160));
        this.vel[k] += (wx - this.vel[k]) * kd;
        this.vel[k + 2] += (wz - this.vel[k + 2]) * kd;
        this.vel[k + 1] += (-this.vel[k + 1] * 0.3) * kd;
      }
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt - 0.5 * g * dt * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.vel[k + 1] -= g * dt;
      this.age[i] += dt;
      // Landing: test against the real ground under the grain (slopes, craters), not the
      // height where it was thrown. Coarse clumps that land fast splash a few fines.
      if (this.vel[k + 1] < 0 && this.pos[k + 1] < this.ground[i] + 1.5) {
        const gy = this.terrain.height(this.pos[k], this.pos[k + 2]);
        this.ground[i] = gy;
        if (this.pos[k + 1] <= gy) {
          const vImp = Math.hypot(this.vel[k], this.vel[k + 1], this.vel[k + 2]);
          if (vImp > 1.5 && this.size[i] > 0.006 && Math.random() < 0.3) {
            const a = Math.random() * Math.PI * 2, sp = vImp * 0.25;
            this.spawn(this.pos[k], gy + 0.01, this.pos[k + 2], Math.cos(a) * sp, sp * 0.8, Math.sin(a) * sp, gy - 0.02);
            this.size[(this.cursor + this.max - 1) % this.max] = 0.002;
          }
          this.alive[i] = 0;
          continue;
        }
      }
      if (this.age[i] > 12) {
        this.alive[i] = 0;
        continue;
      }
      const x = this.pos[k], y = this.pos[k + 1], z = this.pos[k + 2];
      const vx = this.vel[k], vy = this.vel[k + 1], vz = this.vel[k + 2];
      // View direction and velocity projected onto the view plane.
      let ex = cam.x - x, ey = cam.y - y, ez = cam.z - z;
      const el = Math.hypot(ex, ey, ez) || 1;
      ex /= el; ey /= el; ez /= el;
      const vd = vx * ex + vy * ey + vz * ez;
      let ax = vx - ex * vd, ay = vy - ey * vd, az = vz - ez * vd;
      const al = Math.hypot(ax, ay, az);
      const sz = this.size[i];
      const len = al * SHUTTER + sz;
      if (al > 1e-5) { ax /= al; ay /= al; az /= al; } else { ax = 1; ay = 0; az = 0; }
      const bx = ey * az - ez * ay, by = ez * ax - ex * az, bz = ex * ay - ey * ax;
      const o = n * 16;
      m[o] = ax * len; m[o + 1] = ay * len; m[o + 2] = az * len; m[o + 3] = 0;
      m[o + 4] = bx * sz; m[o + 5] = by * sz; m[o + 6] = bz * sz; m[o + 7] = 0;
      m[o + 8] = ex; m[o + 9] = ey; m[o + 10] = ez; m[o + 11] = 0;
      // The streak trails behind the grain over the shutter interval.
      m[o + 12] = x - vx * SHUTTER * 0.5; m[o + 13] = y - vy * SHUTTER * 0.5; m[o + 14] = z - vz * SHUTTER * 0.5; m[o + 15] = 1;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
