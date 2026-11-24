import { dataUrl } from '../version';
import { buildPavement, paveHeight } from './Pavement';

/**
 * Height field of the playable area: real LROC NAC DTM (2 m/px) + procedural
 * small craters that are below the DTM resolution. Shared by the main thread
 * (physics, rocks, dust, HUD) and the terrain mesh worker.
 *
 * World frame: +x east, -z north, +y up, origin at the centre of the DTM window.
 * Heights are stored relative to the DTM minimum (meta.minHeight).
 * Outside the 4 x 4 km window the terrain continues with SLDEM2015 (LOLA +
 * Kaguya, resampled to 112 m), blended into the DTM over the window's edge.
 */
export interface TerrainMeta {
  body?: 'moon' | 'mars';
  source: string;
  width: number;
  height: number;
  pixelSize: number;
  sizeX: number;
  sizeZ: number;
  minHeight: number;
  maxHeight: number;
  /** Metres per heightmap unit (default: full 16-bit range between min and max). */
  heightStep?: number;
  sites?: Record<string, { lat: number; lon: number; x: number; z: number }>;
  orthoSun?: { azimuth: number; incidence: number };
  projection?: { radius: number; standardParallel: number };
  /** Full-resolution orthophoto tiles streamed around the rover (DetailTiles). */
  detail?: { x0: number; z0: number; tile: number; res: number; tiles: string[]; slopes?: boolean };
  /** Surface material map (Mars): 255 = rocky pavement, 0 = sand. */
  material?: { file: string; n: number; pave?: string };
  /** Run-time roughness where the DTM is missing (SLDEM-filled edges): weight map + std, m. */
  synthRough?: { file: string; n: number; std: number };
  centerLat: number;
  centerLon: number;
  landing: { x: number; z: number };
  sun: { azimuth: number; elevation: number };
  earth?: { azimuth: number; elevation: number };
  orthoHi?: { x: number; z: number; size: number };
  epoch?: string;
  galaxy?: { pole: number[]; center: number[] };
  far?: { n: number; spacing: number; size: number; min: number; max: number; offset: number; source: string };
}

export interface FarGrid {
  n: number;
  spacing: number;
  half: number;
  heights: Float32Array;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on an integer lattice (C1, quintic fade). */
function vnoise(x: number, z: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v - 0.5;
}

/** Roughness octaves 120 m … 4 m, amplitude ∝ λ^1.1 (the DTM's k^-2.2 power spectrum). */
function roughRaw(x: number, z: number): number {
  let s = 0, lam = 120, k = 0;
  while (lam >= 4) {
    s += vnoise(x / lam + k * 13.7, z / lam - k * 7.1, 900 + k) * Math.pow(lam, 1.1);
    lam *= 0.5;
    k++;
  }
  return s;
}

const CRATER_SEED = 1971; // Apollo 15 year
const CRATER_COUNT = 5500;
const CRATER_RMIN = 1.2;
const CRATER_RMAX = 30;
const HASH_CELL = 16;

export class TerrainData {
  readonly meta: TerrainMeta;
  /** Raw 16-bit heightmap; metres = value · hScale (half the memory of floats on 8 × 8 km). */
  readonly heights: Uint16Array;
  readonly hScale: number;
  readonly w: number;
  readonly h: number;
  readonly halfX: number;
  readonly halfZ: number;
  /** Crater params packed as [x, z, R, depth, rim] per crater. */
  readonly craters: Float32Array;
  readonly far: FarGrid | null;
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private cellsX: number;

  /** Material map over the window (0 sand .. 255 pavement) and the pavement pattern. */
  readonly material: Uint8Array | null;
  /** DTM weight (0 = SLDEM fill .. 255 = measured DTM) for the run-time roughness. */
  readonly dtmW: Uint8Array | null;
  private roughK = 0;
  readonly pave: Uint8Array | null;

  constructor(meta: TerrainMeta, heights: Uint16Array, far: FarGrid | null = null, material: Uint8Array | null = null, pave: Uint8Array | null = null, dtmW: Uint8Array | null = null) {
    this.material = material;
    this.dtmW = dtmW;
    if (dtmW && meta.synthRough) {
      // Normalise the octave sum to the DTM's measured roughness (std over random points).
      let s2 = 0;
      const r = mulberry32(77);
      for (let i = 0; i < 4096; i++) {
        const v = roughRaw((r() - 0.5) * 8000, (r() - 0.5) * 8000);
        s2 += v * v;
      }
      this.roughK = meta.synthRough.std / Math.sqrt(s2 / 4096);
    }
    this.pave = material ? (pave ?? buildPavement()) : null;
    this.meta = meta;
    this.heights = heights;
    this.hScale = meta.heightStep ?? (meta.maxHeight - meta.minHeight) / 65535;
    this.far = far;
    this.w = meta.width;
    this.h = meta.height;
    this.halfX = meta.sizeX / 2;
    this.halfZ = meta.sizeZ / 2;

    const rnd = mulberry32(CRATER_SEED);
    // Mars: wind has filled and planed most small craters; fewer and shallower, sand-filled bowls.
    const mars = meta.body === 'mars';
    // Crater density per km² is fixed (CRATER_COUNT per 4 × 4 km).
    const areaK = (meta.sizeX * meta.sizeZ) / 16e6;
    // Moon: the Apollo 15 mare is saturated with small and medium craters - 2.5x the
    // earlier density, radii up to 45 m.
    const count = Math.round(CRATER_COUNT * areaK * (mars ? 0.35 : 2.5));
    const rMax = mars ? CRATER_RMAX : 45;
    const depthK = mars ? 0.45 : 1;
    this.craters = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
      // Cumulative size-frequency N(>R) ~ R^-2 (Pareto, truncated).
      let R = CRATER_RMIN * Math.pow(1 - rnd(), -0.5);
      if (R > rMax) R = CRATER_RMIN + rnd() * 3;
      const fresh = rnd();
      // Most small craters on an old mare surface are degraded (shallow, soft rims).
      const depth = 2 * R * (0.03 + 0.15 * fresh * fresh * fresh) * depthK;
      const rim = depth * (0.1 + 0.25 * fresh);
      const o = i * 5;
      this.craters[o] = (rnd() - 0.5) * meta.sizeX;
      this.craters[o + 1] = (rnd() - 0.5) * meta.sizeZ;
      this.craters[o + 2] = R;
      this.craters[o + 3] = depth;
      this.craters[o + 4] = rim;
    }

    // CSR spatial hash: each crater is listed in every cell its 2R footprint touches.
    this.cellsX = Math.ceil(meta.sizeX / HASH_CELL) + 1;
    const nCells = this.cellsX * this.cellsX;
    const counts = new Int32Array(nCells + 1);
    const forCells = (i: number, fn: (c: number) => void) => {
      const o = i * 5;
      const r = this.craters[o + 2] * 2;
      const x0 = Math.max(0, Math.floor((this.craters[o] - r + this.halfX) / HASH_CELL));
      const x1 = Math.min(this.cellsX - 1, Math.floor((this.craters[o] + r + this.halfX) / HASH_CELL));
      const z0 = Math.max(0, Math.floor((this.craters[o + 1] - r + this.halfZ) / HASH_CELL));
      const z1 = Math.min(this.cellsX - 1, Math.floor((this.craters[o + 1] + r + this.halfZ) / HASH_CELL));
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) fn(cz * this.cellsX + cx);
    };
    for (let i = 0; i < count; i++) forCells(i, (c) => counts[c + 1]++);
    for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[nCells]);
    const fill = new Int32Array(nCells);
    for (let i = 0; i < count; i++) {
      forCells(i, (c) => {
        this.cellItems[counts[c] + fill[c]++] = i;
      });
    }
  }

  /** Maps any world coordinate into the base window (mirror tiling). */
  mirrorX(x: number): number {
    const s = this.meta.sizeX;
    let m = (x + this.halfX) % (2 * s);
    if (m < 0) m += 2 * s;
    if (m > s) m = 2 * s - m;
    return m - this.halfX;
  }

  mirrorZ(z: number): number {
    const s = this.meta.sizeZ;
    let m = (z + this.halfZ) % (2 * s);
    if (m < 0) m += 2 * s;
    if (m > s) m = 2 * s - m;
    return m - this.halfZ;
  }

  inside(x: number, z: number): boolean {
    return Math.abs(x) <= this.halfX && Math.abs(z) <= this.halfZ;
  }

  private px(ix: number, iz: number): number {
    ix = ix < 0 ? 0 : ix >= this.w ? this.w - 1 : ix;
    iz = iz < 0 ? 0 : iz >= this.h ? this.h - 1 : iz;
    return this.heights[iz * this.w + ix] * this.hScale;
  }

  /** Raw DTM sample (metres above minHeight) at integer pixel coordinates. */
  sample(ix: number, iz: number): number {
    return this.px(ix, iz);
  }

  /** DTM height (Catmull-Rom bicubic) at base-window coordinates. */
  dtmHeight(x: number, z: number): number {
    const fx = (x + this.halfX) / this.meta.pixelSize;
    const fz = (z + this.halfZ) / this.meta.pixelSize;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const wx0 = ((-0.5 * tx + 1) * tx - 0.5) * tx;
    const wx1 = (1.5 * tx - 2.5) * tx * tx + 1;
    const wx2 = ((-1.5 * tx + 2) * tx + 0.5) * tx;
    const wx3 = (0.5 * tx - 0.5) * tx * tx;
    let sum = 0;
    for (let j = -1; j <= 2; j++) {
      const row =
        wx0 * this.px(ix - 1, iz + j) + wx1 * this.px(ix, iz + j) + wx2 * this.px(ix + 1, iz + j) + wx3 * this.px(ix + 2, iz + j);
      const w =
        j === -1 ? ((-0.5 * tz + 1) * tz - 0.5) * tz
        : j === 0 ? (1.5 * tz - 2.5) * tz * tz + 1
        : j === 1 ? ((-1.5 * tz + 2) * tz + 0.5) * tz
        : (0.5 * tz - 0.5) * tz * tz;
      sum += w * row;
    }
    return sum;
  }

  /** Craters formed during play (meteoroid impacts): [x, z, R] each, fresh profile. */
  readonly newCraters: number[] = [];

  /** Fresh crater profile: bowl depth 0.2 D, sharp raised rim, ejecta apron. */
  private newCraterOffset(x: number, z: number): number {
    const c = this.newCraters;
    let off = 0;
    for (let k = 0; k < c.length; k += 3) {
      const dx = x - c[k], dz = z - c[k + 1], R = c[k + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 > 9 * R * R) continue;
      const q = Math.sqrt(d2) / R;
      const depth = 0.4 * R, rim = 0.08 * R;
      if (q < 1) off += -depth * (1 - q * q) + rim * q * q * q * q;
      else off += rim * Math.pow(q, -3);
    }
    return off;
  }

  craterOffset(x: number, z: number): number {
    if (this.newCraters.length) return this.staticCraterOffset(x, z) + this.newCraterOffset(x, z);
    return this.staticCraterOffset(x, z);
  }

  private staticCraterOffset(x: number, z: number): number {
    const cx = Math.floor((x + this.halfX) / HASH_CELL);
    const cz = Math.floor((z + this.halfZ) / HASH_CELL);
    if (cx < 0 || cz < 0 || cx >= this.cellsX || cz >= this.cellsX) return 0;
    const c = cz * this.cellsX + cx;
    let off = 0;
    const cr = this.craters;
    for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
      const o = this.cellItems[k] * 5;
      const dx = x - cr[o], dz = z - cr[o + 1];
      const R = cr[o + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= 4 * R * R) continue;
      const q = Math.sqrt(d2) / R;
      const depth = cr[o + 3], rim = cr[o + 4];
      // Smooth (C1) profile: bowl -depth·(1-q²)² inside, Gaussian rim crest at q = 1,
      // so walls are rounded like degraded small craters, not sharp-edged pits.
      if (q < 1) {
        const b = 1 - q * q;
        off -= depth * b * b;
      }
      const e = (q - 1) / 0.38;
      off += rim * Math.exp(-e * e);
    }
    return off;
  }

  /** Final ground height at any world position. */
  /** SLDEM far-terrain height (bilinear), clamped at the grid edge. */
  farHeight(x: number, z: number): number {
    const f = this.far;
    if (!f) return this.dtmHeight(this.mirrorX(x), this.mirrorZ(z));
    let gx = (x + f.half) / f.spacing, gz = (z + f.half) / f.spacing;
    const m = f.n - 1;
    gx = gx < 0 ? 0 : gx > m ? m : gx;
    gz = gz < 0 ? 0 : gz > m ? m : gz;
    const ix = Math.min(m - 1, Math.floor(gx)), iz = Math.min(m - 1, Math.floor(gz));
    const tx = gx - ix, tz = gz - iz;
    const H = f.heights;
    const a = H[iz * f.n + ix], b = H[iz * f.n + ix + 1], c = H[(iz + 1) * f.n + ix], d = H[(iz + 1) * f.n + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** 0 outside the DTM window, 1 well inside (150 m blend at the edge). */
  dtmWeight(x: number, z: number): number {
    const e = Math.min(this.halfX - Math.abs(x), this.halfZ - Math.abs(z));
    if (e <= 0) return 0;
    if (e >= 150) return 1;
    const t = e / 150;
    return t * t * (3 - 2 * t);
  }

  /** Final ground height at any world position. */
  /** Pavement share at a point, 0 (sand) .. 1 (rocky pavement), bilinear. */
  materialAt(x: number, z: number): number {
    const m = this.material;
    if (!m) return 0;
    const n = this.meta.material!.n;
    const u = ((x + this.halfX) / this.meta.sizeX) * n - 0.5, v = ((z + this.halfZ) / this.meta.sizeZ) * n - 0.5;
    const i = Math.max(0, Math.min(n - 2, Math.floor(u))), j = Math.max(0, Math.min(n - 2, Math.floor(v)));
    const fu = Math.min(1, Math.max(0, u - i)), fv = Math.min(1, Math.max(0, v - j));
    const a = m[j * n + i], b = m[j * n + i + 1], c = m[(j + 1) * n + i], d = m[(j + 1) * n + i + 1];
    return (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv) / 255;
  }

  /** Seeded DTM-like roughness (4–120 m) where the DTM is missing, weighted by 1 − DTM weight. */
  synthRough(x: number, z: number): number {
    const m = this.dtmW;
    if (!m || !this.roughK) return 0;
    const n = this.meta.synthRough!.n;
    const u = ((x + this.halfX) / this.meta.sizeX) * n - 0.5, v = ((z + this.halfZ) / this.meta.sizeZ) * n - 0.5;
    const i = Math.max(0, Math.min(n - 2, Math.floor(u))), j = Math.max(0, Math.min(n - 2, Math.floor(v)));
    const fu = Math.min(1, Math.max(0, u - i)), fv = Math.min(1, Math.max(0, v - j));
    const a = m[j * n + i], b = m[j * n + i + 1], c = m[(j + 1) * n + i], d = m[(j + 1) * n + i + 1];
    const w = (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv) / 255;
    return w >= 0.999 ? 0 : (1 - w) * roughRaw(x, z) * this.roughK;
  }

  /** Centimetre relief of the fractured pavement plates, weighted by the material. */
  microOffset(x: number, z: number): number {
    if (!this.pave) return 0;
    const m = this.materialAt(x, z);
    return m > 0.01 ? m * paveHeight(this.pave, x, z) : 0;
  }

  height(x: number, z: number): number {
    if (!this.far) {
      const mx = this.mirrorX(x), mz = this.mirrorZ(z);
      return this.dtmHeight(mx, mz) + this.craterOffset(mx, mz);
    }
    const w = this.dtmWeight(x, z);
    if (w <= 0) return this.farHeight(x, z);
    const near = this.dtmHeight(x, z) + this.craterOffset(x, z) + this.microOffset(x, z) + this.synthRough(x, z);
    return w >= 1 ? near : near * w + this.farHeight(x, z) * (1 - w);
  }

  /** Unit normal via central differences; writes into out [nx, ny, nz]. */
  normal(x: number, z: number, out: number[] | Float32Array, eps = 0.5): void {
    const hx = this.height(x + eps, z) - this.height(x - eps, z);
    const hz = this.height(x, z + eps) - this.height(x, z - eps);
    const nx = -hx, ny = 2 * eps, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out[0] = nx / l;
    out[1] = ny / l;
    out[2] = nz / l;
  }
}

export async function loadTerrainData(base: string, onProgress?: (f: number) => void): Promise<TerrainData> {
  const { decodePng16 } = await import('./png16');
  const meta: TerrainMeta = await (await fetch(dataUrl(`${base}terrain.json`))).json();
  const res = await fetch(dataUrl(`${base}heightmap.png`));
  const total = Number(res.headers.get('content-length')) || 4.6e6;
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  const buf = await new Blob(parts as BlobPart[]).arrayBuffer();
  const t0 = performance.now();
  const png = await decodePng16(buf);
  console.info(`[load] heightmap decode ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  const heights = png.data;
  let far: FarGrid | null = null;
  if (meta.far) {
    try {
      const fr = await fetch(dataUrl(`${base}far_height.png`));
      if (fr.ok) {
        const fp = await decodePng16(await fr.arrayBuffer());
        const fs = (meta.far.max - meta.far.min) / 65535;
        const fh = new Float32Array(fp.data.length);
        for (let i = 0; i < fh.length; i++) fh[i] = meta.far.min + fp.data[i] * fs;
        far = { n: fp.width, spacing: meta.far.spacing, half: ((fp.width - 1) * meta.far.spacing) / 2, heights: fh };
      }
    } catch {
      far = null;
    }
  }
  let material: Uint8Array | null = null;
  if (meta.material) {
    try {
      const r = await fetch(dataUrl(`${base}${meta.material.file}`));
      const bmp = await createImageBitmap(await r.blob());
      const n = meta.material.n;
      const c = new OffscreenCanvas(n, n);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0, n, n);
      const d = g.getImageData(0, 0, n, n).data;
      material = new Uint8Array(n * n);
      for (let i = 0; i < material.length; i++) material[i] = d[i * 4];
    } catch {
      material = null;
    }
  }
  // Baked pavement pattern (tools/make_pavement.ts); computed here only as a fallback.
  let pave: Uint8Array | null = null;
  if (material && meta.material?.pave) {
    try {
      const r = await fetch(dataUrl(`${base}${meta.material.pave}`));
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      pave = new Uint8Array(bmp.width * bmp.height);
      for (let i = 0; i < pave.length; i++) pave[i] = d[i * 4];
    } catch {
      pave = null;
    }
  }
  let dtmW: Uint8Array | null = null;
  if (meta.synthRough) {
    try {
      const r = await fetch(dataUrl(`${base}${meta.synthRough.file}`));
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const n = meta.synthRough.n;
      const c = new OffscreenCanvas(n, n);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0, n, n);
      const d = g.getImageData(0, 0, n, n).data;
      dtmW = new Uint8Array(n * n);
      for (let i = 0; i < dtmW.length; i++) dtmW[i] = d[i * 4];
    } catch {
      dtmW = null;
    }
  }
  return new TerrainData(meta, heights, far, material, pave, dtmW);
}
