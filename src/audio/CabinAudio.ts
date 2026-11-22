import type { Rover } from '../rover/Rover';

/**
 * Procedural cabin sound. There is no air on the Moon: nothing is heard through
 * the vacuum, only vibration carried by the chassis, seat and suit (structure-
 * borne sound), plus the suit's own fan and radio tones. In the outside camera
 * the mechanical sounds therefore fade out; only radio alerts remain.
 */
export class CabinAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private mech!: GainNode; // structure-borne channel
  private radio!: GainNode;
  private motorOsc: OscillatorNode[] = [];
  private motorGain!: GainNode;
  private pwmOsc!: OscillatorNode;
  private pwmGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleFilter!: BiquadFilterNode;
  private crunchGain!: GainNode;
  private servoOsc!: OscillatorNode;
  private servoGain!: GainNode;
  private noise!: AudioBuffer;
  private cabin = true;
  private alarmTimer = 0;
  private lastSteer = 0;
  private thumpCooldown = 0;

  start(volume: number): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.mech = ctx.createGain();
    // Structure-borne sound: high frequencies are damped by the frame and suit.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 2400;
    this.mech.connect(body).connect(this.master);
    this.radio = ctx.createGain();
    this.radio.connect(this.master);

    // White noise buffer shared by noise sources.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Hub motors: fundamental + harmonic, plus PWM controller whine.
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    const mf = ctx.createBiquadFilter();
    mf.type = 'bandpass';
    mf.frequency.value = 400;
    mf.Q.value = 0.7;
    this.motorGain.connect(mf).connect(this.mech);
    for (const [type, mul, gain] of [['sawtooth', 1, 0.5], ['sine', 2.02, 0.35], ['triangle', 3.01, 0.15]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 60 * mul;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(this.motorGain);
      o.start();
      (o as OscillatorNode & { mul?: number }).mul = mul;
      this.motorOsc.push(o);
    }
    this.pwmOsc = ctx.createOscillator();
    this.pwmOsc.type = 'square';
    this.pwmOsc.frequency.value = 1800;
    this.pwmGain = ctx.createGain();
    this.pwmGain.gain.value = 0;
    this.pwmOsc.connect(this.pwmGain).connect(this.mech);
    this.pwmOsc.start();

    // Wheel rumble through the chassis.
    const rumble = this.noiseSource();
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 180;
    this.rumbleFilter.Q.value = 1.5;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.mech);

    // Regolith crunch / grit under the wire-mesh wheels.
    const crunch = this.noiseSource();
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = 1400;
    cf.Q.value = 0.9;
    this.crunchGain = ctx.createGain();
    this.crunchGain.gain.value = 0;
    crunch.connect(cf).connect(this.crunchGain).connect(this.mech);

    // Steering servo.
    this.servoOsc = ctx.createOscillator();
    this.servoOsc.type = 'square';
    this.servoOsc.frequency.value = 220;
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 900;
    this.servoGain = ctx.createGain();
    this.servoGain.gain.value = 0;
    this.servoOsc.connect(sf).connect(this.servoGain).connect(this.mech);
    this.servoOsc.start();

    // Suit (PLSS) ventilation fan: constant soft air hiss inside the helmet.
    const fan = this.noiseSource();
    const ff = ctx.createBiquadFilter();
    ff.type = 'lowpass';
    ff.frequency.value = 700;
    const fg = ctx.createGain();
    fg.gain.value = 0.035;
    const fanHum = ctx.createOscillator();
    fanHum.frequency.value = 118;
    const fhg = ctx.createGain();
    fhg.gain.value = 0.012;
    fanHum.connect(fhg).connect(this.radio);
    fanHum.start();
    fan.connect(ff).connect(fg).connect(this.radio);
  }

  private noiseSource(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 1.5);
    return s;
  }

  setVolume(v: number): void {
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setCabin(inCabin: boolean): void {
    this.cabin = inCabin;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /** Short mechanical/relay click (switches, camera, lights). */
  click(freq = 2400): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.3, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.radio);
    o.start(t);
    o.stop(t + 0.06);
  }

  private thump(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70 + strength * 20, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, strength * 0.35), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(this.mech);
    o.start(t);
    o.stop(t + 0.4);
    // Metallic rattle of the frame.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 600 + Math.random() * 600;
    bf.Q.value = 4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(Math.min(0.4, strength * 0.12), t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(bf).connect(ng).connect(this.mech);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  private beep(f: number, dur: number, gain = 0.12): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
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
    o.stop(t + dur);
  }

  update(dt: number, rover: Rover, steerInput: number, warningLevel: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const tc = 0.06;
    this.mech.gain.setTargetAtTime(this.cabin ? 1 : 0, now, 0.15);

    let rim = 0, contacts = 0, slip = 0;
    for (let i = 0; i < 6; i++) {
      rim += Math.abs(rover.wheelRimSpeed[i]);
      if (rover.wheelContact[i]) contacts++;
      slip += Math.abs(rover.wheelSlip[i]);
    }
    rim /= 6;
    const load = rover.motorLoadFactor;
    // Motor pitch follows wheel rpm (geared hub motor), loudness follows current.
    const f0 = 55 + rim * 85;
    for (const o of this.motorOsc) o.frequency.setTargetAtTime(f0 * ((o as OscillatorNode & { mul?: number }).mul ?? 1), now, tc);
    this.motorGain.gain.setTargetAtTime(0.03 + load * 0.22 + Math.min(rim, 6) * 0.02, now, tc);
    this.pwmGain.gain.setTargetAtTime(load * 0.012, now, tc);
    this.pwmOsc.frequency.setTargetAtTime(1600 + rim * 60, now, tc);

    const ground = contacts / 6;
    const speed = Math.abs(rover.speed);
    this.rumbleGain.gain.setTargetAtTime(ground * Math.min(1, speed / 4) * 0.55, now, tc);
    this.rumbleFilter.frequency.setTargetAtTime(90 + speed * 40, now, tc);
    this.crunchGain.gain.setTargetAtTime(ground * (Math.min(speed, 6) * 0.012 + Math.min(slip, 6) * 0.03), now, tc);

    const steerRate = Math.abs(rover.steerAngle - this.lastSteer) / Math.max(dt, 1e-3);
    this.lastSteer = rover.steerAngle;
    this.servoGain.gain.setTargetAtTime(Math.min(0.06, steerRate * 0.05), now, 0.03);
    this.servoOsc.frequency.setTargetAtTime(180 + Math.abs(steerInput) * 160, now, 0.05);

    // Suspension bottoming / landings.
    this.thumpCooldown -= dt;
    let impact = 0;
    for (let i = 0; i < 6; i++) impact = Math.max(impact, rover.wheelImpact[i]);
    if (impact > 0.8 && this.thumpCooldown <= 0) {
      this.thump(impact);
      this.thumpCooldown = 0.12;
    }

    // Caution & warning tones over the radio loop.
    this.alarmTimer -= dt;
    if (warningLevel === 2 && this.alarmTimer <= 0) {
      this.beep(750, 0.18, 0.14);
      setTimeout(() => this.beep(1500, 0.18, 0.12), 200);
      this.alarmTimer = 0.8;
    } else if (warningLevel === 1 && this.alarmTimer <= 0) {
      this.beep(1000, 0.12, 0.07);
      this.alarmTimer = 2.5;
    }
  }
}
