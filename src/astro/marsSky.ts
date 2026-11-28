import * as THREE from 'three';

/**
 * The sky over a site on Mars: the rotation from ICRF to the local game frame
 * (IAU 2015 Mars pole and prime meridian), the planets from the JPL approximate
 * Keplerian elements (Standish, 1800-2050), and Mars's moons.
 *
 * Game frame: +x east, +y up, -z north.
 */

const D2R = Math.PI / 180;
const R_MARS_KM = 3389.5;
const OBLIQUITY = 23.43928 * D2R;

function jd(utcMs: number): number {
  return utcMs / 86400000 + 2440587.5 + 69.184 / 86400;
}

/** Matrix taking ICRF vectors to the game frame at a site (lat, east lon, deg). */
export function icrfToLocal(utcMs: number, lat: number, lonE: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const d = jd(utcMs) - 2451545.0, T = d / 36525;
  const a0 = (317.269202 - 0.10927547 * T) * D2R;
  const d0 = (54.432516 - 0.05827105 * T) * D2R;
  const W = ((176.049863 + 350.891982443297 * d) % 360) * D2R;
  // ICRF -> body: Rz(W) Rx(90 - d0) Rz(90 + a0).
  const rz = (a: number) => new THREE.Matrix4().makeRotationZ(a);
  const rx = (a: number) => new THREE.Matrix4().makeRotationX(a);
  // three's makeRotation* rotate vectors (active); the frame rotation is the inverse.
  const body = rz(-W).multiply(rx(-(Math.PI / 2 - d0))).multiply(rz(-(Math.PI / 2 + a0)));
  // Body -> local ENU -> game (x = E, y = U, z = -N).
  const la = lat * D2R, lo = lonE * D2R;
  const e = new THREE.Vector3(-Math.sin(lo), Math.cos(lo), 0);
  const n = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
  const u = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  const toGame = new THREE.Matrix4().set(e.x, e.y, e.z, 0, u.x, u.y, u.z, 0, -n.x, -n.y, -n.z, 0, 0, 0, 0, 1);
  return out.multiplyMatrices(toGame, body);
}

/** Body-fixed -> game at a site (for the moons, whose orbits are given in the body frame). */
function bodyToLocal(lat: number, lonE: number): THREE.Matrix4 {
  const la = lat * D2R, lo = lonE * D2R;
  const e = new THREE.Vector3(-Math.sin(lo), Math.cos(lo), 0);
  const n = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
  const u = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  return new THREE.Matrix4().set(e.x, e.y, e.z, 0, u.x, u.y, u.z, 0, -n.x, -n.y, -n.z, 0, 0, 0, 0, 1);
}

type Elems = [number, number, number, number, number, number, number, number, number];
// a (au), e, I, L, varpi, Omega (deg) and the rates of L, varpi, Omega (deg/century).
const EMB: Elems = [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0, 35999.37244981, 0.32327364, 0];
const MARS: Elems = [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 19140.30268499, 0.44441088, -0.29257343];

/** Heliocentric position, ICRF (equatorial J2000), au. */
function helio(el: Elems, T: number): THREE.Vector3 {
  const [a, e, I0, L0, w0, O0, Ld, wd, Od] = el;
  const L = L0 + Ld * T, varpi = w0 + wd * T, Om = O0 + Od * T, I = I0 * D2R;
  const w = (varpi - Om) * D2R, O = Om * D2R;
  let M = (((L - varpi) % 360) + 540) % 360 - 180;
  M *= D2R;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = sw * sI * xp + cw * sI * yp;
  // Ecliptic -> equatorial.
  return new THREE.Vector3(x, y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY), y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY));
}

export interface MarsSkyState {
  /** ICRF -> game. */
  icrf: THREE.Matrix4;
  /** Directions in the game frame. */
  sun: THREE.Vector3;
  earth: THREE.Vector3;
  /** Earth's distance (au) and the phase angle Sun-Earth-Mars (rad). */
  earthDist: number;
  earthPhase: number;
  /** Moons: topocentric direction (game), distance (km), lit fraction of the disc seen, eclipsed by Mars. */
  moons: { dir: THREE.Vector3; dist: number; phaseAngle: number; eclipsed: boolean }[];
}

/**
 * Phobos and Deimos: near-circular, near-equatorial orbits (a 9376 / 23463 km,
 * periods 7.653 / 30.312 h). Their mean longitudes at J2000 are approximate: rising and
 * setting directions, speeds, sizes and eclipses are as in reality, the hour of a given
 * rise is not exact.
 */
const MOONS = [
  { a: 9376, P: 0.31891023, L0: 35.06 },
  { a: 23463.2, P: 1.26244, L0: 79.41 },
];

export function marsSkyState(utcMs: number, lat: number, lonE: number): MarsSkyState {
  const d = jd(utcMs) - 2451545.0, T = d / 36525;
  const icrf = icrfToLocal(utcMs, lat, lonE);
  const mars = helio(MARS, T), earthH = helio(EMB, T);
  const sunI = mars.clone().negate().normalize();
  const toEarth = earthH.clone().sub(mars);
  const earthDist = toEarth.length();
  const sun = sunI.clone().applyMatrix4(icrf).normalize();
  const earth = toEarth.clone().normalize().applyMatrix4(icrf).normalize();
  const earthPhase = earthH.clone().negate().normalize().angleTo(mars.clone().sub(earthH).normalize());
  // Moons in the body frame: longitude relative to the prime meridian = mean longitude - W.
  const W = ((176.049863 + 350.891982443297 * d) % 360) * D2R;
  const la = lat * D2R, lo = lonE * D2R;
  const obs = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).multiplyScalar(R_MARS_KM);
  const b2l = bodyToLocal(lat, lonE);
  // Sun in the body frame: invert ICRF->body using the local matrices.
  const sunBody = sun.clone().applyMatrix4(b2l.clone().invert()).normalize();
  const moons = MOONS.map((m) => {
    const lam = (m.L0 + (360 * d) / m.P) * D2R - W;
    const pos = new THREE.Vector3(Math.cos(lam), Math.sin(lam), 0).multiplyScalar(m.a);
    const rel = pos.clone().sub(obs);
    const dist = rel.length();
    const dir = rel.normalize().applyMatrix4(b2l).normalize();
    // Phase angle (Sun - moon - observer) and Mars's shadow (a cylinder of radius R behind Mars).
    const toObs = obs.clone().sub(pos).normalize();
    const phaseAngle = sunBody.angleTo(toObs);
    const along = pos.dot(sunBody);
    const perp = pos.clone().addScaledVector(sunBody, -along).length();
    return { dir, dist, phaseAngle, eclipsed: along < 0 && perp < R_MARS_KM };
  });
  return { icrf, sun, earth, earthDist, earthPhase, moons };
}
