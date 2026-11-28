import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The void under a skylight (Pavonis Mons): what is measured and what is reconstructed.
 *
 * Measured (HiRISE DTM, terrain.json "cave"): the opening - its rim height and its
 * outline at 72 bearings - and the top of the debris pile seen through it (28 m below
 * the rim). From the funnel's volume the HiRISE team estimated a cavity at least ~90 m
 * deep and a pile at least ~62 m tall.
 *
 * Reconstructed (nobody has seen inside): a lava tube along the volcano's downslope
 * direction, ~70 m wide and ~80 m tall with a flat floor (lava solidified in the tube),
 * meandering, with lumpy walls (no two cross-sections alike), its roof ~10 m thick at
 * the opening; the pile a mound at the angle of repose (33°) under the opening, its top
 * rounded where the falling roof spread it, spread along the tube between its walls, and
 * strewn with the roof's broken blocks (the biggest rolled furthest, to the toe, as on any
 * talus). Both ends choke with rubble a few hundred metres off.
 *
 * Light, physically: sunlight enters only through the opening - the lit patch is the
 * opening projected along the Sun's rays onto whatever lies below; sky light enters
 * through the same opening (its solid angle as seen from each point); the sunlit
 * patch of the pile lights the rest by bounce, falling off with distance. Beyond that,
 * darkness. Rendered with its own shader (the scene's sun would light it through the
 * roof).
 */
export interface CaveMeta {
  x: number;
  z: number;
  rimY: number;
  pileTopY: number;
  ceilY: number;
  floorY: number;
  holeR: number[];
  axis: [number, number];
  width: number;
  length: number;
  slope: number;
}

const REPOSE = Math.tan(THREE.MathUtils.degToRad(33));

// Exact integer hash value noise (no float-hash stripes), 3D, for the wall relief.
function h3(x: number, y: number, z: number): number {
  let a = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1)) >>> 0;
  a = Math.imul(a ^ (a >>> 15), 0x85ebca6b) >>> 0;
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35) >>> 0;
  return ((a ^ (a >>> 16)) >>> 0) / 4294967295;
}
function vn3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => h3(ix + dx, iy + dy, iz + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}
function fbm(x: number, y: number, z: number): number {
  return vn3(x, y, z) * 0.55 + vn3(x * 2.13 + 7.1, y * 2.13, z * 2.13) * 0.3 + vn3(x * 4.7, y * 4.7 + 3.3, z * 4.7) * 0.15;
}

export class Cave {
  readonly group = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  private ax: number;
  private az: number;
  private meanR: number;
  private maxR: number;
  /** Roof blocks on the pile: tube-local position, top height and footprint radius. */
  private blocks: { x: number; z: number; top: number; r: number }[] = [];
  /** Roof blocks (big) and rubble (small): drawn only when the camera is near or inside. */
  private blockGroup!: THREE.Group;
  private rubbleGroup!: THREE.Group;

  constructor(private c: CaveMeta) {
    // The tube's height is fixed by the measurements (floor ~90 m under the rim); its width
    // is not: lava tubes are wider than tall (Earth's ~1.5×, Mars's low gravity favours
    // wider ones), so the arch is a low rounded vault, never a pointed one.
    this.c = c = { ...c, width: Math.max(c.width, 1.4 * (c.ceilY - c.floorY)) };
    this.ax = c.axis[0];
    this.az = c.axis[1];
    this.meanR = c.holeR.reduce((a, b) => a + b, 0) / c.holeR.length;
    this.maxR = Math.max(...c.holeR);
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Color(1, 1, 1) },
      uSky: { value: new THREE.Color(0.3, 0.2, 0.12) },
      uHole: { value: new THREE.Vector4(c.x, c.z, c.rimY, c.ceilY) },
      uHoleR: { value: c.holeR },
      uMeanR: { value: this.meanR },
      uPileTop: { value: c.pileTopY },
      // Where the sunbeam through the opening lands (the source of the bounce light).
      uSpot: { value: new THREE.Vector3(c.x, c.pileTopY, c.z) },
    };
    this.group.add(this.mesh(this.tubeGeometry(), 0.085, 0));
    this.group.add(this.mesh(this.shaftGeometry(), 0.09, 1));
    this.group.add(this.mesh(this.pileGeometry(), 0.2, 2));
    this.group.add(this.blockMesh());
    this.blockGroup.add(this.lavacicles(), this.boneFormation());
  }

  /** Where the bone-like formation lies (world x, z): a site for the journal. */
  bonesSite(): { x: number; z: number } {
    const [x, z] = this.world(this.bonesU, this.bonesV());
    return { x, z };
  }
  private bonesU = 95;
  private bonesV(): number {
    return -(this.halfWidth(this.bonesU, this.floorTop(this.bonesU, 0) + 0.5) - 6);
  }

  /** Lavacicles: drips of lava frozen on the vault (5-40 cm), in clusters. */
  private lavacicles(): THREE.InstancedMesh {
    const g = new THREE.ConeGeometry(1, 1, 6, 1, true);
    // Base on the vault (y 0), tip hanging down (y -1).
    g.rotateX(Math.PI);
    g.translate(0, -0.5, 0);
    const list: THREE.Matrix4[] = [];
    let st = 777;
    const rnd = () => ((st = Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
    for (let c = 0; c < 260; c++) {
      const u0 = (rnd() * 2 - 1) * (this.c.length / 2 - 90), v0 = (rnd() * 2 - 1) * 0.55;
      if (Math.abs(u0) < this.maxR + 8) continue;
      const n = 5 + Math.floor(rnd() * 25);
      for (let i = 0; i < n; i++) {
        const u = u0 + (rnd() - 0.5) * 6, sc = this.section(u);
        const v = (v0 + (rnd() - 0.5) * 0.1) * sc.a;
        const y = this.archY(u, v) - 0.2;
        const len = 0.05 + 0.35 * Math.pow(rnd(), 2), r = 0.015 + 0.03 * rnd();
        const [x, z] = this.world(u, v);
        q.setFromAxisAngle(Y, rnd() * 6.28);
        m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(r, len, r));
        list.push(m.clone());
      }
    }
    const im = new THREE.InstancedMesh(g, this.material(0.09, 3), list.length);
    list.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.frustumCulled = false;
    return im;
  }

  /**
   * The mystery deep in the tube: broken basalt half-buried in the floor - a chain of
   * knobbly pieces with a row of curved slabs on one side and a long block at the end. In
   * the dim light it reads as the skeleton of some ancient animal. It is rock: the eye
   * finds familiar shapes (pareidolia), as with Curiosity's "bone" rock of sol 719.
   */
  private boneFormation(): THREE.Group {
    const grp = new THREE.Group();
    let st = 719;
    const rnd = () => ((st = Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
    const u0 = this.bonesU, v0 = this.bonesV();
    const segs: THREE.Matrix4[] = [], ribs: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    // The spine: a gently curving chain, tapering to a tail.
    const NS = 22;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < NS; i++) {
      // Uneven spacing and a wandering line (pieces settled and shifted).
      const t = (i + (rnd() - 0.5) * 0.6) / (NS - 1);
      const u = u0 - 6 + t * 12, v = v0 + 1.6 * Math.sin(t * 2.6 + 0.4) + (rnd() - 0.5) * 0.35;
      const [x, z] = this.world(u, v);
      pts.push(new THREE.Vector3(x, this.floorTop(u, v), z));
    }
    for (let i = 0; i < NS; i++) {
      const t = i / (NS - 1), p = pts[i], nx = pts[Math.min(NS - 1, i + 1)], pv = pts[Math.max(0, i - 1)];
      const dir = nx.clone().sub(pv).setY(0).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      const s = (t < 0.65 ? 0.45 : 0.45 * (1 - (t - 0.65) / 0.35 * 0.75)) * (0.6 + 0.7 * rnd());
      // Some pieces are gone (buried or never there), some rolled off to the side.
      const gone = rnd() < 0.18, rolled = !gone && rnd() < 0.15;
      if (!gone) {
        const off = rolled ? new THREE.Vector3((rnd() - 0.5) * 2.5, 0, (rnd() - 0.5) * 2.5) : new THREE.Vector3();
        q.setFromEuler(new THREE.Euler((rnd() - 0.5) * (rolled ? 2.0 : 0.6), yaw + (rnd() - 0.5) * 0.8, (rnd() - 0.5) * (rolled ? 2.0 : 0.6)));
        // Sunk to different depths in the drifted sand.
        m.compose(new THREE.Vector3(p.x + off.x, p.y + s * (rnd() * 0.35 - 0.15), p.z + off.z), q, new THREE.Vector3(s * (0.9 + 0.4 * rnd()), s * (0.6 + 0.4 * rnd()), s * (0.6 + 0.4 * rnd())));
        segs.push(m.clone());
      }
      // Ribs: curved slabs off the front two thirds, on the side away from the wall.
      if (t > 0.12 && t < 0.62 && i % 2 === 0 && rnd() > 0.15) {
        const len = 3.0 * (1 - Math.abs(t - 0.35) * 1.4) * (0.85 + 0.3 * rnd());
        const side = new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(Math.sign(-v0) || 1);
        // Some ribs broke: only their base stands, the rest lies flat beside it.
        const broken = rnd() < 0.35 ? 3 + Math.floor(rnd() * 3) : 99;
        const sag = (rnd() - 0.5) * 0.5;
        for (let k = 0; k < 8; k++) {
          const a = (k + 0.5) / 8;
          if (k >= broken) {
            const off = side.clone().multiplyScalar(a * len * 0.9).add(new THREE.Vector3(dir.x, 0, dir.z).multiplyScalar((k - broken) * 0.25 + 0.3));
            q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, Math.atan2(side.x, side.z) + (rnd() - 0.5) * 0.6, 0));
            m.compose(new THREE.Vector3(p.x + off.x, p.y + 0.02, p.z + off.z), q, new THREE.Vector3(0.09, 0.08, (len / 8) * 1.25));
            ribs.push(m.clone());
            continue;
          }
          const off = side.clone().multiplyScalar(a * len);
          const lift = Math.sin(a * Math.PI) * len * (0.4 + sag * 0.3) - 0.1;
          // Continuous arc: each piece tilted along the curve and overlapping the next.
          const slope = Math.cos(a * Math.PI) * len * (0.4 + sag * 0.3) * Math.PI / len;
          q.setFromEuler(new THREE.Euler(-Math.atan(slope), Math.atan2(side.x, side.z), 0, 'YXZ'));
          const th = 0.08 + 0.05 * (1 - a);
          m.compose(new THREE.Vector3(p.x + off.x, p.y + lift, p.z + off.z), q, new THREE.Vector3(th, th * 1.1, (len / 8) * 0.75 * Math.sqrt(1 + slope * slope)));
          ribs.push(m.clone());
        }
      }
    }
    // The "skull": a long block with a lower slab, at the head of the chain.
    const h = pts[0], dirH = pts[0].clone().sub(pts[2]).setY(0).normalize();
    q.setFromEuler(new THREE.Euler(0.1, Math.atan2(dirH.x, dirH.z), 0.05));
    m.compose(h.clone().addScaledVector(dirH, 1.0).setY(h.y + 0.3), q, new THREE.Vector3(0.55, 0.45, 0.95));
    segs.push(m.clone());
    m.compose(h.clone().addScaledVector(dirH, 1.3).setY(h.y + 0.05), q, new THREE.Vector3(0.36, 0.15, 0.8));
    segs.push(m.clone());
    for (const [list, g] of [[segs, this.blockGeometry(31, 2)], [ribs, this.blockGeometry(37, 1)]] as const) {
      const im = new THREE.InstancedMesh(g, this.material(0.13, 3), list.length);
      list.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.frustumCulled = false;
      grp.add(im);
    }
    return grp;
  }

  /** Lateral meander of the tube's centre line at distance u along it (0 under the opening). */
  private lat(u: number): number {
    const f = (t: number) => 12 * Math.sin(t / 85 + 1.1) + 5 * Math.sin(t / 31 + 0.4);
    return f(u) - f(0);
  }
  private floorAt0(u: number): number {
    return this.c.floorY - this.c.slope * u;
  }
  /**
   * Cross-section at u: an arch (half-ellipse, semi-axes width/2 and b, centred at yc)
   * cut by the flat floor of solidified lava, which is ~85 % of the tube's width.
   */
  private section(u: number): { yc: number; b: number; a: number } {
    const fl = this.floorAt0(u), H = this.ceilAt0(u) - fl;
    return { yc: fl + 0.35 * H, b: 0.65 * H, a: this.c.width / 2 };
  }
  /** Height of the plain vault over (u, v). */
  private archY(u: number, v: number): number {
    const sc = this.section(u), k = Math.min(1, Math.abs(v) / sc.a);
    return sc.yc + sc.b * Math.sqrt(1 - k * k);
  }
  /** Half-width of the open tube at height y (0 above the arch). */
  private halfWidth(u: number, y: number): number {
    const sc = this.section(u), k = (y - sc.yc) / sc.b;
    return Math.abs(k) >= 1 ? 0 : sc.a * Math.sqrt(1 - k * k);
  }
  /** 0 in the open tube, 1 at its ends, where breakdown rubble chokes it. */
  private choke(u: number): number {
    return 1 - THREE.MathUtils.smoothstep(this.c.length / 2 - Math.abs(u), 0, 90);
  }
  /** The tube's floor: solidified lava, rising into a rubble ramp toward the chokes. */
  private floorTop(u: number, v: number): number {
    const H = this.ceilAt0(u) - this.floorAt0(u);
    const ch = this.choke(u);
    // Solidified lava: broad swells and low pressure ridges, rising a little toward the walls.
    const edge = Math.abs(v) / (this.c.width / 2);
    return this.floorAt0(u) + 1.6 * (fbm(u / 22, v / 22, 2.9) - 0.5) + 0.6 * (fbm(u / 6, v / 6, 1.3) - 0.5) + 2.5 * edge ** 4 * (0.6 + 0.8 * fbm(u / 11, 3.3, 0.4)) + ch * ch * H * 1.15 * (0.85 + 0.3 * fbm(u / 14, v / 14, 6.1));
  }
  private ceilAt0(u: number): number {
    return this.c.ceilY - this.c.slope * u;
  }
  /** Tube-local coordinates (u along, v across) of a world point. */
  private uv(x: number, z: number): [number, number] {
    const dx = x - this.c.x, dz = z - this.c.z;
    const u = dx * this.ax + dz * this.az;
    const v = dx * -this.az + dz * this.ax - this.lat(u);
    return [u, v];
  }
  private world(u: number, v: number): [number, number] {
    const l = this.lat(u) + v;
    return [this.c.x + this.ax * u - this.az * l, this.c.z + this.az * u + this.ax * l];
  }
  /** Height of the debris pile (or the floor) at tube-local (u, v). */
  private pileAt(u: number, v: number): number {
    // Rounded top (radius ~ the opening: the roof came down over that width), the 33°
    // flanks beyond; hummocks of slumped debris, lumps and cobbles everywhere, the top too.
    const R0 = this.meanR * 0.8;
    const d = Math.hypot(u, v);
    const cone = REPOSE * (Math.sqrt(d * d + R0 * R0) - R0);
    const lump = (fbm(u / 14, v / 14, 1.9) - 0.5) * 4.0 + (fbm(u / 6, v / 6, 3.7) - 0.5) * 1.8
      + (fbm(u / 1.8, v / 1.8, 9.1) - 0.5) * 0.7;
    return Math.max(this.floorTop(u, v) + 0.3 + (fbm(u / 3, v / 3, 7.7) - 0.5) * 0.4, this.c.pileTopY - cone + lump);
  }
  /** The pile or a block on it. */
  private groundTop(u: number, v: number): number {
    let y = this.pileAt(u, v);
    for (const b of this.blocks) {
      const dx = u - b.x, dz = v - b.z;
      if (dx * dx + dz * dz < b.r * b.r) y = Math.max(y, b.top - (b.top - y) * ((dx * dx + dz * dz) / (b.r * b.r)));
    }
    return y;
  }

  /** Inside the tube or the shaft (below the rim of the opening)? */
  contains(p: THREE.Vector3): boolean {
    const [u, v] = this.uv(p.x, p.z);
    if (p.y > this.c.rimY + 0.5) return false;
    if (Math.abs(u) < this.c.length / 2 - 40 && Math.abs(v) < this.halfWidth(u, Math.max(p.y, this.floorAt0(u) + 0.5)) + 1 && p.y < this.ceilAt0(u) + 1) return true;
    return Math.hypot(p.x - this.c.x, p.z - this.c.z) < this.meanR && p.y < this.c.rimY;
  }
  /** Ground under a point inside the cave (pile or floor), or null if not in it. */
  groundAt(x: number, z: number, y: number): number | null {
    const p = new THREE.Vector3(x, y, z);
    if (!this.contains(p)) return null;
    const [u, v] = this.uv(x, z);
    return this.groundTop(u, v);
  }
  /** Ceiling over a point in the tube (Infinity under the opening). */
  ceilingAt(x: number, z: number): number {
    // Open under the whole opening (its real outline, widened downward like the throat),
    // less the rotor's reach - not just a circle round its centre.
    const dx = x - this.c.x, dz = z - this.c.z;
    if (Math.hypot(dx, dz) < this.outlineR(dx, dz) - 1.3) return Infinity;
    const [u, v] = this.uv(x, z);
    // The arch comes down toward the walls.
    const sc = this.section(u), k = Math.min(1, Math.abs(v) / sc.a);
    return sc.yc + sc.b * Math.sqrt(1 - k * k) * 0.92;
  }

  /**
   * The chase camera in the cave: inside, between ground and vault; when the helicopter
   * is up in the throat, the camera slides in under the opening (looking up its axis)
   * instead of being pressed against the rock.
   */
  clampCamera(cp: THREE.Vector3, target: THREE.Vector3): void {
    const dx = cp.x - this.c.x, dz = cp.z - this.c.z, d = Math.hypot(dx, dz);
    const lim = this.outlineR(dx, dz) - 1.5;
    const ceilHere = this.ceilingAt(cp.x, cp.z) - 0.8;
    if (cp.y > ceilHere && target.y > ceilHere - 1 && d > lim) {
      const k = lim / d;
      cp.x = this.c.x + dx * k;
      cp.z = this.c.z + dz * k;
    } else if (cp.y > ceilHere) cp.y = ceilHere;
    const fl = (this.groundAt(cp.x, cp.z, Math.min(cp.y, target.y)) ?? target.y - 2) + 0.5;
    if (cp.y < fl) cp.y = fl;
  }

  /** How far below the rim of the opening a point is (m, 0 above it). */
  depth(p: THREE.Vector3): number {
    return this.contains(p) ? Math.max(0, this.c.rimY - p.y) : 0;
  }

  /** Radius of the opening's outline toward a bearing from its centre. */
  private outlineR(dx: number, dz: number): number {
    let a = Math.atan2(dz, dx);
    if (a < 0) a += Math.PI * 2;
    const f = (a / (Math.PI * 2)) * 72, i0 = Math.floor(f) % 72, i1 = (i0 + 1) % 72;
    return this.c.holeR[i0] + (this.c.holeR[i1] - this.c.holeR[i0]) * (f - Math.floor(f));
  }

  /**
   * Light reaching a point in the cave, relative to the open surface: the Sun (1 if its
   * ray passes through the opening, else 0) and the sky (the opening's solid angle /
   * π, plus a little bounce off the sunlit pile). Outside the cave: 1, 1.
   */
  lightAt(p: THREE.Vector3, sun: THREE.Vector3): { sun: number; sky: number } {
    if (!this.contains(p) || p.y > this.c.rimY) return { sun: 1, sky: 1 };
    return this.lightIn(p, sun);
  }
  /** The same for a point known to be in the cave or on its surfaces (walls, vault). */
  private lightIn(p: THREE.Vector3, sun: THREE.Vector3): { sun: number; sky: number } {
    let s = 0;
    if (sun.y > 0.03) {
      const t = (this.c.rimY - p.y) / sun.y;
      const qx = p.x + sun.x * t - this.c.x, qz = p.z + sun.z * t - this.c.z;
      s = Math.hypot(qx, qz) < this.outlineR(qx, qz) ? 1 : 0;
    }
    const dx = this.c.x - p.x, dy = this.c.rimY - p.y, dz = this.c.z - p.z;
    const D2 = dx * dx + dy * dy + dz * dz, A = Math.PI * this.meanR * this.meanR;
    const omega = (A * Math.max(dy, 0)) / Math.sqrt(D2) / (D2 + A);
    return { sun: s, sky: Math.min(1, omega / Math.PI + 0.02 * Math.max(sun.y, 0)) };
  }

  /**
   * The camera's auto-exposure: 5 × 4 rays through the frame, each followed to what it
   * meets (pile, floor, wall, the throat or the sky through the opening), the light
   * there estimated as the shader does; returns the log-average brightness relative to
   * sunlit open ground (1). Like a real camera's metering, centre-weighted.
   */
  meter(cam: THREE.PerspectiveCamera, sun: THREE.Vector3): number {
    const dir = new THREE.Vector3(), p = new THREE.Vector3();
    const spot = this.uniforms.uSpot.value as THREE.Vector3;
    const A = Math.PI * this.meanR * this.meanR;
    const flux = (A * Math.max(sun.y, 0) * 0.2) / Math.PI;
    const day = Math.max(sun.y, 0.05) + 0.35;
    let sumW = 0, sumL = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 5; i++) {
        const sx = ((i + 0.5) / 5) * 2 - 1, sy = ((j + 0.5) / 4) * 2 - 1;
        dir.set(sx, sy, 0.5).unproject(cam).sub(cam.position).normalize();
        let L = 0, t = 0.3;
        for (let k = 0; k < 160; k++) {
          p.copy(cam.position).addScaledVector(dir, t);
          if (p.y > this.c.rimY + 1) { L = 0.35; break; } // sky through the opening
          const [u, v] = this.uv(p.x, p.z);
          const inShaft = Math.hypot(p.x - this.c.x, p.z - this.c.z) < this.meanR * 1.05;
          const sc = this.section(u);
          const wall = (v / sc.a) ** 2 + ((p.y - sc.yc) / sc.b) ** 2 > 1 && !(inShaft && p.y > sc.yc);
          const ground = p.y <= this.pileAt(u, v);
          if (wall || ground || Math.abs(u) > this.c.length / 2 - 2) {
            const lt = this.lightIn(p, sun);
            const S2 = p.distanceToSquared(spot) + 40;
            const bounce = (flux / S2) * 1.5 * 0.6;
            const multi = 0.011 * Math.max(sun.y, 0) * Math.exp(-Math.abs(u) / 80);
            const E = lt.sun * Math.max(sun.y, 0) * (ground ? 1 : 0.5) + lt.sky * 0.35 + bounce + multi;
            L = (E / day) * (ground ? 0.2 : 0.09) / 0.2;
            break;
          }
          t += 0.4 + t * 0.04;
          if (t > 400) break;
        }
        const w = 1.5 - 0.5 * Math.hypot(sx, sy);
        sumW += w;
        sumL += w * Math.log(Math.max(L, 1e-5));
      }
    }
    return Math.exp(sumL / sumW);
  }

  setLight(sun: THREE.Vector3, sunE: THREE.Color, sky: THREE.Color): void {
    const u0 = this.uniforms.uSun.value as THREE.Vector3;
    if (u0.distanceToSquared(sun) > 1e-6) this.findSpot(sun);
    u0.copy(sun);
    (this.uniforms.uSunE.value as THREE.Color).copy(sunE);
    (this.uniforms.uSky.value as THREE.Color).copy(sky);
  }

  /** March the ray through the opening's centre down to the pile, floor or wall. */
  private findSpot(sun: THREE.Vector3): void {
    const out = this.uniforms.uSpot.value as THREE.Vector3;
    if (sun.y < 0.03) return;
    for (let t = 0; t < 400; t += 0.5) {
      const y = this.c.rimY - sun.y * t, x = this.c.x - sun.x * t, z = this.c.z - sun.z * t;
      const [u, v] = this.uv(x, z);
      if (y <= this.pileAt(u, v) || Math.abs(v) > this.halfWidth(u, y)) {
        out.set(x, y, z);
        return;
      }
    }
  }

  /** Wall radius factor of the tube at u and section angle th (what the mesh is built with). */
  private wallK(u: number, th: number): number {
    const a0 = this.c.width / 2, L = this.c.length;
    const cs = Math.cos(th), sn = Math.sin(th);
    let n = 1 + 0.16 * (fbm(cs * a0 / 26 + 11, sn * a0 / 26, u / 26) - 0.5) * 2 + 0.06 * (fbm(cs * a0 / 7, sn * a0 / 7 + 5, u / 7) - 0.5) * 2;
    const [wx, wz] = this.world(u, a0 * cs);
    const near = 1 - THREE.MathUtils.smoothstep(Math.hypot(wx - this.c.x, wz - this.c.z), this.maxR + 6, this.maxR + 30);
    if (sn > 0) n += (1 - n) * near;
    return n * (0.45 + 0.55 * THREE.MathUtils.smoothstep(L / 2 - Math.abs(u), 0, 70));
  }

  /**
   * Keep a flying body (radius R) inside the rock: tube walls and vault (the same lumpy
   * surface that is drawn) and the opening's throat. Returns the speed it hit with
   * (into the rock, m/s) and the clearance to the nearest rock (m).
   */
  collide(p: THREE.Vector3, vel: THREE.Vector3, R: number): { impact: number; clearance: number } {
    let impact = 0, clearance = Infinity;
    const dx = p.x - this.c.x, dz = p.z - this.c.z, dc = Math.hypot(dx, dz);
    const lim = this.outlineR(dx, dz) - R;
    // In the throat (above the tube's roof line): its walls.
    if (p.y > this.c.ceilY - 2 && p.y < this.c.rimY && dc < this.maxR + 8) {
      clearance = lim - dc;
      if (dc > lim && dc > 1e-3) {
        const vr = (vel.x * dx + vel.z * dz) / dc;
        if (vr > 0) { impact = vr; vel.x -= (vr * dx) / dc; vel.z -= (vr * dz) / dc; }
        p.x = this.c.x + (dx / dc) * lim;
        p.z = this.c.z + (dz / dc) * lim;
      }
      return { impact, clearance };
    }
    const [u, v] = this.uv(p.x, p.z);
    if (Math.abs(u) > this.c.length / 2 - 2) return { impact, clearance };
    // Under the opening the roof is open.
    if (dc < lim && p.y > this.section(u).yc) return { impact, clearance: lim - dc };
    const sc = this.section(u), a0 = this.c.width / 2;
    const ny = (p.y - sc.yc) / sc.b, nv = v / a0;
    const rr = Math.hypot(nv, ny);
    const th = Math.atan2(ny, nv);
    const k = this.wallK(u, th);
    const scale = Math.min(a0, sc.b);
    clearance = (k - rr) * scale;
    const kIn = k - R / scale;
    if (rr > kIn && rr > 1e-4) {
      // Outward direction in metres (v across the tube, y up), as a world vector.
      const ov = (nv / rr) / a0, oy = (ny / rr) / sc.b, ol = Math.hypot(ov, oy);
      const sideX = -this.az, sideZ = this.ax;
      const out = new THREE.Vector3(sideX * (ov / ol), oy / ol, sideZ * (ov / ol));
      const vo = vel.dot(out);
      if (vo > 0) { impact = vo; vel.addScaledVector(out, -vo); }
      const f = kIn / rr;
      const vNew = v * f, yNew = sc.yc + (p.y - sc.yc) * f;
      const [x, z] = this.world(u, vNew);
      p.set(x, yNew, z);
    }
    return { impact, clearance };
  }

  private tubeGeometry(): THREE.BufferGeometry {
    const U = 240, T = 120, L = this.c.length, a0 = this.c.width / 2;
    const pos: number[] = [];
    for (let i = 0; i <= U; i++) {
      const u = -L / 2 + (L * i) / U;
      // Rubble chokes at both ends: the tube narrows and its floor rises to the roof.
      const ce = this.ceilAt0(u);
      const { yc, b: b0 } = this.section(u);
      for (let k = 0; k < T; k++) {
        const th = (2 * Math.PI * k) / T;
        const cs = Math.cos(th), sn = Math.sin(th);
        // Isotropic: the same scale round the tube as along it (in metres of wall), or the
        // lumps stretch into vertical streaks.
        // (Around the skylight the vault is the plain arch, so the throat meets it exactly.)
        // The end ring closes to a point above the roof, behind the rubble ramp: no gap.
        const k2 = i === 0 || i === U ? 0 : this.wallK(u, th);
        const v = a0 * cs * k2;
        // Flat floor: the lower part of the section is the solidified lava surface.
        let y = yc + b0 * sn * k2;
        // The rubble ramp: at the very end it reaches over the roof - closed, no gap.
        const floorY = i === 0 || i === U ? ce + 5 : this.floorTop(u, v);
        if (y < floorY) y = floorY;
        const [x, z] = this.world(u, v);
        pos.push(x, y, z);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < U; i++) {
      for (let k = 0; k < T; k++) {
        const a = i * T + k, b = i * T + ((k + 1) % T), c = (i + 1) * T + k, d = (i + 1) * T + ((k + 1) % T);
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** The opening's throat through the roof, from just below the ceiling to the rim. */
  private shaftGeometry(): THREE.BufferGeometry {
    const K = this.c.holeR.length, V = 24;
    // Down to below the cut in the tube's ceiling (overlapping it): no gap to see the sky through.
    const y1 = this.c.rimY + 0.3;
    const pos: number[] = [];
    for (let j = 0; j <= V; j++) {
      for (let k = 0; k < K; k++) {
        const a = (2 * Math.PI * k) / K;
        // The bottom edge is ragged (broken roof), 8-12 m below the ceiling line.
        // The bottom edge ends on the vault (a ragged lip 1-2.5 m below it), not hanging into the tube.
        const bx = this.c.x + Math.cos(a) * this.c.holeR[k] * 1.1, bz = this.c.z + Math.sin(a) * this.c.holeR[k] * 1.1;
        const [bu, bv] = this.uv(bx, bz);
        const y0 = this.archY(bu, bv) - 1 - 1.5 * fbm(Math.cos(a) * 2.5 + 3, Math.sin(a) * 2.5, 0.7);
        const y = y0 + ((y1 - y0) * j) / V;
        // Rough rock: the throat widens downward (the roof broke back), with ledges where
        // stronger flow layers held - each layer stepping in or out by its own amount.
        const ledge = (fbm(Math.cos(a) * 1.5, Math.sin(a) * 1.5, y / 2.2) - 0.5) * 3.2;
        let r = this.c.holeR[k] * (1 + 0.1 * (1 - j / V)) + (fbm(Math.cos(a) * 3, Math.sin(a) * 3, y / 3) - 0.5) * 1.6 + ledge * (1 - Math.pow(j / V, 4));
        // The top ring flares out to the circle the terrain is cut away within (TerrainRenderer
        // uHole): it tucks under the ground, leaving no sliver of sky between them.
        if (j === V) r = this.maxR + 1.3;
        pos.push(this.c.x + Math.cos(a) * r, y, this.c.z + Math.sin(a) * r);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < V; j++) {
      for (let k = 0; k < K; k++) {
        const a = j * K + k, b = j * K + ((k + 1) % K), c = (j + 1) * K + k, d = (j + 1) * K + ((k + 1) % K);
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private pileGeometry(): THREE.BufferGeometry {
    // ~0.6 m mesh: fine enough that the lumps rocks are placed on are the lumps drawn.
    const Nu = 400, Nv = 150, U = 120, Vh = this.c.width * 0.47;
    const pos: number[] = [];
    for (let i = 0; i <= Nu; i++) {
      const u = -U + (2 * U * i) / Nu;
      for (let j = 0; j <= Nv; j++) {
        const v = -Vh + (2 * Vh * j) / Nv;
        const [x, z] = this.world(u, v);
        pos.push(x, this.pileAt(u, v), z);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < Nu; i++) {
      for (let j = 0; j < Nv; j++) {
        const a = i * (Nv + 1) + j, b = a + 1, c = a + Nv + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * A broken block of the roof: basalt, angular - an irregular body cut by a few
   * fracture planes (flat faces, sharp-ish edges), no two alike.
   */
  private blockGeometry(seed: number, detail = 3): THREE.BufferGeometry {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g = mergeVertices(g);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    let st = seed * 9781 + 1;
    const rnd = () => ((st = Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
    const planes: [THREE.Vector3, number][] = [];
    // A roof slab: two near-parallel bedding faces (top and bottom of a lava layer),
    // then joints and fresh fractures all round - flat faces, edges, corners.
    const tilt = new THREE.Vector3(rnd() * 0.3 - 0.15, 1, rnd() * 0.3 - 0.15).normalize();
    planes.push([tilt, 0.35 + rnd() * 0.25], [tilt.clone().negate(), 0.35 + rnd() * 0.25]);
    for (let k = 0; k < 7 + Math.floor(rnd() * 5); k++) {
      const n = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.6, rnd() * 2 - 1).normalize();
      planes.push([n, 0.45 + rnd() * 0.4]);
    }
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      v.multiplyScalar(1 + (fbm(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6) - 0.5) * 0.2 + (fbm(v.x * 5 + seed, v.y * 5, v.z * 5) - 0.5) * 0.06);
      for (const [n, d] of planes) {
        const k = v.dot(n);
        if (k > d) v.addScaledVector(n, (d - k) * (0.96 + 0.04 * fbm(v.x * 7, v.y * 7 + seed, v.z * 7)));
      }
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  }

  private relief = 0;
  /** Load watchdog level (0..3): pebbles go at 2 and above. */
  setRelief(r: number): void {
    this.relief = r;
  }
  /** Per frame: blocks only within sight of the opening, rubble only close to it. */
  updateVisibility(cam: THREE.Vector3): void {
    const d = Math.hypot(cam.x - this.c.x, cam.z - this.c.z);
    const inside = this.contains(cam);
    this.blockGroup.visible = inside || d < 250;
    this.rubbleGroup.visible = this.relief < 2 && (inside || (d < 60 && cam.y < this.c.rimY + 60));
  }

  /** Orientation of a stone lying on the pile at (u, v): up along the ground's normal, turned and tipped a little. */
  private slopeQ(u: number, v: number, yaw: number, tip: number, out: THREE.Quaternion): THREE.Quaternion {
    const e = 0.6;
    const dhu = (this.pileAt(u + e, v) - this.pileAt(u - e, v)) / (2 * e);
    const dhv = (this.pileAt(u, v + e) - this.pileAt(u, v - e)) / (2 * e);
    // Tube-local gradient to world: u along the axis, v across (the meander is gentle).
    const gx = dhu * this.ax - dhv * this.az, gz = dhu * this.az + dhv * this.ax;
    const n = new THREE.Vector3(-gx, 1, -gz).normalize();
    const Y = new THREE.Vector3(0, 1, 0);
    return out.setFromUnitVectors(Y, n)
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, yaw))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tip));
  }

  private blockMesh(): THREE.Group {
    const grp = new THREE.Group();
    this.blockGroup = new THREE.Group();
    this.rubbleGroup = new THREE.Group();
    grp.add(this.blockGroup, this.rubbleGroup);
    const VAR = 6, N = 3200;
    let st = 4242;
    const rnd = () => ((st = Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
    const lists: THREE.Matrix4[][] = Array.from({ length: VAR }, () => []);
    const Vh = this.c.width * 0.44, m = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < N; i++) {
      // Two thirds on the pile, the rest on the two rubble chokes.
      const onPile = i % 3 !== 0;
      const L2 = this.c.length / 2;
      const u = onPile ? (rnd() * 2 - 1) * 105 : (rnd() < 0.5 ? -1 : 1) * (L2 - 4 - rnd() * 90), v = (rnd() * 2 - 1) * Vh;
      const d = Math.hypot(u, v);
      const toe = onPile ? THREE.MathUtils.clamp(d / 80, 0, 1) : 0.6 + 0.4 * this.choke(u);
      // Fewer blocks far out on the floor; more and bigger ones down the flanks and at the toe.
      if (onPile && rnd() > 0.35 + 0.65 * (1 - THREE.MathUtils.smoothstep(d, 70, 105))) continue;
      if (!onPile && rnd() > this.choke(u)) continue;
      let r = 0.15 * Math.pow(1 - rnd() * 0.995, -1 / 1.6) * (0.6 + 0.9 * toe);
      r = Math.min(r, 4);
      const sx = r * (0.9 + rnd() * 0.6), sy = r * (0.6 + rnd() * 0.5), sz = r * (0.8 + rnd() * 0.6);
      const ground = this.pileAt(u, v);
      // Only on the floor or the pile inside the tube, never through its wall.
      if (Math.abs(v) > this.halfWidth(u, ground + 0.5) - 1) continue;
      // Lying on the slope (its bedding face down the 33° flank), sunk into the debris:
      // the centre a little below the lowest ground under the block - none can hover.
      const fr = Math.max(sx, sz) * 0.7;
      let gmin = ground;
      for (let k = 0; k < 6; k++) gmin = Math.min(gmin, this.pileAt(u + Math.cos(k * 1.047) * fr, v + Math.sin(k * 1.047) * fr));
      const y = gmin + sy * (0.05 + rnd() * 0.15);
      const [x, z] = this.world(u, v);
      this.slopeQ(u, v, rnd() * 6.28, (rnd() - 0.5) * 0.35, q);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
      lists[Math.floor(rnd() * VAR)].push(m.clone());
      if (r > 0.35) this.blocks.push({ x: u, z: v, top: y + sy * 0.8, r: Math.max(sx, sz) * 0.85 });
    }
    for (let k = 0; k < VAR; k++) {
      const im = new THREE.InstancedMesh(this.blockGeometry(k + 1, 2), this.material(0.16, 3), lists[k].length);
      lists[k].forEach((mm, i) => im.setMatrixAt(i, mm));
      im.frustumCulled = false;
      this.blockGroup.add(im);
    }
    // Rubble: cobbles and pebbles (5-25 cm) all over the pile and its toe - low-poly,
    // they are small; denser where the pile is steeper and the blocks broke up.
    const PV = 4, peb: THREE.Matrix4[][] = Array.from({ length: PV }, () => []);
    for (let i = 0; i < 16000; i++) {
      const u = (rnd() * 2 - 1) * 110, v = (rnd() * 2 - 1) * Vh;
      const ground = this.pileAt(u, v);
      if (Math.abs(v) > this.halfWidth(u, ground + 0.3) - 0.5) continue;
      if (rnd() > 1 - THREE.MathUtils.smoothstep(Math.hypot(u, v), 60, 110) * 0.8) continue;
      const r = Math.min(0.25, 0.05 * Math.pow(1 - rnd() * 0.99, -1 / 1.8));
      const sx = r * (0.8 + rnd() * 0.6), sy = r * (0.5 + rnd() * 0.4), sz = r * (0.8 + rnd() * 0.6);
      const [x, z] = this.world(u, v);
      this.slopeQ(u, v, rnd() * 6.28, (rnd() - 0.5) * 0.6, q);
      m.compose(new THREE.Vector3(x, ground - sy * 0.15, z), q, new THREE.Vector3(sx, sy, sz));
      // Pebbles under 9 cm: a few pixels across, the simplest shapes (variants 0-1).
      peb[(r < 0.09 ? 0 : 2) + Math.floor(rnd() * 2)].push(m.clone());
    }
    for (let k = 0; k < PV; k++) {
      const im = new THREE.InstancedMesh(this.blockGeometry(k + 11, k < 2 ? 0 : 1), this.material(0.17, 3), peb[k].length);
      peb[k].forEach((mm, i) => im.setMatrixAt(i, mm));
      im.frustumCulled = false;
      this.rubbleGroup.add(im);
    }
    return grp;
  }

  private mesh(g: THREE.BufferGeometry, albedo: number, kind: number): THREE.Mesh {
    const mesh = new THREE.Mesh(g, this.material(albedo, kind));
    mesh.frustumCulled = false;
    return mesh;
  }

  /** kind: 0 tube walls, 1 the opening's throat, 2 the debris pile, 3 roof blocks, 4 benches. */
  private material(albedo: number, kind: number): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uAlbedo: { value: albedo }, uKind: { value: kind }, uAxis: { value: new THREE.Vector2(this.ax, this.az) } },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vW; varying vec3 vN;
        void main() {
          #ifdef USE_INSTANCING
          mat4 im = instanceMatrix;
          #else
          mat4 im = mat4(1.0);
          #endif
          vec4 w = modelMatrix * im * vec4(position, 1.0); vW = w.xyz;
          // Inverse-transpose-free: the scale is per axis, so divide the normal by it.
          vec3 sc = vec3(dot(im[0].xyz, im[0].xyz), dot(im[1].xyz, im[1].xyz), dot(im[2].xyz, im[2].xyz));
          vN = normalize(mat3(modelMatrix) * mat3(im) * (normal / sc));
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW; varying vec3 vN;
        uniform vec3 uSun; uniform vec3 uSunE; uniform vec3 uSky; uniform vec4 uHole;
        uniform float uHoleR[72]; uniform float uMeanR; uniform float uPileTop; uniform float uAlbedo; uniform float uKind; uniform vec2 uAxis; uniform vec3 uSpot;
        float holeRadius(vec2 q) {
          float a = atan(q.y, q.x); if (a < 0.0) a += 6.2831853;
          float f = a / 6.2831853 * 72.0; int i0 = int(floor(f)); int i1 = i0 + 1; if (i1 >= 72) i1 = 0; if (i0 >= 72) i0 = 0;
          return mix(uHoleR[i0], uHoleR[i1], fract(f));
        }
        uint hu(uvec3 v) { v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; return v.x + v.y * v.z; }
        float hn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          #define H(o) (float(hu(uvec3(ivec3(i + o) + 1048576))) * (1.0 / 4294967295.0))
          return mix(mix(mix(H(vec3(0,0,0)), H(vec3(1,0,0)), f.x), mix(H(vec3(0,1,0)), H(vec3(1,1,0)), f.x), f.y),
                     mix(mix(H(vec3(0,0,1)), H(vec3(1,0,1)), f.x), mix(H(vec3(0,1,1)), H(vec3(1,1,1)), f.x), f.y), f.z); }
        // Gradient of one noise octave (central differences, world space: stable, no
        // screen-derivative blockiness), faded out where it gets finer than ~2 pixels.
        vec3 bumpOct(vec3 p, float f, float px) {
          float e = 0.18;
          vec3 q = p * f;
          vec3 g = vec3(hn(q + vec3(e, 0, 0)) - hn(q - vec3(e, 0, 0)), hn(q + vec3(0, e, 0)) - hn(q - vec3(0, e, 0)), hn(q + vec3(0, 0, e)) - hn(q - vec3(0, 0, e))) / (2.0 * e);
          return g * (1.0 - smoothstep(0.25, 0.6, px * f));
        }
        void main() {
          vec2 hc = uHole.xy; float rim = uHole.z, ceil = uHole.w;
          // The tube's ceiling is open where the throat comes through.
          // (cut slightly inside the throat, which reaches below it: they overlap).
          // Its edge is broken rock, not a circle: radius and height wander.
          float cutN = hn(vW * 0.35 + 4.0) - 0.5;
          if (uKind < 0.5 && vW.y > ceil - 6.0 + cutN * 4.0 && length(vW.xz - hc) < holeRadius(vW.xz - hc) * (0.92 + 0.08 * cutN)) discard;
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          vec3 n0 = n;
          // Close-up relief (what no orbital image shows; basalt as on Earth's lava tubes):
          // knobs and spalls, then chips, then grains - each only while bigger than a pixel.
          float px = length(fwidth(vW));
          vec3 g = bumpOct(vW, 0.9, px) * 0.35 + bumpOct(vW + 5.3, 3.1, px) * 0.22 + bumpOct(vW + 9.1, 9.0, px) * 0.12 + bumpOct(vW + 2.7, 26.0, px) * 0.06;
          // Walls: lava-smoothed with knobs; pile: lumpy rubble; blocks: rough fracture faces.
          // Walls: the relief shows in the sunbeam; under grazing diffuse light it would
          // streak, so there it stays soft.
          vec3 gt = g - n0 * dot(g, n0);
          float bumpK = uKind < 1.5 || uKind > 3.5 ? 0.15 : uKind < 2.5 ? 0.8 : 1.2;
          n = normalize(n0 - gt * bumpK);
          vec3 nSun = uKind < 1.5 || uKind > 3.5 ? normalize(n0 - gt * 0.6) : normalize(n0 + n);
          vec3 E = vec3(0.0);
          // Sunlight through the opening: is the point's ray to the Sun inside its outline?
          if (uSun.y > 0.03 && vW.y < rim) {
            float t = (rim - vW.y) / uSun.y;
            vec2 q = vW.xz + uSun.xz * t - hc;
            // Penumbra: the Sun's 0.35° disc over the distance from the rim (~0.25 m at 40 m).
            float pen = 0.003 * t + 0.03;
            float lit = 1.0 - smoothstep(-pen, pen, length(q) - holeRadius(q));
            // At the rim the rock is the surface itself: open to the Sun.
            lit = max(lit, smoothstep(rim - 2.0, rim - 0.2, vW.y));
            // Under the direct beam the relief shades softly (fine bumps do not cast black spots).
            E += uSunE * lit * max(dot(nSun, uSun), 0.0);
          }
          // Sky light through the opening (its solid angle, cosine-weighted).
          vec3 toH = vec3(hc.x, rim, hc.y) - vW;
          float D2 = dot(toH, toH);
          vec3 dH = toH * inversesqrt(D2);
          float A = 3.14159 * uMeanR * uMeanR;
          float omega = A * max(dH.y, 0.0) / (D2 + A);
          E += uSky * omega * max(dot(n, dH), 0.0) * 3.14159;
          // In the throat: the sky it sees falls off with depth (view factor of the opening:
          // half the sky at the rim for a wall, R²/(R²+d²) for an upward face) - the walls
          // fade gradually into the dark, no sharp black edge.
          float dDeep = max(rim - vW.y, 0.0);
          float inThroat = (1.0 - smoothstep(uMeanR * 1.1, uMeanR * 1.5, length(vW.xz - hc))) * smoothstep(ceil - 12.0, ceil - 4.0, vW.y);
          float Fside = 0.5 * (1.0 - dDeep / sqrt(dDeep * dDeep + 4.0 * uMeanR * uMeanR));
          float Fup = uMeanR * uMeanR / (uMeanR * uMeanR + dDeep * dDeep);
          E += uSky * 3.14159 * inThroat * mix(Fside, Fup, max(n.y, 0.0)) * (1.0 - min(omega * 4.0, 1.0));
          // Bounce from the sunlit patch of the pile (its flux over the distance squared).
          vec3 toS = uSpot - vW;
          float S2 = dot(toS, toS) + 40.0;
          float flux = A * max(uSun.y, 0.0) * 0.2 / 3.14159;
          E += uSunE * flux * max(dot(n, toS * inversesqrt(S2)), 0.0) / S2 * 1.5;
          // Light bounced wall to wall: it carries on along the tube, fading with each
          // bounce (~e-fold per 40 m) - the passage recedes into the dark, never cut off.
          // Estimate: ~0.2 of the light let in, spread over ~80 m of a 220 m-round tube,
          // ~0.7 % of sunlight near the opening, halving every ~40 m (e-fold 60 m).
          float along = abs(dot(vW.xz - hc, uAxis));
          float multi = 0.011 * max(uSun.y, 0.0) * exp(-along / 80.0);
          E += uSunE * multi * (0.7 + 0.3 * n.y);
          // Light from the lit ground around: faces turned sideways or down still see the
          // pile or floor under them (what keeps a rock's shaded side from going black).
          vec3 Eg = uSky * omega * max(dH.y, 0.0) * 3.14159 + uSunE * flux * max(toS.y * inversesqrt(S2), 0.0) / S2 * 1.5 + uSunE * multi;
          E += Eg * 0.2 * (0.5 - 0.5 * n.y);
          // Basalt walls; dust and fine debris on the upward faces and the pile.
          float up = smoothstep(0.35, 0.85, n.y);
          float var = hn(vW * 0.35) * 0.6 + hn(vW * 1.7 + 3.1) * 0.4;
          // Vesicles and darker chips, lighter grains of dust - fading with distance like the relief.
          float fine = (hn(vW * 7.0 + 1.3) - 0.5) * (1.0 - smoothstep(0.03, 0.08, px)) + (hn(vW * 23.0) - 0.5) * 0.6 * (1.0 - smoothstep(0.01, 0.03, px));
          // Vesicles (gas bubbles in the basalt): on the blocks and walls, not in the dusty rubble.
          float pits = smoothstep(0.74, 0.8, hn(vW * 14.0 + 7.7)) * (1.0 - smoothstep(0.015, 0.04, px)) * (uKind > 2.5 ? 0.6 : 0.0);
          // Secondary minerals on the walls (sulfate / silica crusts, as in Earth's lava
          // tubes): pale patches with ragged edges, here and there.
          // Thin and faint, along cracks (thin bands of a warped field), most on the vault.
          float crustN = abs(hn(vW * 0.25 + 2.0) - 0.5) + 0.25 * (hn(vW * 1.3 + 6.0) - 0.5);
          float crust = uKind < 1.5 ? (1.0 - smoothstep(0.015, 0.05, crustN)) * smoothstep(0.2, 0.7, n0.y * -1.0 + 0.3) * 0.35 * smoothstep(0.62, 0.75, hn(vW * 0.04 + 9.0)) : 0.0;
          float alb = mix(uAlbedo, 0.2, up * 0.6) * (0.88 + 0.24 * var) * (1.0 + 0.35 * fine) * (1.0 - 0.6 * pits);
          vec3 tint = mix(vec3(1.0, 0.82, 0.68), vec3(1.0, 0.95, 0.82), crust);
          alb = mix(alb, 0.22 * (0.8 + 0.4 * hn(vW * 6.0)), crust * 0.6);
          vec3 col = vec3(alb) * tint / 3.14159 * E;
          // Local adaptation (as the eye does between a sunlit patch and the dark around):
          // highlights far above the adapted level roll off instead of burning to white.
          #ifdef TONE_MAPPING
          float Lx = dot(col, vec3(0.3, 0.59, 0.11)) * toneMappingExposure;
          #else
          float Lx = dot(col, vec3(0.3, 0.59, 0.11));
          #endif
          col *= pow(1.0 + Lx, -0.85);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    return m;
  }
}
