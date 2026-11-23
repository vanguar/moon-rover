/**
 * Low-precision ephemerides for the lunar sky (port of tools/ephemeris.py).
 *
 * - Sun: Astronomical Almanac low-precision formula (~0.01°).
 * - Moon (geocentric, to get the Earth's direction from the Moon): AA low-precision
 *   series (~0.3°), includes the optical librations naturally.
 * - Moon orientation: IAU WGCCRE model (α0, δ0, W), periodic terms omitted (~1–3°).
 *
 * Game frame: +x east, +y up, +z south.
 */
type V3 = [number, number, number];
type M3 = [V3, V3, V3];

const D2R = Math.PI / 180;

/** 1971-07-31 13:13 UTC — start of Apollo 15 EVA-1 (Scott and Irwin's first LRV drive). */
export const APOLLO15_EVA1 = Date.UTC(1971, 6, 31, 13, 13, 0);
export const APOLLO15_LANDING = Date.UTC(1971, 6, 30, 22, 16, 29);

const daysJ2000 = (ms: number) => ms / 86400000 + 2440587.5 - 2451545.0;

function eclToEq(lonDeg: number, latDeg: number, epsDeg = 23.4393): V3 {
  const l = lonDeg * D2R, b = latDeg * D2R, e = epsDeg * D2R;
  return [
    Math.cos(b) * Math.cos(l),
    Math.cos(b) * Math.sin(l) * Math.cos(e) - Math.sin(b) * Math.sin(e),
    Math.cos(b) * Math.sin(l) * Math.sin(e) + Math.sin(b) * Math.cos(e),
  ];
}

function sunDirIcrf(d: number): V3 {
  const L = 280.46 + 0.9856474 * d;
  const g = (357.528 + 0.9856003 * d) * D2R;
  return eclToEq(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g), 0);
}

function moonGeocentricKm(d: number): V3 {
  const T = d / 36525;
  const s = (a: number, b: number) => Math.sin((a + b * T) * D2R);
  const c = (a: number, b: number) => Math.cos((a + b * T) * D2R);
  const lam = 218.32 + 481267.881 * T + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36)
    + 0.66 * s(235.7, 890534.22) + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03);
  const beta = 5.13 * s(93.3, 483202.03) + 0.28 * s(228.2, 960400.89) - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21);
  const par = 0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36) + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74);
  const r = 6378.14 / Math.sin(par * D2R);
  const v = eclToEq(lam, beta);
  return [v[0] * r, v[1] * r, v[2] * r];
}

const mul = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as M3;
const rz = (t: number): M3 => [[Math.cos(t), Math.sin(t), 0], [-Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
const rx = (t: number): M3 => [[1, 0, 0], [0, Math.cos(t), Math.sin(t)], [0, -Math.sin(t), Math.cos(t)]];
const apply = (m: M3, v: V3): V3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/** ICRF → Moon body-fixed (mean Earth / polar axis). */
function moonBodyRotation(d: number): M3 {
  const T = d / 36525;
  const a0 = (269.9949 + 0.0031 * T) * D2R;
  const d0 = (66.5392 + 0.013 * T) * D2R;
  const W = (38.3213 + 13.17635815 * d) * D2R;
  return mul(mul(rz(W), rx(Math.PI / 2 - d0)), rz(Math.PI / 2 + a0));
}

export interface LunarSkyState {
  /** Unit vectors in the game frame. */
  sun: V3;
  earth: V3;
  /** ICRF → game frame rotation (rows), to place the stars. */
  icrfToGame: M3;
  /** Earth's phase seen from the Moon: illuminated fraction 0..1. */
  earthPhase: number;
}

export function lunarSky(ms: number, latDeg: number, lonDeg: number): LunarSkyState {
  const d = daysJ2000(ms);
  const R = moonBodyRotation(d);
  const f = latDeg * D2R, l = lonDeg * D2R;
  const up: V3 = [Math.cos(f) * Math.cos(l), Math.cos(f) * Math.sin(l), Math.sin(f)];
  const east: V3 = [-Math.sin(l), Math.cos(l), 0];
  const north: V3 = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
  // Game rows: x = east, y = up, z = -north.
  const enu: M3 = [east, up, [-north[0], -north[1], -north[2]]];
  const icrfToGame = mul(enu, R);
  const s = sunDirIcrf(d);
  const m = moonGeocentricKm(d);
  const mr = Math.hypot(...m);
  const e: V3 = [-m[0] / mr, -m[1] / mr, -m[2] / mr];
  // Phase angle at the Earth between the Sun and the Moon ≈ elongation of Sun from Moon direction (Sun at ∞).
  const cosPsi = s[0] * -e[0] + s[1] * -e[1] + s[2] * -e[2];
  const earthPhase = (1 + cosPsi) / 2; // Full Earth at new Moon (Sun behind the Moon as seen from the Earth).
  return { sun: apply(icrfToGame, s), earth: apply(icrfToGame, e), icrfToGame, earthPhase };
}

export function azEl(v: V3): { az: number; el: number } {
  let az = Math.atan2(v[0], -v[2]) / D2R;
  if (az < 0) az += 360;
  return { az, el: Math.asin(Math.max(-1, Math.min(1, v[1]))) / D2R };
}
