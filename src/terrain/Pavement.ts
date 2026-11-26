import { mulberry32 } from './TerrainData';

/**
 * Fractured bedrock pavement (Mars: the Máaz formation on the Jezero floor).
 *
 * A tileable height pattern, 64 m square at 6.25 cm per texel: polygonal plates
 * 1.2–3 m across (jittered-grid Voronoi), each at its own height (2–7 cm proud of
 * the sand) with a slight tilt and rounded edges, separated by sand-filled cracks
 * ~10 cm wide. Generated deterministically, so the terrain mesh, the physics
 * collider and the shader all see the very same plates.
 *
 * Bytes: height = (v / 255) · RANGE + MIN, metres.
 */
export const PAVE_N = 1024;
export const PAVE_SIZE = 64;
export const PAVE_MIN = -0.03;
export const PAVE_RANGE = 0.11;
/** Pattern rotation, so the plates do not line up with the world axes. */
const ROT = 0.41;
export const PAVE_COS = Math.cos(ROT);
export const PAVE_SIN = Math.sin(ROT);

export function buildPavement(): Uint8Array {
  const N = PAVE_N, px = PAVE_SIZE / N;
  const cell = 2.6; // mean plate spacing, m
  const G = Math.round(PAVE_SIZE / cell); // seeds per side (tileable)
  const rnd = mulberry32(4242);
  const sx = new Float32Array(G * G), sz = new Float32Array(G * G), sh = new Float32Array(G * G);
  const tx = new Float32Array(G * G), tz = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    sx[i] = 0.15 + 0.7 * rnd(); // jitter inside the grid cell, 0..1
    sz[i] = 0.15 + 0.7 * rnd();
    sh[i] = 0.02 + 0.05 * rnd() * rnd();
    tx[i] = (rnd() - 0.5) * 0.03;
    tz[i] = (rnd() - 0.5) * 0.03;
  }
  // Drifted sand: a tileable value-noise level (8 m and 4 m octaves). Plates lower than
  // it are buried, so only parts of the pavement crop out, irregularly.
  const L1 = 8, L2 = 16;
  const lat1 = Float32Array.from({ length: L1 * L1 }, () => rnd());
  const lat2 = Float32Array.from({ length: L2 * L2 }, () => rnd());
  const vn = (lat: Float32Array, L: number, x: number, z: number) => {
    const u = (x / PAVE_SIZE) * L, v = (z / PAVE_SIZE) * L;
    const i = Math.floor(u), j = Math.floor(v);
    let fu = u - i, fv = v - j;
    fu = fu * fu * (3 - 2 * fu);
    fv = fv * fv * (3 - 2 * fv);
    const m = (a: number) => ((a % L) + L) % L;
    const a = lat[m(j) * L + m(i)], b = lat[m(j) * L + m(i + 1)], c = lat[m(j + 1) * L + m(i)], d = lat[m(j + 1) * L + m(i + 1)];
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
  };
  const L3 = 40, L4 = 128;
  const lat3a = Float32Array.from({ length: L3 * L3 }, () => rnd());
  const lat3b = Float32Array.from({ length: L3 * L3 }, () => rnd());
  const lat4 = Float32Array.from({ length: L4 * L4 }, () => rnd());
  // Larger warps (~6.4 m and ~4 m): fracture lines bow and kink over a plate's length,
  // and the plates differ in size and shape (a plain Voronoi net looks like ruled lines).
  const L5 = 10, L6 = 16;
  const lat5a = Float32Array.from({ length: L5 * L5 }, () => rnd());
  const lat5b = Float32Array.from({ length: L5 * L5 }, () => rnd());
  const lat6a = Float32Array.from({ length: L6 * L6 }, () => rnd());
  const lat6b = Float32Array.from({ length: L6 * L6 }, () => rnd());
  const out = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const zz = (j + 0.5) * px;
    for (let i = 0; i < N; i++) {
      const xx = (i + 0.5) * px;
      // Domain warp (~1.6 m wavelength, ±0.35 m): fractures wander instead of running straight.
      const x = xx + (vn(lat3a, L3, xx, zz) - 0.5) * 0.7 + (vn(lat5a, L5, xx, zz) - 0.5) * 1.8 + (vn(lat6a, L6, xx, zz) - 0.5) * 1.2;
      const z = zz + (vn(lat3b, L3, xx, zz) - 0.5) * 0.7 + (vn(lat5b, L5, xx, zz) - 0.5) * 1.8 + (vn(lat6b, L6, xx, zz) - 0.5) * 1.2;
      const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
      let d1 = 1e9, d2 = 1e9, k1 = 0, dx1 = 0, dz1 = 0;
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const cx = gx + a, cz = gz + b;
          const wx = ((cx % G) + G) % G, wz = ((cz % G) + G) % G;
          const k = wz * G + wx;
          // Seed of grid cell (cx, cz); the jitter repeats with the tile, so the pattern wraps.
          const ddx = x - (cx + sx[k]) * cell, ddz = z - (cz + sz[k]) * cell;
          const d = ddx * ddx + ddz * ddz;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            k1 = k;
            dx1 = ddx;
            dz1 = ddz;
          } else if (d < d2) d2 = d;
        }
      }
      // Distance to the cell border ≈ (F2 − F1) / 2 in distance units.
      const edge = (Math.sqrt(d2) - Math.sqrt(d1)) * 0.5;
      // Crack width varies along its length (2–12 cm).
      const cw = 0.02 + 0.1 * vn(lat3b, L3, zz * 1.7, xx * 1.7);
      const crack = Math.min(1, Math.max(0, (edge - cw * 0.5) / (0.04 + cw)));
      const round = crack * crack * (3 - 2 * crack); // rounded plate edges
      // Pitted, weathered rock surface: ±5 mm at 0.5 m.
      const plate = sh[k1] + tx[k1] * dx1 + tz[k1] * dz1 + (vn(lat4, L4, xx, zz) - 0.5) * 0.01;
      const rock = PAVE_MIN + 0.005 + (plate + 0.005 - PAVE_MIN - 0.005) * round;
      const sand = -0.02 + 0.075 * (0.65 * vn(lat1, L1, x, z) + 0.35 * vn(lat2, L2, x, z));
      // Smooth maximum (k = 1 cm): sand banks soften against the plate edges.
      const kk = 0.01, hh = Math.max(kk - Math.abs(rock - sand), 0) / kk;
      const h = Math.max(rock, sand) + hh * hh * kk * 0.25;
      out[j * N + i] = Math.max(0, Math.min(255, Math.round(((h - PAVE_MIN) / PAVE_RANGE) * 255)));
    }
  }
  return out;
}

/** Bilinear pavement height (m) at a world point, the same lookup as the shader. */
export function paveHeight(p: Uint8Array, x: number, z: number): number {
  const u = (x * PAVE_COS - z * PAVE_SIN) / PAVE_SIZE * PAVE_N - 0.5;
  const v = (x * PAVE_SIN + z * PAVE_COS) / PAVE_SIZE * PAVE_N - 0.5;
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const N = PAVE_N, m = N - 1;
  const i0 = i & m, i1 = (i + 1) & m, j0 = j & m, j1 = (j + 1) & m;
  const a = p[j0 * N + i0], b = p[j0 * N + i1], c = p[j1 * N + i0], d = p[j1 * N + i1];
  const val = a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
  return PAVE_MIN + (val / 255) * PAVE_RANGE;
}
