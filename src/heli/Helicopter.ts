import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';
import { buildIngenuity } from '../rover/models/nasa';
import { world } from '../world';

/**
 * Ingenuity Mars Helicopter (NASA/JPL, 2021).
 *
 * Real numbers (NASA/JPL Ingenuity press kit; Balaram et al. 2018, AIAA 2018-0023):
 * mass 1.8 kg; two coaxial counter-rotating rotors, 1.2 m across, ~2537 rpm, so the
 * blade-passage tone is ≈ 84 Hz (as recorded by Perseverance's microphone on
 * flight 4); six Li-ion cells (~35–40 Wh), ~350 W in hover, flights up to 169 s;
 * flew 72 times, up to 24 m high, 10 m/s, 17 km in total. All flights were autonomous:
 * the radio delay to Earth (5–20 min) rules out remote piloting.
 *
 * Flight model: thrust along the rotor axis, attitude tilts to accelerate (as a
 * multirotor does), aerodynamic drag in the real air density, wind from the
 * weather, ground effect below ~0.6 m, hard landing above 1.2 m/s. Manual control
 * is a game liberty; T engages the autopilot that flies the real-style profile.
 */
const MASS = 1.8;
const HOVER_W = 350;
const BATTERY_WH = 38;
const RESERVE = 0.3; // the reserve kept for the night-time heaters
const RPM = 2537;
const MAX_TILT = THREE.MathUtils.degToRad(22);
const VMAX = 10;
const ALT_MAX = 30;

type Phase = 'landed' | 'spinup' | 'manual' | 'auto' | 'crashed';

interface DustP {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
}

export class Helicopter {
  readonly object = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  battery = 1;
  rpm = 0;
  phase: Phase = 'landed';
  /** Message for the HUD (autopilot steps, warnings). */
  status = '';
  readonly pad = new THREE.Vector3();
  /** Rotor-axis tilt (visual + thrust direction). */
  private tilt = new THREE.Vector2();
  private rotors: [THREE.Object3D, THREE.Object3D] | null = null;
  private discs: THREE.Mesh[] = [];
  private route: THREE.Vector3[] = [];
  private wp = 0;
  private hold = 0;
  private dust: DustP[] = [];
  private dustMesh: THREE.Points;
  private dustGeo: THREE.BufferGeometry;
  private audio: { osc: OscillatorNode[]; gain: GainNode } | null = null;
  readonly camAnchor = new THREE.Object3D();
  flightTime = 0;
  flights = 0;

  constructor(private terrain: TerrainData, padX: number, padZ: number, private wind: () => THREE.Vector3) {
    this.pad.set(padX, terrain.height(padX, padZ), padZ);
    this.pos.copy(this.pad);
    const m = buildIngenuity();
    if (m) {
      this.object.add(m.root);
      this.rotors = m.rotors;
      // Motion-blurred rotor discs (the blades are a blur at 42 rev/s).
      for (const y of [0.41, 0.31]) {
        const disc = new THREE.Mesh(
          new THREE.RingGeometry(0.06, 0.6, 48),
          new THREE.MeshBasicMaterial({ color: 0x3a3530, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = y;
        this.object.add(disc);
        this.discs.push(disc);
      }
    } else {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.2), new THREE.MeshStandardMaterial({ color: 0x888888 }));
      b.position.y = 0.2;
      this.object.add(b);
    }
    // Colour return-to-Earth camera: under the fuselage, looking forward and down (~22°).
    this.camAnchor.position.set(0, 0.06, 0.12);
    this.camAnchor.rotation.set(-0.38, Math.PI, 0);
    this.object.add(this.camAnchor);
    this.dustGeo = new THREE.BufferGeometry();
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    this.dustMesh = new THREE.Points(this.dustGeo, new THREE.PointsMaterial({ color: 0xb38a64, size: 0.05, transparent: true, opacity: 0.55, depthWrite: false }));
    this.dustMesh.frustumCulled = false;
    this.object.updateMatrixWorld();
  }

  get dustObject(): THREE.Object3D {
    return this.dustMesh;
  }

  get agl(): number {
    return this.pos.y - this.terrain.height(this.pos.x, this.pos.z);
  }

  /** Remaining flight time to the reserve, s. */
  get endurance(): number {
    return Math.max(0, ((this.battery - RESERVE) * BATTERY_WH * 3600) / HOVER_W);
  }

  attachAudio(out: { ctx: AudioContext; dest: AudioNode } | null): void {
    if (!out || this.audio) return;
    const { ctx, dest } = out;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    gain.connect(lp).connect(dest);
    // Blade-passage tone and harmonics (thin air carries little of it).
    const osc = [84.6, 169.2, 253.8].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = [0.5, 0.25, 0.12][i];
      o.connect(g).connect(gain);
      o.start();
      return o;
    });
    this.audio = { osc, gain };
  }

  /** Start the autonomous flight: take off, fly a loop like flights 3–4, return, land. */
  startAuto(): void {
    if (this.phase === 'crashed') return;
    if (this.endurance < 40) {
      this.status = 'heliLowBatt';
      return;
    }
    // Waypoints: x, z and the height above the ground (y), held with the laser altimeter.
    const p = this.pad, h = 5;
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const r = new THREE.Vector3(f.z, 0, -f.x);
    this.route = [
      new THREE.Vector3(p.x, h, p.z),
      p.clone().addScaledVector(f, 40).setY(h),
      p.clone().addScaledVector(f, 40).addScaledVector(r, 25).setY(h),
      p.clone().addScaledVector(r, 25).setY(h),
      new THREE.Vector3(p.x, h, p.z),
      new THREE.Vector3(p.x, 0, p.z),
    ];
    this.wp = 0;
    this.hold = 0;
    this.phase = this.rpm < RPM * 0.95 ? 'spinup' : 'auto';
    this.status = 'heliAuto';
    if (this.agl < 0.3) this.flights++;
  }

  reset(): void {
    this.pos.copy(this.pad);
    this.vel.set(0, 0, 0);
    this.tilt.set(0, 0);
    this.phase = 'landed';
    this.rpm = 0;
    this.status = '';
  }

  update(dt: number, cmd: { fwd: number; yaw: number; lift: number }, active: boolean): void {
    const g = world().gravity;
    const rho = world().airDensity;
    const ground = this.terrain.height(this.pos.x, this.pos.z);
    const manualInput = active && (Math.abs(cmd.fwd) > 0.05 || Math.abs(cmd.lift) > 0.05 || Math.abs(cmd.yaw) > 0.05);
    if (manualInput && this.phase === 'auto') this.status = 'heliManual';
    if (manualInput && (this.phase === 'auto' || this.phase === 'landed')) {
      if (this.phase === 'landed' && cmd.lift <= 0.05) {
        /* on the ground: only climbing starts a flight */
      } else {
        if (this.phase === 'landed') this.flights++;
        this.phase = this.rpm < RPM * 0.95 ? 'spinup' : 'manual';
        this.route = [];
      }
    }

    // Rotor spin-up / spin-down (~10 s, as before each real flight).
    const flying = this.phase === 'manual' || this.phase === 'auto' || this.phase === 'spinup';
    this.rpm = THREE.MathUtils.clamp(this.rpm + (flying ? RPM / 5 : -RPM / 10) * dt, 0, RPM);
    if (this.phase === 'spinup' && this.rpm >= RPM * 0.99) this.phase = this.route.length ? 'auto' : 'manual';

    // Commands → targets (vertical speed, horizontal velocity, yaw rate).
    let vzT = 0;
    const vT = new THREE.Vector2();
    let yawRate = 0;
    if (this.phase === 'manual') {
      vzT = cmd.lift * 2.5;
      const f = new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
      vT.copy(f).multiplyScalar(cmd.fwd * VMAX);
      yawRate = -cmd.yaw * 1.2;
      if (this.pos.y - ground > ALT_MAX && vzT > 0) vzT = 0;
    } else if (this.phase === 'auto') {
      const w = this.route[this.wp];
      const target = new THREE.Vector3(w.x, ground + w.y, w.z);
      const d = new THREE.Vector3().subVectors(target, this.pos);
      const dh = Math.hypot(d.x, d.z);
      vzT = THREE.MathUtils.clamp(d.y * 0.8, -1, 1);
      const speed = Math.min(3.5, dh * 0.6);
      if (dh > 0.05) vT.set(d.x / dh, d.z / dh).multiplyScalar(speed);
      if (dh > 2) {
        const want = Math.atan2(d.x, d.z);
        yawRate = THREE.MathUtils.clamp(THREE.MathUtils.euclideanModulo(want - this.yaw + Math.PI, Math.PI * 2) - Math.PI, -1, 1) * 1.2;
      }
      if (dh < 0.6 && Math.abs(d.y) < 0.4) {
        this.hold += dt;
        if (this.hold > (this.wp === 0 ? 4 : 1.5)) {
          this.wp++;
          this.hold = 0;
          if (this.wp >= this.route.length) {
            this.route = [];
            this.phase = 'manual';
            this.status = 'heliDone';
          }
        }
      }
      if (this.wp === this.route.length - 1) vzT = Math.max(-0.8, Math.min(vzT, -0.5)); // final descent ~0.6 m/s
    }
    if (this.phase === 'crashed' || this.phase === 'landed') vzT = 0;

    // Attitude: tilt toward the velocity error, limited, first-order servo.
    const vh = new THREE.Vector2(this.vel.x, this.vel.z);
    const aWant = vT.sub(vh).multiplyScalar(1.6);
    const aMax = g * Math.tan(MAX_TILT);
    if (aWant.length() > aMax) aWant.setLength(aMax);
    const tiltT = new THREE.Vector2(Math.atan(aWant.x / g), Math.atan(aWant.y / g));
    this.tilt.lerp(tiltT, 1 - Math.exp(-dt * 6));
    this.yaw += yawRate * dt;

    // Thrust (rotor speed is fixed; collective sets it), drag in the real air density, wind.
    const spin = this.rpm / RPM;
    const lift = spin * spin;
    const groundEffect = 1 + 0.12 * Math.max(0, 1 - (this.pos.y - ground) / 0.6);
    // Vertical thrust component must carry the weight: divide by cos(tilt).
    const tNeed = (MASS * (g + THREE.MathUtils.clamp((vzT - this.vel.y) * 2.5, -g, g * 0.6))) / Math.cos(this.tilt.length());
    const T = this.phase === 'landed' || this.phase === 'crashed' ? 0 : Math.min(tNeed / Math.max(groundEffect, 1e-3), MASS * g * 1.45) * lift * groundEffect;
    const ax = Math.sin(this.tilt.x), az = Math.sin(this.tilt.y);
    const acc = new THREE.Vector3((T * ax) / MASS, (T * Math.cos(this.tilt.length())) / MASS - g, (T * az) / MASS);
    const rel = new THREE.Vector3().subVectors(this.vel, this.wind());
    const drag = 0.5 * rho * rel.lengthSq() * 1.0 * 0.12; // Cd·A ≈ 0.12 m² (body, legs, rotor hubs)
    if (rel.lengthSq() > 1e-6) acc.addScaledVector(rel.normalize(), -drag / MASS);
    const onGround = this.pos.y <= ground + 0.001;
    if (!(onGround && acc.y < 0)) {
      this.vel.addScaledVector(acc, dt);
      this.pos.addScaledVector(this.vel, dt);
    }

    // Ground contact.
    if (this.pos.y < ground) {
      const vy = this.vel.y;
      this.pos.y = ground;
      if (vy < -1.6 || this.vel.length() > 3) {
        this.phase = 'crashed';
        this.status = 'heliCrash';
      } else if (this.phase !== 'crashed' && (this.phase !== 'spinup')) {
        if (vzT <= 0 && this.phase !== 'landed') {
          this.phase = 'landed';
          this.route = [];
          this.status = this.status === 'heliCrash' ? this.status : 'heliLanded';
        }
      }
      this.vel.set(0, 0, 0);
    }

    // Battery: ~350 W in hover (more when climbing / fast), recharge on the pad from the solar panel
    // (in reality ~ one sol; accelerated in the game).
    const power = flying ? HOVER_W * (1 + 0.15 * Math.max(0, this.vel.y) + 0.01 * this.vel.lengthSq()) * spin : 0;
    this.battery -= (power * dt) / 3600 / BATTERY_WH;
    if (this.phase === 'landed') this.battery = Math.min(1, this.battery + dt * 0.02);
    if (flying && this.battery <= RESERVE && this.phase === 'manual') {
      // Out of the flight budget: the onboard software lands where it is.
      this.route = [new THREE.Vector3(this.pos.x, 0, this.pos.z)];
      this.wp = 0;
      this.phase = 'auto';
      this.status = 'heliLowBatt';
    }
    if (flying) this.flightTime += dt;

    // Visual pose.
    this.object.position.copy(this.pos);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.tilt.y, this.yaw, -this.tilt.x, 'YXZ'));
    if (this.phase === 'crashed') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.3));
    this.object.quaternion.copy(q);
    if (this.rotors) {
      // Shown at an alias-free rate; the blur discs carry the true speed.
      const vis = Math.min(this.rpm / 60, 7) * Math.PI * 2 * dt;
      this.rotors[0].rotation.y += vis;
      this.rotors[1].rotation.y -= vis;
      for (const d of this.discs) (d.material as THREE.MeshBasicMaterial).opacity = 0.32 * THREE.MathUtils.smoothstep(this.rpm, 300, 2000);
    }
    this.updateDust(dt, ground, spin);
    if (this.audio) {
      this.audio.gain.gain.value = 0.08 * spin;
      for (const [i, o] of this.audio.osc.entries()) o.frequency.value = (84.6 * (i + 1) * this.rpm) / RPM + 1;
    }
  }

  /** Audibility falls with distance from the listener (thin air: −20 dB at ~30 m). */
  setListener(dist: number): void {
    if (this.audio) this.audio.gain.gain.value *= 1 / (1 + (dist / 8) ** 2);
  }

  /** Rotor downwash raises dust near the ground; in thin CO₂ it drifts and settles. */
  private updateDust(dt: number, ground: number, spin: number): void {
    const h = this.pos.y - ground;
    if (spin > 0.6 && h < 2.5 && this.dust.length < 600) {
      const n = Math.floor((2.5 - h) * 60 * dt * spin) + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.4 + Math.random() * 1.2;
        const x = this.pos.x + Math.cos(a) * r, z = this.pos.z + Math.sin(a) * r;
        const sp = (2 + Math.random() * 4) * (1 - h / 2.5);
        this.dust.push({
          p: new THREE.Vector3(x, this.terrain.height(x, z) + 0.03, z),
          v: new THREE.Vector3(Math.cos(a) * sp, 0.3 + Math.random() * 0.8, Math.sin(a) * sp),
          life: 2 + Math.random() * 2,
        });
      }
    }
    const g = world().gravity;
    const w = this.wind();
    const arr = this.dustGeo.getAttribute('position') as THREE.BufferAttribute;
    let k = 0;
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.life -= dt;
      // Fine dust (~10 µm) relaxes to the wind within ~0.5 s and settles slowly.
      d.v.x += (w.x - d.v.x) * Math.min(1, dt * 2);
      d.v.z += (w.z - d.v.z) * Math.min(1, dt * 2);
      d.v.y += (-g * 0.08 - d.v.y * 2) * dt;
      d.p.addScaledVector(d.v, dt);
      const gy = this.terrain.height(d.p.x, d.p.z);
      if (d.life <= 0 || d.p.y < gy) {
        this.dust.splice(i, 1);
        continue;
      }
      arr.setXYZ(k++, d.p.x, d.p.y, d.p.z);
    }
    arr.needsUpdate = true;
    this.dustGeo.setDrawRange(0, k);
  }
}
