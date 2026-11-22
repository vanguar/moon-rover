/**
 * AudioWorklet: physically driven synthesis of what an astronaut hears while
 * driving on the Moon. There is no air, so nothing reaches the ear through the
 * vacuum. Everything mechanical is structure-borne: wheel/ground impacts and
 * motor vibration excite the resonant modes of the aluminium frame, travel
 * through the seat and the pressurised suit, and are heard inside the helmet,
 * heavily low-passed. On top of that: the PLSS ventilation fan and pump, and the
 * astronaut's own breathing.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export interface RoverAudioParams {
  /** Rim speed per wheel, m/s (signed). */
  rim: number[];
  /** Wheel in contact with the ground. */
  contact: boolean[];
  /** Longitudinal slip per wheel, m/s. */
  slip: number[];
  /** Motor current factor 0..1. */
  load: number;
  /** Suspension compression rate per wheel, m/s (positive = compressing). */
  susp: number[];
  /** Steering actuator angular rate, rad/s. */
  steerRate: number;
  /** Physiological stress 0..1 (raises breathing rate and depth). */
  stress: number;
  /** 1 = listener in the cab (structure-borne + suit), 0 = outside camera. */
  cabin: number;
  /** Rock density factor under the wheels. */
  rough: number;
}

const WHEEL_R = 0.41;
const GROUSERS = 18;
const DRIVE_RATIO = 80; // LRV harmonic drive
const COMMUTATOR = 11;
/** Wheel lateral position: left wheels (even index) pan left. */
const PAN = [-0.5, 0.5, -0.6, 0.6, -0.5, 0.5];

/** Two-pole resonator (one structural mode). */
class Mode {
  private y1 = 0;
  private y2 = 0;
  private a1: number;
  private a2: number;
  constructor(freq: number, t60: number, private gain: number) {
    const r = Math.exp(-6.91 / (t60 * sampleRate));
    this.a1 = 2 * r * Math.cos((2 * Math.PI * freq) / sampleRate);
    this.a2 = -r * r;
    // Normalise peak gain roughly so modes are comparable.
    this.gain = gain * (1 - r);
  }
  tick(x: number): number {
    const y = this.a1 * this.y1 + this.a2 * this.y2 + x * this.gain;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** RBJ biquad. */
class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  static lowpass(f: number, q: number): Biquad { return new Biquad().set('lp', f, q); }
  static highpass(f: number, q: number): Biquad { return new Biquad().set('hp', f, q); }
  static bandpass(f: number, q: number): Biquad { return new Biquad().set('bp', f, q); }
  static peak(f: number, q: number, db: number): Biquad { return new Biquad().set('pk', f, q, db); }
  set(type: 'lp' | 'hp' | 'bp' | 'pk', f: number, q: number, db = 0): this {
    const w = (2 * Math.PI * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else {
      const A = Math.pow(10, db / 40);
      b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class RoverProcessor extends AudioWorkletProcessor {
  private p: RoverAudioParams = {
    rim: [0, 0, 0, 0, 0, 0], contact: [false, false, false, false, false, false], slip: [0, 0, 0, 0, 0, 0],
    load: 0, susp: [0, 0, 0, 0, 0, 0], steerRate: 0, stress: 0, cabin: 1, rough: 1,
  };
  // Smoothed control values.
  private rim = new Float32Array(6);
  private load = 0;
  private cabin = 1;
  private steer = 0;
  private stress = 0;
  // Per-wheel oscillators/phases.
  private grouserPh = new Float32Array(6);
  private motorPh = new Float32Array(6);
  private burstL = 0;
  private burstR = 0;
  private thumpEnv = 0;
  private thumpPh = 0;
  private servoPh = 0;
  // Frame modes (aluminium tube chassis + deck panels), separate L/R sets for width.
  private modesL: Mode[];
  private modesR: Mode[];
  private tireL: Biquad; // springy wire-mesh tyre "zing" band
  private tireR: Biquad;
  // Suit / helmet transfer: body-conduction low-pass + helmet cavity resonance.
  private suitL = [Biquad.highpass(28, 0.7), Biquad.lowpass(950, 0.8), Biquad.peak(480, 1.6, 5)];
  private suitR = [Biquad.highpass(28, 0.7), Biquad.lowpass(950, 0.8), Biquad.peak(480, 1.6, 5)];
  private rumbleLp = Biquad.lowpass(70, 0.9);
  // Life support & breathing.
  private fanLp = Biquad.lowpass(1600, 0.6);
  private fanHp = Biquad.highpass(120, 0.7);
  private fanPh = 0;
  private pumpPh = 0;
  private breathPh = 0;
  private breathF1 = Biquad.bandpass(900, 1.2);
  private breathF2 = Biquad.bandpass(2200, 1.5);
  private breathHp = Biquad.highpass(300, 0.7);
  private seed = 22222;

  constructor() {
    super();
    const freqs = [43, 71, 97, 131, 166, 208, 263, 331, 397, 488, 571, 702, 868, 1093, 1370];
    const mk = (detune: number) =>
      freqs.map((f, i) => new Mode(f * detune * (1 + ((i * 37) % 7) * 0.004), 0.55 * Math.pow(0.82, i) + 0.05, 1 / (1 + i * 0.25)));
    this.modesL = mk(1);
    this.modesR = mk(1.031);
    this.tireL = Biquad.bandpass(1900, 2.5);
    this.tireR = Biquad.bandpass(2150, 2.5);
    this.port.onmessage = (e: MessageEvent<Partial<RoverAudioParams>>) => Object.assign(this.p, e.data);
  }

  private rnd(): number {
    // xorshift: deterministic, allocation-free
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s;
    return ((s >>> 0) / 4294967296);
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    const n = L.length;
    const fs = sampleRate;
    const p = this.p;
    const k = 1 - Math.exp(-n / (fs * 0.04)); // ~40 ms parameter smoothing per block
    for (let w = 0; w < 6; w++) this.rim[w] += (p.rim[w] - this.rim[w]) * k;
    this.load += (p.load - this.load) * k;
    this.cabin += (p.cabin - this.cabin) * (1 - Math.exp(-n / (fs * 0.2)));
    this.steer += (Math.min(Math.abs(p.steerRate), 2) - this.steer) * k;
    this.stress += (p.stress - this.stress) * (1 - Math.exp(-n / (fs * 3)));

    // Suspension shocks -> low thump envelope.
    let shock = 0;
    for (let w = 0; w < 6; w++) shock = Math.max(shock, p.susp[w]);
    if (shock > 0.35) this.thumpEnv = Math.max(this.thumpEnv, Math.min(1.5, (shock - 0.35) * 0.9));

    // Rates per wheel (Hz).
    const grouserHz = new Float32Array(6), motorHz = new Float32Array(6), crunch = new Float32Array(6);
    let speed = 0;
    for (let w = 0; w < 6; w++) {
      const v = Math.abs(this.rim[w]);
      speed += v / 6;
      grouserHz[w] = p.contact[w] ? v / ((2 * Math.PI * WHEEL_R) / GROUSERS) : 0;
      motorHz[w] = (v / (2 * Math.PI * WHEEL_R)) * DRIVE_RATIO;
      // Pebbles & clods crushed per second: proportional to swept area and roughness; slip shears more.
      crunch[w] = p.contact[w] ? (v * 55 + Math.abs(p.slip[w]) * 180) * p.rough : 0;
    }
    const breathHz = (13 + this.stress * 17) / 60;
    const breathDepth = 0.35 + this.stress * 0.65;

    for (let i = 0; i < n; i++) {
      let exL = 0, exR = 0;
      // Grouser (chevron) strikes and random regolith/pebble impacts.
      for (let w = 0; w < 6; w++) {
        const left = PAN[w] < 0;
        if (grouserHz[w] > 0) {
          this.grouserPh[w] += grouserHz[w] / fs;
          if (this.grouserPh[w] >= 1) {
            this.grouserPh[w] -= 1;
            const a = Math.min(1, grouserHz[w] / 18) * (0.5 + this.rnd() * 0.5) * 0.35;
            if (left) this.burstL += a; else this.burstR += a;
          }
        }
        if (crunch[w] > 0 && this.rnd() < crunch[w] / fs) {
          // Pareto-distributed amplitudes: mostly fines, occasionally a pebble.
          const a = Math.min(1.2, 0.04 * Math.pow(this.rnd() + 1e-3, -0.7));
          if (left) this.burstL += a; else this.burstR += a;
        }
      }
      // Bursts are ~1.5 ms noise grains (contact durations), not clicks.
      const nzA = this.rnd() * 2 - 1, nzB = this.rnd() * 2 - 1;
      exL += nzA * this.burstL;
      exR += nzB * this.burstR;
      this.burstL *= 0.985;
      this.burstR *= 0.985;

      // Hub motors: torque ripple at rotor rate, commutator ripple, brush noise; current-dependent.
      let mot = 0;
      for (let w = 0; w < 6; w++) {
        if (motorHz[w] < 1) continue;
        this.motorPh[w] = (this.motorPh[w] + motorHz[w] / fs) % 1;
        const ph = this.motorPh[w] * 2 * Math.PI;
        const ripple = Math.sin(ph) * 0.5 + Math.sin(2 * ph + 0.3) * 0.3 + Math.sin(COMMUTATOR * ph) * 0.12;
        const brush = (this.rnd() * 2 - 1) * (0.5 + 0.5 * Math.sin(ph)) * 0.25;
        mot += (ripple + brush) * (0.25 + this.load * 0.9);
      }
      mot *= 0.035;
      exL += mot;
      exR += mot;

      // Steering actuator (small DC motor + gearbox).
      if (this.steer > 0.01) {
        this.servoPh = (this.servoPh + (95 + this.steer * 60) / fs) % 1;
        const s = (Math.sin(this.servoPh * 2 * Math.PI) + (this.rnd() - 0.5) * 0.6) * this.steer * 0.05;
        exL += s;
        exR += s * 0.6;
      }

      // Suspension thumps: damped low sine through the seat.
      let th = 0;
      if (this.thumpEnv > 1e-4) {
        this.thumpPh += (38 + this.thumpEnv * 25) / fs;
        th = Math.sin(this.thumpPh * 2 * Math.PI) * this.thumpEnv;
        exL += (this.rnd() - 0.5) * this.thumpEnv * 0.8;
        exR += (this.rnd() - 0.5) * this.thumpEnv * 0.8;
        this.thumpEnv *= 0.99965;
      }

      // Frame response.
      let fl = 0, fr = 0;
      for (let m = 0; m < this.modesL.length; m++) {
        fl += this.modesL[m].tick(exL);
        fr += this.modesR[m].tick(exR);
      }
      fl += this.tireL.tick(exL) * 0.25;
      fr += this.tireR.tick(exR) * 0.25;
      // Whole-body low rumble felt through the seat (terrain roughness at speed).
      const rumble = this.rumbleLp.tick((this.rnd() * 2 - 1) * Math.min(1, speed / 4)) * 0.9;
      let sl = fl * 1.8 + rumble + th * 0.6;
      let sr = fr * 1.8 + rumble + th * 0.6;
      for (const f of this.suitL) sl = f.tick(sl);
      for (const f of this.suitR) sr = f.tick(sr);
      sl *= this.cabin;
      sr *= this.cabin;

      // PLSS: ventilation fan (blade-pass tone + airflow) and water pump pulsing.
      this.fanPh = (this.fanPh + 236 / fs) % 1;
      this.pumpPh = (this.pumpPh + 7.5 / fs) % 1;
      const air = this.fanHp.tick(this.fanLp.tick(this.rnd() * 2 - 1));
      const fan = air * 0.05 + Math.sin(this.fanPh * 2 * Math.PI) * 0.006 + Math.sin(this.fanPh * 4 * Math.PI) * 0.003;
      const pump = Math.sin(this.pumpPh * 2 * Math.PI) > 0.92 ? (this.rnd() - 0.5) * 0.02 : 0;

      // Breathing: inhale/exhale noise shaped by vocal-tract-like formants.
      this.breathPh = (this.breathPh + breathHz / fs) % 1;
      const b = this.breathPh;
      let env = 0, exhale = false;
      if (b < 0.36) env = Math.sin((b / 0.36) * Math.PI);
      else if (b > 0.44 && b < 0.88) { env = Math.sin(((b - 0.44) / 0.44) * Math.PI) * 0.8; exhale = true; }
      env = env * env * breathDepth;
      const bn = this.breathHp.tick(this.rnd() * 2 - 1);
      const breath = (this.breathF1.tick(bn) * (exhale ? 1.2 : 0.6) + this.breathF2.tick(bn) * (exhale ? 0.4 : 0.9)) * env * 0.09;

      const lifeSupport = (fan + pump + breath) * this.cabin;
      L[i] = sl * 0.9 + lifeSupport;
      R[i] = sr * 0.9 + lifeSupport;
    }
    return true;
  }
}

registerProcessor('rover-audio', RoverProcessor);
