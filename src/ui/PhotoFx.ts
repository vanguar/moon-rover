import type { PhotoPart } from '../rover/specs';

export type PhotoTheme = 'moon' | 'mars';

const THEMES: Record<PhotoTheme, { dark: [number, number, number]; light: [number, number, number]; line: string; glow: string }> = {
  moon: { dark: [6, 14, 24], light: [214, 232, 244], line: '120,220,255', glow: '190,240,255' },
  mars: { dark: [26, 10, 6], light: [255, 214, 170], line: '255,170,90', glow: '255,220,170' },
};

interface Prepared {
  w: number;
  h: number;
  /** Duotone "archival hologram" rendering of the photo. */
  tone: HTMLCanvasElement;
  /** Edge contours (Sobel) in the theme's line colour, alpha = edge strength. */
  edges: HTMLCanvasElement;
}

const cache = new Map<string, Promise<Prepared>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Tone-map the photo and extract its contours once per image and size. */
function prepare(src: string, w: number, h: number, theme: PhotoTheme): Promise<Prepared> {
  const key = `${src}|${w}|${theme}`;
  let p = cache.get(key);
  if (p) return p;
  p = loadImage(src).then((img) => {
    const base = canvas(w, h);
    const g = base.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, w, h);
    const src0 = g.getImageData(0, 0, w, h);
    const d = src0.data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    // Local contrast: subtract a blurred copy (3-tap box twice) to bring out structure.
    const blur = new Float32Array(lum);
    const tmp = new Float32Array(w * h);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0, n = 0;
          for (let k = -3; k <= 3; k++) {
            const xx = x + k;
            if (xx >= 0 && xx < w) { s += blur[y * w + xx]; n++; }
          }
          tmp[y * w + x] = s / n;
        }
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0, n = 0;
          for (let k = -3; k <= 3; k++) {
            const yy = y + k;
            if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; }
          }
          blur[y * w + x] = s / n;
        }
    }
    const T = THEMES[theme];
    const tone = canvas(w, h);
    const tg = tone.getContext('2d')!;
    const out = tg.createImageData(w, h);
    const o = out.data;
    for (let i = 0; i < w * h; i++) {
      let v = lum[i] + (lum[i] - blur[i]) * 1.3;
      v = Math.min(1, Math.max(0, v));
      v = v * v * (3 - 2 * v); // S-curve
      // Keep a trace of the original colour so the rover stays recognisable.
      const keep = 0.22;
      for (let c = 0; c < 3; c++) {
        const duo = T.dark[c] + (T.light[c] - T.dark[c]) * v;
        o[i * 4 + c] = duo * (1 - keep) + d[i * 4 + c] * keep;
      }
      o[i * 4 + 3] = 255;
    }
    tg.putImageData(out, 0, 0);

    // Sobel edges on the slightly smoothed luminance.
    const edges = canvas(w, h);
    const eg = edges.getContext('2d')!;
    const ed = eg.createImageData(w, h);
    const e = ed.data;
    const [lr, lg, lb] = T.line.split(',').map(Number);
    const L = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] * 0.6 + blur[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] * 0.4;
    const mags = new Float32Array(w * h);
    let maxM = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const gx = -L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1) + L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1);
        const gy = -L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1) + L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1);
        const m = Math.hypot(gx, gy);
        mags[y * w + x] = m;
        if (m > maxM) maxM = m;
      }
    const sorted = Array.from(mags.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.78)], hi = sorted[Math.floor(sorted.length * 0.985)] || maxM;
    for (let i = 0; i < w * h; i++) {
      const a = Math.min(1, Math.max(0, (mags[i] - lo) / (hi - lo + 1e-6)));
      e[i * 4] = lr;
      e[i * 4 + 1] = lg;
      e[i * 4 + 2] = lb;
      e[i * 4 + 3] = Math.round(Math.pow(a, 0.8) * 255);
    }
    eg.putImageData(ed, 0, 0);
    return { w, h, tone, edges };
  });
  cache.set(key, p);
  return p;
}

/**
 * Animated rendering of a rover photograph so it reads as a living hologram
 * rather than a still: the contours draw themselves in, a scan beam sweeps over
 * them, the image drifts (Ken Burns), and the parts marked in the spec move —
 * wheels turn, masts and antennas sway, solar panels catch a travelling glint.
 */
export class PhotoFx {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private prep: Prepared | null = null;
  private t0 = performance.now();
  private reveal = 0;
  private scratch: HTMLCanvasElement;
  private sg: CanvasRenderingContext2D;
  private pointer = { x: 0, y: 0 };
  private noise: HTMLCanvasElement;
  /** Fully animated (selected / hovered) or a calm idle loop. */
  active = false;

  constructor(
    src: string,
    private parts: PhotoPart[],
    private theme: PhotoTheme,
    w: number,
    h: number,
  ) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas = canvas(Math.round(w * dpr), Math.round(h * dpr));
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.g = this.canvas.getContext('2d')!;
    this.scratch = canvas(this.canvas.width, this.canvas.height);
    this.sg = this.scratch.getContext('2d')!;
    this.noise = canvas(128, 128);
    const ng = this.noise.getContext('2d')!;
    const nd = ng.createImageData(128, 128);
    for (let i = 0; i < nd.data.length; i += 4) {
      const v = Math.random() * 255;
      nd.data[i] = nd.data[i + 1] = nd.data[i + 2] = v;
      nd.data[i + 3] = 22;
    }
    ng.putImageData(nd, 0, 0);
    // Prepare at the canvas resolution (capped) for crisp contours.
    const pw = Math.min(this.canvas.width, 960);
    void prepare(src, pw, Math.round((pw * h) / w), theme).then((p) => {
      this.prep = p;
      this.replay();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.x = (e.clientX - r.left) / r.width - 0.5;
      this.pointer.y = (e.clientY - r.top) / r.height - 0.5;
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer.x = this.pointer.y = 0;
    });
  }

  /** Restart the draw-in sequence. */
  replay(): void {
    this.t0 = performance.now();
    this.reveal = 0;
  }

  draw(now: number): void {
    const p = this.prep;
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    if (!p) {
      g.fillStyle = '#05080b';
      g.fillRect(0, 0, W, H);
      return;
    }
    const t = (now - this.t0) / 1000;
    const T = THEMES[this.theme];
    // Sequence: contours draw in (0–1.6 s), then the image develops underneath (to 3 s).
    this.reveal = Math.min(1, t / 1.6);
    const develop = Math.min(1, Math.max(0, (t - 0.9) / 2.1));
    const sp = this.active ? 1 : 0.35;
    const k = 1.06 + 0.025 * Math.sin(now / 1000 * 0.11 * sp);
    const ox = Math.sin(now / 1000 * 0.07 * sp) * 0.012 * W + this.pointer.x * W * 0.02;
    const oy = Math.cos(now / 1000 * 0.05 * sp) * 0.01 * H + this.pointer.y * H * 0.02;
    const base = (c: CanvasRenderingContext2D) => {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.translate(W / 2 + ox, H / 2 + oy);
      c.scale(k, k);
      c.translate(-W / 2, -H / 2);
    };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = `rgb(${T.dark.join(',')})`;
    g.fillRect(0, 0, W, H);
    base(g);
    g.globalAlpha = develop;
    g.drawImage(p.tone, 0, 0, W, H);
    g.globalAlpha = 1;
    const time = now / 1000;
    // Animated parts (drawn from the toned image + its contours, transformed in place).
    for (const part of this.parts) {
      if (part.kind === 'glint') continue;
      g.save();
      base(g);
      const pts = part.kind === 'sway' ? part.poly : null;
      g.beginPath();
      if (part.kind === 'spin') {
        g.ellipse(part.cx * W, part.cy * H, part.rx * W, part.ry * H, part.tilt ?? 0, 0, Math.PI * 2);
      } else if (pts) {
        pts.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
        g.closePath();
      }
      g.clip();
      if (part.kind === 'spin') {
        const a = time * (part.speed ?? 1) * sp * 1.6;
        const cx = part.cx * W, cy = part.cy * H, rx = part.rx * W, ry = part.ry * H, tilt = part.tilt ?? 0;
        g.translate(cx, cy);
        g.rotate(tilt);
        g.scale(rx, ry);
        g.rotate(a);
        g.scale(1 / rx, 1 / ry);
        g.rotate(-tilt);
        g.translate(-cx, -cy);
      } else {
        const a = part.amp * Math.sin((time / part.period) * Math.PI * 2) * (0.4 + 0.6 * sp);
        g.translate(part.px * W, part.py * H);
        g.rotate(a);
        g.translate(-part.px * W, -part.py * H);
      }
      g.globalAlpha = develop;
      g.drawImage(p.tone, 0, 0, W, H);
      g.globalAlpha = 0.9 * this.reveal;
      g.globalCompositeOperation = 'lighter';
      g.drawImage(p.edges, 0, 0, W, H);
      g.restore();
    }
    // Contours: a steady faint layer, revealed left-to-right at first, plus a scanning beam.
    const sg = this.sg;
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalCompositeOperation = 'source-over';
    sg.clearRect(0, 0, W, H);
    base(sg);
    sg.drawImage(p.edges, 0, 0, W, H);
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalCompositeOperation = 'destination-in';
    const revealX = this.reveal * W * 1.3;
    const scan = ((time * (this.active ? 0.33 : 0.12)) % 1.6) - 0.3; // beam position 0..1 across the diagonal
    const grd = sg.createLinearGradient(0, 0, W, H * 0.4);
    const clampS = (v: number) => Math.min(1, Math.max(0, v));
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(clampS(scan - 0.12), 'rgba(0,0,0,0.5)');
    grd.addColorStop(clampS(scan), 'rgba(0,0,0,1)');
    grd.addColorStop(clampS(scan + 0.06), 'rgba(0,0,0,0.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0.45)');
    sg.fillStyle = grd;
    sg.fillRect(0, 0, W, H);
    if (this.reveal < 1) {
      sg.globalCompositeOperation = 'destination-in';
      const rg = sg.createLinearGradient(revealX - W * 0.3, 0, revealX, 0);
      rg.addColorStop(0, 'rgba(0,0,0,1)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      sg.fillStyle = rg;
      sg.fillRect(0, 0, W, H);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.55 + 0.45 * (1 - develop) + 0.15 * Math.sin(time * 2.1) * (this.active ? 1 : 0.3);
    g.drawImage(this.scratch, 0, 0);
    // Leading edge of the draw-in: a bright vertical line.
    if (this.reveal < 1) {
      g.globalAlpha = 0.7 * (1 - this.reveal);
      g.fillStyle = `rgb(${T.glow})`;
      g.fillRect(revealX - W * 0.3 - 1, 0, 2, H);
    }
    // Glints across panels.
    for (const part of this.parts) {
      if (part.kind !== 'glint') continue;
      g.save();
      base(g);
      g.beginPath();
      part.poly.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
      g.closePath();
      g.clip();
      const ph = ((time / part.period) % 1.4) - 0.2;
      const xs = part.poly.map((q) => q[0]), ys = part.poly.map((q) => q[1]);
      const x0 = Math.min(...xs) * W, x1 = Math.max(...xs) * W, y0 = Math.min(...ys) * H, y1 = Math.max(...ys) * H;
      const gx = x0 + (x1 - x0) * ph;
      const lg = g.createLinearGradient(gx - (x1 - x0) * 0.15, y0, gx + (x1 - x0) * 0.15, y1);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, `rgba(${T.glow},0.45)`);
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = develop;
      g.fillStyle = lg;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
    }
    // Film: scanlines, grain, vignette.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(0,0,0,0.18)';
    const step = Math.max(2, Math.round(H / 150));
    for (let y = (Math.floor(time * 20) % step); y < H; y += step) g.fillRect(0, y, W, 1);
    g.globalAlpha = 0.6;
    const nx = Math.floor(Math.random() * 128), ny = Math.floor(Math.random() * 128);
    g.fillStyle = g.createPattern(this.noise, 'repeat')!;
    g.translate(-nx, -ny);
    g.fillRect(nx, ny, W, H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }
}
