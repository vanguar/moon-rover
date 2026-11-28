/**
 * The Sun as seen from a site on Mars at a given time - the Mars24 algorithm
 * (Allison & McEwen 2000, NASA GISS), the same as tools/prepare_mars.py.
 */
export interface MarsSun {
  /** Azimuth from north, clockwise (deg), and elevation above the horizon (deg). */
  az: number;
  el: number;
  /** Areocentric solar longitude (deg) and local true solar time (h). */
  ls: number;
  ltst: number;
}

const rad = Math.PI / 180;

export function marsSun(utcMs: number, lat: number, lonE: number): MarsSun {
  const jdUt = utcMs / 86400000 + 2440587.5;
  const jdTt = jdUt + 69.184 / 86400;
  const dt = jdTt - 2451545.0;
  const M = (19.3871 + 0.52402073 * dt) * rad;
  const aFms = 270.3871 + 0.524038496 * dt;
  let pbs = 0;
  for (const [A, tau, phi] of [[0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
    [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.002, 2.4694, 95.528], [0.0018, 32.8493, 49.095]]) {
    pbs += A * Math.cos(((0.985626 * dt) / tau + phi) * rad);
  }
  const nuM = (10.691 + 3.0e-7 * dt) * Math.sin(M) + 0.623 * Math.sin(2 * M) + 0.05 * Math.sin(3 * M)
    + 0.005 * Math.sin(4 * M) + 0.0005 * Math.sin(5 * M) + pbs;
  const lsDeg = (((aFms + nuM) % 360) + 360) % 360;
  const ls = lsDeg * rad;
  const dec = Math.asin(0.42565 * Math.sin(ls)) + 0.25 * rad * Math.sin(ls);
  const eot = 2.861 * Math.sin(2 * ls) - 0.071 * Math.sin(4 * ls) + 0.002 * Math.sin(6 * ls) - nuM;
  const mst = ((24 * ((jdTt - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626)) % 24 + 24) % 24;
  const lmst = (((mst - (360 - lonE) * (24 / 360)) % 24) + 24) % 24;
  const ltst = (((lmst + eot * (24 / 360)) % 24) + 24) % 24;
  const H = (ltst - 12) * 15 * rad;
  const phi = lat * rad;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { az: ((az / rad + 180) % 360 + 360) % 360, el: el / rad, ls: lsDeg, ltst };
}

/** Direction to (az, el) in the game frame (+x east, +y up, -z north). */
export function azElDir(az: number, el: number, out: { set(x: number, y: number, z: number): unknown }): void {
  const a = az * rad, e = el * rad;
  out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}
