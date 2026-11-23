import { t } from '../i18n';

/**
 * Mission Control on the radio. Light takes ~1.28 s each way between the Earth and
 * the Moon, so Houston's reply to anything arrives ~2.6 s after the event. Each
 * transmission is framed by the Quindar tones of the Apollo network (2525 Hz
 * intro, 2475 Hz outro, 250 ms) with a little S-band static; the words are shown
 * as subtitles (no imitation of real voices).
 */
const ROUND_TRIP = 2.6;

export class Radio {
  private queue: { at: number; key: string; vars?: Record<string, string> }[] = [];
  private time = 0;
  private el = document.getElementById('radio');
  private hideAt = 0;
  private said = new Set<string>();
  private out: () => { ctx: AudioContext; dest: AudioNode } | null;

  constructor(out: () => { ctx: AudioContext; dest: AudioNode } | null) {
    this.out = out;
  }

  /** Houston reacts to an event (once per key unless `repeat`). */
  say(key: string, opt: { repeat?: boolean; vars?: Record<string, string>; delay?: number } = {}): void {
    if (!opt.repeat && this.said.has(key)) return;
    this.said.add(key);
    this.queue.push({ at: this.time + (opt.delay ?? 0) + ROUND_TRIP, key, vars: opt.vars });
  }

  update(dt: number): void {
    this.time += dt;
    if (this.el && this.hideAt && this.time > this.hideAt) {
      this.el.classList.add('hidden');
      this.hideAt = 0;
    }
    if (!this.queue.length || this.queue[0].at > this.time || (this.hideAt && this.time < this.hideAt - 1)) return;
    const m = this.queue.shift()!;
    let text = t(`radio_${m.key}`);
    for (const [k, v] of Object.entries(m.vars ?? {})) text = text.replace(`{${k}}`, v);
    if (this.el) {
      this.el.textContent = `${t('radioHouston')}: ${text}`;
      this.el.classList.remove('hidden');
    }
    this.hideAt = this.time + 3 + text.length * 0.05;
    this.beep(2525, 0);
    this.static(0.25, this.hideAt - this.time - 0.6);
    this.beep(2475, this.hideAt - this.time - 0.4);
  }

  private beep(freq: number, delay: number): void {
    const o = this.out();
    if (!o) return;
    const { ctx, dest } = o;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.06, t0 + 0.01);
    g.gain.setValueAtTime(0.06, t0 + 0.24);
    g.gain.linearRampToValueAtTime(0, t0 + 0.25);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  }

  private static(delay: number, dur: number): void {
    const o = this.out();
    if (!o || dur <= 0) return;
    const { ctx, dest } = o;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.012;
    src.connect(bp).connect(g).connect(dest);
    src.start(ctx.currentTime + delay);
  }
}
