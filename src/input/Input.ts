import type { DriveInput } from '../rover/Rover';

export type Action = 'camera' | 'top' | 'reset' | 'lights' | 'pause' | 'park' | 'hud' | 'zoomin' | 'zoomout' | 'const' | 'weather' | 'auto' | 'brush';

/**
 * Merges keyboard, gamepad, touch (joystick + pedals) and device-tilt steering
 * into one DriveInput.
 */
export class Input {
  readonly drive: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  tiltEnabled = false;
  /** Helicopter: vertical command −1 (descend) .. 1 (climb). */
  lift = 0;
  /** Helicopter mode: the joystick's vertical axis is the collective, not the throttle. */
  heliMode = false;
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';

  private keys = new Set<string>();
  private kbSteer = 0;
  private listeners: ((a: Action) => void)[] = [];
  private padPrev: boolean[] = [];
  private touch = { steer: 0, joyY: 0, gas: 0, brake: 0, hand: false };
  private tilt = 0;
  private tiltZero = 0;
  private tiltRaw = 0;
  private tiltCalibrate = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.lastDevice = 'keyboard';
      if (!e.repeat) {
        const map: Record<string, Action> = {
          KeyC: 'camera', KeyV: 'top', KeyR: 'reset', KeyH: 'lights', Escape: 'pause', KeyP: 'park', KeyI: 'hud', KeyK: 'const', KeyB: 'weather', KeyT: 'auto', KeyX: 'brush',
          Equal: 'zoomin', NumpadAdd: 'zoomin', Minus: 'zoomout', NumpadSubtract: 'zoomout',
        };
        const a = map[e.code];
        if (a) this.emit(a);
      }
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  onAction(cb: (a: Action) => void): void {
    this.listeners.push(cb);
  }

  emit(a: Action): void {
    for (const l of this.listeners) l(a);
  }

  /** Bind the on-screen touch controls. */
  bindTouch(root: HTMLElement): void {
    const joy = root.querySelector<HTMLElement>('#joy')!;
    const knob = joy.querySelector<HTMLElement>('.knob')!;
    let joyId: number | null = null;
    const joyMove = (e: PointerEvent) => {
      const r = joy.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
      this.touch.steer = Math.abs(dx) < 0.08 ? 0 : dx;
      this.touch.joyY = Math.abs(dy) < 0.15 ? 0 : -dy;
    };
    joy.addEventListener('pointerdown', (e) => {
      joyId = e.pointerId;
      joy.setPointerCapture(e.pointerId);
      joy.classList.add('active');
      this.lastDevice = 'touch';
      joyMove(e);
    });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) joyMove(e); });
    const joyEnd = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return;
      joyId = null;
      joy.classList.remove('active');
      knob.style.transform = '';
      this.touch.steer = 0;
      this.touch.joyY = 0;
    };
    joy.addEventListener('pointerup', joyEnd);
    joy.addEventListener('pointercancel', joyEnd);

    const pedal = (id: string, key: 'gas' | 'brake') => {
      const el = root.querySelector<HTMLElement>(id)!;
      const set = (e: PointerEvent, on: boolean) => {
        if (!on) { this.touch[key] = 0; el.classList.remove('on'); return; }
        // Pressure from vertical position on the pedal: top = full.
        const r = el.getBoundingClientRect();
        this.touch[key] = Math.min(1, Math.max(0.35, 1 - (e.clientY - r.top) / r.height + 0.35));
        el.classList.add('on');
      };
      el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); this.lastDevice = 'touch'; set(e, true); });
      el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(e, true); });
      el.addEventListener('pointerup', (e) => set(e, false));
      el.addEventListener('pointercancel', (e) => set(e, false));
    };
    pedal('#gas', 'gas');
    pedal('#brake', 'brake');
  }

  /** Enable steering by tilting the phone (asks permission on iOS). */
  async enableTilt(): Promise<boolean> {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    window.addEventListener('deviceorientation', this.onOrient);
    this.tiltEnabled = true;
    this.tiltCalibrate = true;
    return true;
  }

  disableTilt(): void {
    window.removeEventListener('deviceorientation', this.onOrient);
    this.tiltEnabled = false;
    this.tilt = 0;
  }

  calibrateTilt(): void {
    this.tiltCalibrate = true;
  }

  private onOrient = (e: DeviceOrientationEvent) => {
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
    // Holding the phone like a steering wheel in landscape rotates it about the screen normal-ish axis: beta.
    let v: number;
    if (angle === 90) v = e.beta ?? 0;
    else if (angle === 270 || angle === -90) v = -(e.beta ?? 0);
    else v = e.gamma ?? 0;
    this.tiltRaw = v;
    if (this.tiltCalibrate) {
      this.tiltZero = v;
      this.tiltCalibrate = false;
    }
    const d = v - this.tiltZero;
    this.tilt = Math.max(-1, Math.min(1, Math.abs(d) < 2 ? 0 : (d - Math.sign(d) * 2) / 22));
  };

  update(dt: number): void {
    const k = this.keys;
    const kThrottle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    const kBrake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    const kSteer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    // Keyboard steering ramps like a real hand controller instead of snapping.
    if (kSteer !== 0) this.kbSteer += (kSteer - this.kbSteer) * Math.min(1, dt * 3.5);
    else this.kbSteer += (0 - this.kbSteer) * Math.min(1, dt * 6);

    let throttle = kThrottle, brake = kBrake, steer = this.kbSteer, hand = k.has('Space');
    let lift = (k.has('Space') ? 1 : 0) - (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('ControlLeft') ? 1 : 0);

    // Gamepad (standard mapping).
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || p.mapping !== 'standard') continue;
      const ax = p.axes[0] ?? 0;
      const rt = p.buttons[7]?.value ?? 0, lt = p.buttons[6]?.value ?? 0;
      const sx = Math.abs(ax) > 0.12 ? (ax - Math.sign(ax) * 0.12) / 0.88 : 0;
      if (rt > 0.02 || lt > 0.02 || sx !== 0 || p.buttons.some((b) => b.pressed)) this.lastDevice = 'gamepad';
      throttle = Math.max(throttle, rt);
      brake = Math.max(brake, lt);
      if (sx !== 0) steer = sx;
      if (p.buttons[0]?.pressed) hand = true;
      const ry = p.axes[3] ?? 0;
      if (Math.abs(ry) > 0.15) lift = -ry;
      const edges: [number, Action][] = [[3, 'camera'], [2, 'lights'], [8, 'reset'], [9, 'pause'], [1, 'reset'], [5, 'auto']];
      for (const [b, a] of edges) {
        const now = !!p.buttons[b]?.pressed;
        if (now && !this.padPrev[b]) this.emit(a);
        this.padPrev[b] = now;
      }
      break;
    }

    // Touch.
    const t = this.touch;
    if (this.heliMode) {
      throttle = Math.max(throttle, t.gas);
      brake = Math.max(brake, t.brake);
      if (t.joyY !== 0) lift = t.joyY;
    } else {
      throttle = Math.max(throttle, t.gas, Math.max(0, t.joyY));
      brake = Math.max(brake, t.brake, Math.max(0, -t.joyY));
    }
    this.lift = Math.max(-1, Math.min(1, lift));
    if (t.steer !== 0) steer = t.steer;
    else if (this.tiltEnabled && this.tilt !== 0) steer = this.tilt;
    if (t.hand) hand = true;

    this.drive.throttle = throttle;
    this.drive.brake = brake;
    this.drive.steer = Math.max(-1, Math.min(1, steer));
    this.drive.handbrake = hand;
  }

  get tiltValue(): number {
    return this.tiltRaw - this.tiltZero;
  }
}
