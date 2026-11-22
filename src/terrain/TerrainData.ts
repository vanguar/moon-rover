/**
 * Height field of the playable area: real LROC NAC DTM (2 m/px) + procedural
 * small craters that are below the DTM resolution. Shared by the main thread
 * (physics, rocks, dust, HUD) and the terrain mesh worker.
 *
 * World frame: +x east, -z north, +y up, origin at the centre of the DTM window.
 * Heights are stored relative to the DTM minimum (meta.minHeight).
 * Outside the 4 x 4 km window the data is mirrored, so the world never ends.
 */
export interface TerrainMeta {
  source: string;
  width: number;
  height: number;
  pixelSize: number;
  sizeX: number;
  sizeZ: number;
  minHeight: number;
  maxHeight: number;
  centerLat: number;
  centerLon: number;
  landing: { x: number; z: number };
  sun: { azimuth: number; elevation: number };
  earth?: { azimuth: number; elevation: number };
  orthoHi?: { x: number; z: number; size: number };
  epoch?: string;
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
const CRATER_COUNT = 9000;
const CRATER_RMIN = 1.2;
const CRATER_RMAX = 30;
const HASH_CELL = 16;

export class TerrainData {
  readonly meta: TerrainMeta;
  readonly heights: Float32Array;
  readonly w: number;
  readonly h: number;
  readonly halfX: number;
  readonly halfZ: number;
  /** Crater params packed as [x, z, R, depth, rim] per crater. */
  readonly craters: Float32Array;
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private cellsX: number;

  constructor(meta: TerrainMeta, heights: Float32Array) {
    this.meta = meta;
    this.heights = heights;
    this.w = meta.width;
    this.h = meta.height;
    this.halfX = meta.sizeX / 2;
    this.halfZ = meta.sizeZ / 2;

    const rnd = mulberry32(CRATER_SEED);
    this.craters = new Float32Array(CRATER_COUNT * 5);
    for (let i = 0; i < CRATER_COUNT; i++) {
      // Cumulative size-frequency N(>R) ~ R^-2 (Pareto, truncated).
      let R = CRATER_RMIN * Math.pow(1 - rnd(), -0.5);
      if (R > CRATER_RMAX) R = CRATER_RMIN + rnd() * 3;
      const fresh = rnd();
      const depth = 2 * R * (0.04 + 0.16 * fresh * fresh);
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
    for (let i = 0; i < CRATER_COUNT; i++) forCells(i, (c) => counts[c + 1]++);
    for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[nCells]);
    const fill = new Int32Array(nCells);
    for (let i = 0; i < CRATER_COUNT; i++) {
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
    return this.heights[iz * this.w + ix];
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
      if (q < 1) {
        // Parabolic bowl, slightly flattened floor.
        const b = q * q;
        off += rim + depth * (b * (1.15 - 0.15 * b) - 1);
      } else {
        const t = 2 - q; // 1 at the rim crest -> 0 at 2R
        off += rim * t * t * t;
      }
    }
    return off;
  }

  /** Final ground height at any world position. */
  height(x: number, z: number): number {
    const mx = this.mirrorX(x), mz = this.mirrorZ(z);
    return this.dtmHeight(mx, mz) + this.craterOffset(mx, mz);
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
  const meta: TerrainMeta = await (await fetch(`${base}data/terrain.json`)).json();
  const res = await fetch(`${base}data/heightmap.png`);
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
  const png = await decodePng16(buf);
  const scale = (meta.maxHeight - meta.minHeight) / 65535;
  const heights = new Float32Array(png.data.length);
  for (let i = 0; i < heights.length; i++) heights[i] = png.data[i] * scale;
  return new TerrainData(meta, heights);
}
