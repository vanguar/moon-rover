import * as THREE from 'three';

export interface PanelData {
  speedKmh: number;
  pitch: number;
  roll: number;
  heading: number;
  bearing: number; // to LM, deg
  range: number; // to LM, km
  distance: number; // odometer, km
  battery: number; // 0..1
  volts: number;
  battTempC: number;
  motorTempC: [number, number]; // front, rear
  slope: number;
  elevation: number;
  parkBrake: boolean;
  headlights: boolean;
  warnRoll: boolean;
  warnBatt: boolean;
  warnTemp: boolean;
}

const W = 1024, H = 640;
const AMP_HR = 121; // each LRV silver-zinc battery

/**
 * The rover's Control & Display Console, modelled on the LRV's: navigation
 * section (pitch, heading, roll, bearing/distance/range counters, speed) on top,
 * power/temperature monitor and caution lamps below. Drawn to a canvas texture.
 */
export class InstrumentPanel {
  readonly group = new THREE.Group();
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private timer = 0;
  private blink = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;

    const pw = 0.5, ph = 0.3125;
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(pw + 0.03, ph + 0.03, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x3a3d40, metalness: 0.6, roughness: 0.5 }),
    );
    housing.position.z = -0.042;
    housing.castShadow = housing.receiveShadow = true;
    // Instrument faces are not backlit on the real LRV; a little emission keeps them readable in shadow.
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(pw, ph),
      new THREE.MeshStandardMaterial({ map: this.tex, emissiveMap: this.tex, emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.75, metalness: 0 }),
    );
    face.receiveShadow = true;
    // Glass cover: faint specular sheen.
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(pw, ph),
      new THREE.MeshStandardMaterial({ color: 0x000000, metalness: 1, roughness: 0.05, transparent: true, opacity: 0.12 }),
    );
    glass.position.z = 0.003;
    // Toggle switches & circuit breakers along the bottom edge.
    const sw = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.9, roughness: 0.3 });
    const base = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.6 });
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 10), base);
      b.rotation.x = Math.PI / 2;
      b.position.set(-0.21 + i * 0.06, -ph / 2 - 0.035, 0.0);
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.004, 0.03, 6), sw);
      lever.position.set(-0.21 + i * 0.06, -ph / 2 - 0.03, 0.018);
      lever.rotation.x = Math.PI / 2 + (i % 3 === 0 ? -0.5 : 0.5);
      this.group.add(b, lever);
    }
    const lip = new THREE.Mesh(new THREE.BoxGeometry(pw + 0.03, 0.06, 0.03), new THREE.MeshStandardMaterial({ color: 0x3a3d40, metalness: 0.6, roughness: 0.5 }));
    lip.position.set(0, -ph / 2 - 0.035, -0.02);
    // Sun-shadow device on top: a fin whose shadow on a scale gave the sun's azimuth.
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.05, 0.05), sw);
    fin.position.set(0, ph / 2 + 0.035, -0.02);
    const scale = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.004, 0.05), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.8 }));
    scale.position.set(0, ph / 2 + 0.012, -0.02);
    for (const m of [fin, scale, lip]) m.castShadow = m.receiveShadow = true;
    this.group.add(housing, face, glass, lip, fin, scale);
  }

  update(dt: number, d: PanelData): void {
    this.timer -= dt;
    this.blink += dt;
    if (this.timer > 0) return;
    this.timer = 1 / 15;
    this.draw(d);
    this.tex.needsUpdate = true;
  }

  private draw(d: PanelData): void {
    const g = this.g;
    g.fillStyle = '#16181a';
    g.fillRect(0, 0, W, H);
    // Panel sections.
    g.strokeStyle = '#5c6166';
    g.lineWidth = 3;
    g.strokeRect(8, 8, W - 16, 322);
    g.strokeRect(8, 338, W - 16, H - 346);
    this.label('NAVIGATION', 20, 30, 16, '#9aa1a8', 'left');
    this.label('POWER / TEMPERATURE MONITOR', 20, 360, 16, '#9aa1a8', 'left');

    this.pitchGauge(70, 180, d.pitch);
    this.headingDial(270, 182, 128, d.heading);
    this.rollGauge(520, 210, d.roll);
    this.counter('BEARING', 700, 70, Math.round(d.bearing).toString().padStart(3, '0'), 'DEG');
    this.counter('DISTANCE', 700, 150, d.distance.toFixed(1).padStart(4, '0'), 'KM');
    this.counter('RANGE', 700, 230, d.range.toFixed(1).padStart(4, '0'), 'KM');
    this.speedGauge(900, 190, d.speedKmh);

    // Power section.
    const ah = d.battery * AMP_HR;
    this.barGauge('AMP-HR 1', 40, 400, ah + 0.4, AMP_HR, '#e8e8e8');
    this.barGauge('AMP-HR 2', 40, 470, ah - 0.4, AMP_HR, '#e8e8e8');
    this.meter('VOLTS', 380, 520, d.volts, 0, 50, [[0, 30, '#c0392b'], [30, 50, '#2e7d32']]);
    this.meter('BATT °C', 540, 520, d.battTempC, -20, 80, [[60, 80, '#c0392b']]);
    this.meter('MOTOR FWD °C', 700, 520, d.motorTempC[0], 0, 150, [[120, 150, '#c0392b']]);
    this.meter('MOTOR AFT °C', 860, 520, d.motorTempC[1], 0, 150, [[120, 150, '#c0392b']]);
    this.label(`SLOPE ${d.slope.toFixed(0)}°`, 40, 575, 18, '#cfd3d6', 'left');
    this.label(`ELEV ${d.elevation.toFixed(0)} M`, 40, 605, 18, '#cfd3d6', 'left');

    // Caution & warning flags.
    const on = Math.floor(this.blink * 2.5) % 2 === 0;
    const lamps: [string, boolean, string][] = [
      ['ROLL', d.warnRoll && on, '#ff3b2f'],
      ['BATT', d.warnBatt, '#ffb020'],
      ['TEMP', d.warnTemp, '#ffb020'],
      ['PARK BRAKE', d.parkBrake, '#ffb020'],
      ['LIGHTS', d.headlights, '#58d68d'],
    ];
    lamps.forEach(([t, lit, col], i) => {
      const w = i < 3 ? 56 : 88;
      const px = 190 + (i < 3 ? i * 62 : (i - 3) * 93), py = i < 3 ? 565 : 605;
      g.fillStyle = lit ? col : '#2a2c2e';
      g.fillRect(px, py - 16, w, 26);
      g.strokeStyle = '#555';
      g.lineWidth = 1;
      g.strokeRect(px, py - 16, w, 26);
      this.label(t, px + w / 2, py + 3, 14, lit ? '#111' : '#666', 'center');
    });
  }

  private label(t: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign): void {
    const g = this.g;
    g.fillStyle = col;
    g.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`;
    g.textAlign = align;
    g.fillText(t, x, y);
  }

  private pitchGauge(x: number, y: number, pitch: number): void {
    const g = this.g;
    this.label('PITCH', x, y - 125, 15, '#cfd3d6', 'center');
    g.fillStyle = '#0b0c0d';
    g.fillRect(x - 28, y - 110, 56, 220);
    g.strokeStyle = '#ddd';
    g.lineWidth = 2;
    for (let a = -25; a <= 25; a += 5) {
      const yy = y - a * 4;
      g.beginPath();
      g.moveTo(x - 28, yy);
      g.lineTo(x - (a % 10 === 0 ? 8 : 16), yy);
      g.stroke();
      if (a % 10 === 0) this.label(String(Math.abs(a)), x + 10, yy + 5, 13, '#ddd', 'center');
    }
    const p = THREE.MathUtils.clamp(pitch, -27, 27);
    g.fillStyle = Math.abs(pitch) > 25 ? '#ff5a4a' : '#f2c14e';
    g.beginPath();
    g.moveTo(x - 28, y - p * 4);
    g.lineTo(x - 6, y - p * 4 - 8);
    g.lineTo(x - 6, y - p * 4 + 8);
    g.fill();
  }

  private rollGauge(x: number, y: number, roll: number): void {
    const g = this.g;
    const r = 95;
    this.label('ROLL', x, y - 130, 15, '#cfd3d6', 'center');
    g.fillStyle = '#0b0c0d';
    g.beginPath();
    g.arc(x, y, r + 10, Math.PI * 1.15, Math.PI * 1.85);
    g.lineTo(x, y);
    g.fill();
    g.strokeStyle = '#ddd';
    g.lineWidth = 2;
    for (let a = -25; a <= 25; a += 5) {
      const t = -Math.PI / 2 + (a * Math.PI) / 100;
      const l = a % 10 === 0 ? 18 : 10;
      g.beginPath();
      g.moveTo(x + Math.cos(t) * r, y + Math.sin(t) * r);
      g.lineTo(x + Math.cos(t) * (r - l), y + Math.sin(t) * (r - l));
      g.stroke();
      if (a % 10 === 0 && a !== 0) this.label(String(Math.abs(a)), x + Math.cos(t) * (r - 32), y + Math.sin(t) * (r - 32) + 5, 13, '#ddd', 'center');
    }
    const rr = THREE.MathUtils.clamp(roll, -28, 28);
    const t = -Math.PI / 2 - (rr * Math.PI) / 100;
    g.strokeStyle = Math.abs(roll) > 25 ? '#ff5a4a' : '#f2c14e';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(t) * (r - 6), y + Math.sin(t) * (r - 6));
    g.stroke();
    g.fillStyle = '#888';
    g.beginPath();
    g.arc(x, y, 7, 0, Math.PI * 2);
    g.fill();
  }

  private headingDial(x: number, y: number, r: number, heading: number): void {
    const g = this.g;
    this.label('HEADING', x, y - r - 14, 15, '#cfd3d6', 'center');
    g.fillStyle = '#0b0c0d';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.translate(x, y);
    g.rotate((-heading * Math.PI) / 180);
    g.strokeStyle = '#ddd';
    for (let a = 0; a < 360; a += 5) {
      const t = (a * Math.PI) / 180 - Math.PI / 2;
      const l = a % 30 === 0 ? 16 : a % 10 === 0 ? 10 : 6;
      g.lineWidth = a % 30 === 0 ? 2.5 : 1.5;
      g.beginPath();
      g.moveTo(Math.cos(t) * (r - 4), Math.sin(t) * (r - 4));
      g.lineTo(Math.cos(t) * (r - 4 - l), Math.sin(t) * (r - 4 - l));
      g.stroke();
      if (a % 30 === 0) {
        g.save();
        g.rotate((a * Math.PI) / 180);
        const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
        this.label(names[a] ?? String(a / 10), 0, -r + 40, names[a] ? 20 : 16, names[a] ? '#f2c14e' : '#ddd', 'center');
        g.restore();
      }
    }
    g.restore();
    // Lubber line and rover symbol.
    g.fillStyle = '#f2c14e';
    g.beginPath();
    g.moveTo(x, y - r + 2);
    g.lineTo(x - 8, y - r + 18);
    g.lineTo(x + 8, y - r + 18);
    g.fill();
    g.strokeStyle = '#f2c14e';
    g.lineWidth = 3;
    g.strokeRect(x - 9, y - 16, 18, 32);
  }

  private counter(title: string, x: number, y: number, digits: string, unit: string): void {
    const g = this.g;
    this.label(title, x, y - 8, 15, '#cfd3d6', 'left');
    let cx = x;
    for (const ch of digits) {
      if (ch === '.') {
        g.fillStyle = '#ddd';
        g.fillRect(cx + 2, y + 40, 5, 5);
        cx += 10;
        continue;
      }
      // Mechanical drum counter window.
      g.fillStyle = '#050505';
      g.fillRect(cx, y, 34, 48);
      const grd = g.createLinearGradient(0, y, 0, y + 48);
      grd.addColorStop(0, 'rgba(255,255,255,0.08)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0)');
      grd.addColorStop(1, 'rgba(255,255,255,0.08)');
      g.fillStyle = grd;
      g.fillRect(cx, y, 34, 48);
      g.fillStyle = '#f0f0f0';
      g.font = 'bold 36px "Courier New", monospace';
      g.textAlign = 'center';
      g.fillText(ch, cx + 17, y + 38);
      cx += 38;
    }
    this.label(unit, cx + 8, y + 38, 15, '#9aa1a8', 'left');
  }

  private speedGauge(x: number, y: number, v: number): void {
    const g = this.g;
    this.label('SPEED', x, y - 130, 15, '#cfd3d6', 'center');
    this.label('KM/HR', x, y + 120, 13, '#9aa1a8', 'center');
    g.fillStyle = '#0b0c0d';
    g.fillRect(x - 40, y - 115, 80, 225);
    g.strokeStyle = '#ddd';
    g.lineWidth = 2;
    for (let s = 0; s <= 20; s += 2) {
      const yy = y + 100 - s * 10;
      g.beginPath();
      g.moveTo(x - 40, yy);
      g.lineTo(x - (s % 4 === 0 ? 18 : 28), yy);
      g.stroke();
      if (s % 4 === 0) this.label(String(s), x + 10, yy + 5, 15, '#ddd', 'center');
    }
    const p = THREE.MathUtils.clamp(v, 0, 21);
    g.fillStyle = '#f2c14e';
    g.beginPath();
    g.moveTo(x - 40, y + 100 - p * 10);
    g.lineTo(x - 14, y + 100 - p * 10 - 9);
    g.lineTo(x - 14, y + 100 - p * 10 + 9);
    g.fill();
  }

  private barGauge(title: string, x: number, y: number, value: number, max: number, col: string): void {
    const g = this.g;
    this.label(title, x, y, 15, '#cfd3d6', 'left');
    g.fillStyle = '#0b0c0d';
    g.fillRect(x, y + 10, 280, 30);
    const f = THREE.MathUtils.clamp(value / max, 0, 1);
    g.fillStyle = f < 0.15 ? '#ff5a4a' : col;
    g.fillRect(x + 2, y + 12, 276 * f, 26);
    g.strokeStyle = '#555';
    for (let i = 0; i <= 12; i++) {
      g.beginPath();
      g.moveTo(x + i * 23.3, y + 40);
      g.lineTo(x + i * 23.3, y + 46);
      g.stroke();
    }
    this.label(Math.max(0, value).toFixed(0), x + 290, y + 34, 22, '#f0f0f0', 'left');
  }

  private meter(title: string, x: number, y: number, v: number, lo: number, hi: number, zones: [number, number, string][]): void {
    const g = this.g;
    const r = 62;
    this.label(title, x, y + 34, 13, '#cfd3d6', 'center');
    g.fillStyle = '#0b0c0d';
    g.beginPath();
    g.arc(x, y, r + 8, Math.PI, 0);
    g.fill();
    const ang = (val: number) => Math.PI + ((val - lo) / (hi - lo)) * Math.PI;
    for (const [a, b, col] of zones) {
      g.strokeStyle = col;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(x, y, r - 3, ang(a), ang(b));
      g.stroke();
    }
    g.strokeStyle = '#ddd';
    g.lineWidth = 1.5;
    for (let i = 0; i <= 10; i++) {
      const t = Math.PI + (i / 10) * Math.PI;
      g.beginPath();
      g.moveTo(x + Math.cos(t) * r, y + Math.sin(t) * r);
      g.lineTo(x + Math.cos(t) * (r - (i % 5 === 0 ? 14 : 8)), y + Math.sin(t) * (r - (i % 5 === 0 ? 14 : 8)));
      g.stroke();
    }
    const t = ang(THREE.MathUtils.clamp(v, lo, hi));
    g.strokeStyle = '#f2c14e';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(t) * (r - 8), y + Math.sin(t) * (r - 8));
    g.stroke();
    this.label(v.toFixed(0), x, y + 16, 15, '#f0f0f0', 'center');
  }
}
