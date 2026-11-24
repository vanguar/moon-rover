import { dataUrl } from '../version';

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

  constructor(meta: TerrainMeta, heights: Uint16Array, far: FarGrid | null = null) {
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
    const count = Math.round(CRATER_COUNT * areaK * (mars ? 0.35 : 1));
    const depthK = mars ? 0.45 : 1;
    this.craters = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
      // Cumulative size-frequency N(>R) ~ R^-2 (Pareto, truncated).
      let R = CRATER_RMIN * Math.pow(1 - rnd(), -0.5);
      if (R > CRATER_RMAX) R = CRATER_RMIN + rnd() * 3;
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

  craterOffset(x: number, z: number): number {
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
  height(x: number, z: number): number {
    if (!this.far) {
      const mx = this.mirrorX(x), mz = this.mirrorZ(z);
      return this.dtmHeight(mx, mz) + this.craterOffset(mx, mz);
    }
    const w = this.dtmWeight(x, z);
    if (w <= 0) return this.farHeight(x, z);
    const near = this.dtmHeight(x, z) + this.craterOffset(x, z);
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
  return new TerrainData(meta, heights, far);
}
