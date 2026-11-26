/**
 * Load watchdog: reacts within a few frames when the game starts to stutter.
 *
 * The slow controller (Game.adaptQuality) judges half-second windows and finds the
 * level a device can hold. This one catches sudden slowdowns (a dust devil fills the
 * screen, a storm front, many particles) by looking at every frame:
 *  - the device's own usual frame time is tracked (a slow average that ignores the
 *    spikes): a machine that steadily runs 35 fps is not "slow", it is its pace;
 *  - three frames in a row 1.4x slower than that pace (and late for the display)
 *    = a slowdown is starting;
 *  - it tells the two causes apart by the CPU time the frame itself took (update +
 *    draw submission): if that alone fills most of the period the CPU is the
 *    bottleneck, and lowering the resolution would not help - the CPU-side work
 *    (particles, reflections, shadow re-bakes) is cut instead; otherwise the GPU
 *    is short of time and the resolution drops at once.
 *
 * `relief` 0..3 is read by the effects: each step skips or thins expensive extras
 * (visor reflections, dust and sand particles, ray-march steps of a dust devil,
 * shadow re-bakes). Recovery is slow and one step at a time, after a few seconds of
 * frames on time, so the picture does not pump.
 */
export class LoadGovernor {
  /** 0 = everything on, 3 = maximum relief. */
  relief = 0;
  /** Frame-local multiplier for particle spawning (1 → 0.25 with relief). */
  get particleBudget(): number {
    return [1, 0.6, 0.4, 0.25][this.relief];
  }
  /** Last decision, for the HUD/debugging: 'gpu', 'cpu' or ''. */
  cause: '' | 'gpu' | 'cpu' = '';
  private lateRun = 0;
  private onTime = 0;
  private cooldown = 0;
  private cpuAvg = 0;
  /** The device's usual frame time, s (slow average without the spikes). */
  private pace = 1 / 60;
  /** Seconds observed: the first two only learn the pace (no judgement yet). */
  private seen = 0;

  /**
   * @param dt     time since the previous frame, s
   * @param cpu    time the previous frame spent in our code, s
   * @param period display frame period (1/60, 1/120 ...), s
   * @returns a requested resolution step (negative = lower it now), 0 = none
   */
  update(dt: number, cpu: number, period: number): number {
    this.cpuAvg += (cpu - this.cpuAvg) * 0.2;
    this.cooldown -= dt;
    if (dt > 0.25) return 0; // a tab switch or a load hitch, not rendering load
    if (this.seen < 2) {
      this.pace = this.seen === 0 ? dt : this.pace + (dt - this.pace) * 0.1;
      this.seen += dt;
      return 0;
    }
    const slow = dt > Math.max(period * 1.35, this.pace * 1.4);
    // The pace learns from every frame (a device that runs 35 fps teaches it 35 fps),
    // spikes clipped and weighted little, so a slowdown does not become the new normal.
    this.pace += (Math.min(dt, this.pace * 1.6) - this.pace) * (slow ? 0.004 : 0.03);
    if (slow) {
      this.lateRun++;
      // A lone slow frame costs a second of the recovery count, not all of it.
      this.onTime = Math.max(0, this.onTime - 1);
    } else {
      this.lateRun = 0;
      this.onTime += dt;
    }
    if (this.lateRun >= 3 && this.cooldown <= 0) {
      this.lateRun = 0;
      this.cooldown = 0.6; // let the change take effect before judging again
      this.cause = this.cpuAvg > period * 0.75 ? 'cpu' : 'gpu';
      if (this.relief < 3) this.relief++;
      // GPU-bound: fewer pixels right now. CPU-bound: the relief step alone.
      return this.cause === 'gpu' ? -0.15 : 0;
    }
    // Back up one step after 6 s of frames on time.
    if (this.onTime > 6 && this.relief > 0) {
      this.relief--;
      this.onTime = 0;
    }
    return 0;
  }
}
