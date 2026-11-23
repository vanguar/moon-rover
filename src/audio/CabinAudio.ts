import type { Rover } from '../rover/Rover';
import { world } from '../world';
import workletUrl from './roverWorklet.ts?worker&url';

/** The synthesiser has six wheel channels (L/R × front/middle/rear): fold any wheel count into them. */
function fold6<T>(a: T[]): T[] {
  if (a.length === 6) return a.slice();
  const rows = a.length / 2;
  const out: T[] = [];
  for (let k = 0; k < 3; k++) {
    const r = Math.round((k * (rows - 1)) / 2);
    out.push(a[r * 2], a[r * 2 + 1]);
  }
  return out;
}

/**
 * Cabin sound. There is no air on the Moon, so nothing reaches the ear through
 * the vacuum: what the astronaut hears is vibration carried by the frame, seat
 * and pressurised suit, plus the suit's fan, his own breathing and radio tones.
 * Mechanical sound is synthesised in an AudioWorklet from the physics state
 * (wheel rpm, chevron strikes, rock contacts, motor current, suspension); in the
 * outside camera it fades out — only radio tones remain.
 */
export class CabinAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private radio!: GainNode;
  private node: AudioWorkletNode | null = null;
  private cabin = 1;
  private alarmTimer = 0;
  private lastSteer = 0;
  private stress = 0;
  private sendTimer = 0;
  /** Wind loudness 0..1 (Mars weather), heard through the rover's microphone. */
  wind = 0;

  async start(volume: number): Promise<void> {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // Radio loop: telephone-band, slightly saturated.
    this.radio = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 1.8) / Math.tanh(1.8);
    }
    shaper.curve = curve;
    this.radio.connect(hp).connect(lp).connect(shaper).connect(this.master);
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(ctx, 'rover-audio', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.master);
    } catch (e) {
      console.warn('AudioWorklet unavailable', e);
    }
  }

  /** Audio graph for other sound sources (helicopter rotors); null before start(). */
  get output(): { ctx: AudioContext; dest: AudioNode } | null {
    return this.ctx ? { ctx: this.ctx, dest: this.master } : null;
  }

  setVolume(v: number): void {
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setCabin(inCabin: boolean): void {
    this.cabin = inCabin ? 1 : 0;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /** Switch / relay click, heard through the glove and suit. */
  click(freq = 2400): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq * 0.5, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.15, t + 0.025);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12 * this.cabin, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.05);
  }

  private tone(f: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.setValueAtTime(gain, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(this.radio);
    o.start(t);
    o.stop(t + dur + 0.01);
  }

  update(dt: number, rover: Rover, steerInput: number, warningLevel: number): void {
    if (!this.ctx) return;
    const steerRate = Math.abs(rover.steerAngle - this.lastSteer) / Math.max(dt, 1e-3);
    this.lastSteer = rover.steerAngle;
    void steerInput;

    // Physiological stress: steep attitude, hard knocks, alarms; decays slowly.
    const { roll, pitch } = rover.attitude();
    let target = Math.min(1, Math.max(0, (Math.max(Math.abs(roll), Math.abs(pitch)) - 12) / 25));
    if (warningLevel === 2) target = Math.max(target, 0.8);
    for (const k of rover.knocks) target = Math.max(target, Math.min(1, k.strength * 0.5));
    this.stress = Math.max(target, this.stress - dt * 0.05);

    if (this.node) {
      for (const k of rover.knocks) {
        // Left wheels have even indices (+x is left); chassis knocks are centred.
        const side = k.wheel < 0 ? 0 : k.wheel % 2 === 0 ? -1 : 1;
        this.node.port.postMessage({ type: 'knock', side, strength: k.strength * this.cabin, hard: k.hard });
      }
      this.sendTimer -= dt;
      if (this.sendTimer <= 0) {
        this.sendTimer = 1 / 60;
        this.node.port.postMessage({
          type: 'params',
          p: {
            rim: fold6(rover.wheelRimSpeed),
            contact: fold6(rover.wheelContact),
            slip: fold6(rover.wheelSlip),
            load: rover.motorLoadFactor,
            susp: fold6(rover.wheelImpact),
            wheelR: rover.wheelRadius,
            crew: rover.spec.crew ? 1 : 0,
            wind: this.wind,
            air: world().atmosphere ? 1 : 0,
            steerRate,
            stress: this.stress,
            cabin: this.cabin,
            rough: 1,
          },
        });
      }
    }

    // Caution & warning tones on the radio loop.
    this.alarmTimer -= dt;
    if (warningLevel === 2 && this.alarmTimer <= 0) {
      this.tone(750, 0.2, 0.18);
      this.tone(1500, 0.2, 0.15, 0.22);
      this.alarmTimer = 0.9;
    } else if (warningLevel === 1 && this.alarmTimer <= 0) {
      this.tone(1500, 0.15, 0.09);
      this.alarmTimer = 3;
    }
  }
}
