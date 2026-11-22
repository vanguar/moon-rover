import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { QualitySettings } from '../config';
import type { Physics } from '../physics/Physics';
import { makeLunar } from '../render/lunar';
import { hash2, mulberry32, type TerrainData } from './TerrainData';

const CELL = 32;
const VARIANTS = 6;
/** Rocks bigger than this get colliders within COLLIDER_RADIUS. */
const COLLIDER_BIG = 0.25;
const COLLIDER_RADIUS = 70;
/** Cobbles 10–25 cm get colliders only in the rover's own and adjacent cells. */
const COLLIDER_SMALL = 0.1;
const BOULDER_GRID = 8;
const BOULDER_CELL = 64;

interface Rock {
  x: number; y: number; z: number;
  r: number; sx: number; sy: number; sz: number;
  q: THREE.Quaternion;
  v: number;
  albedo: number;
  outcrop?: boolean;
}

function displaceNoise(rnd: () => number): (v: THREE.Vector3) => number {
  const waves = Array.from({ length: 14 }, (_, i) => ({
    d: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
    f: 1.5 * Math.pow(1.7, i % 7) * (0.8 + rnd() * 0.4),
    p: rnd() * 6.28,
  }));
  return (v) => waves.reduce((s, w) => s + (Math.sin(v.dot(w.d) * w.f + w.p) * 0.12) / Math.pow(w.f, 0.85), 0);
}

/**
 * Fractured basalt block: rounded by micrometeorite erosion on top, sharp
 * fracture planes, multi-scale surface roughness and vesicle pits.
 */
function rockGeometry(seed: number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const noise = displaceNoise(rnd);
  const nCuts = 5 + Math.floor(rnd() * 4);
  const dirs = Array.from({ length: nCuts }, () => new THREE.Vector3(rnd() - 0.5, rnd() - 0.3, rnd() - 0.5).normalize());
  const cuts = dirs.map(() => 0.5 + rnd() * 0.4);
  const pits = Array.from({ length: 12 }, () => ({ c: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), r: 0.05 + rnd() * 0.12 }));
  const elong = new THREE.Vector3(0.8 + rnd() * 0.5, 0.6 + rnd() * 0.5, 0.8 + rnd() * 0.5);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let s = 1 + noise(v);
    // Fracture planes: clamp to the plane, with a slightly bevelled edge.
    for (let k = 0; k < dirs.length; k++) {
      const d = v.dot(dirs[k]) * s;
      if (d > cuts[k]) s *= (cuts[k] + (d - cuts[k]) * 0.08) / d;
    }
    for (const pit of pits) {
      const dd = v.distanceTo(pit.c);
      if (dd < pit.r) s *= 1 - 0.06 * (1 - dd / pit.r) ** 2;
    }
    v.multiplyScalar(s).multiply(elong);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals(); // non-indexed: crisp facets on fracture planes
  return g;
}

/** Layered basalt slab: lava-flow units exposed in the rille wall. */
function outcropGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 8, 5, 4);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const noise = displaceNoise(rnd);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const layer = Math.floor((v.y + 0.5) * 5);
    const recess = (layer % 2) * 0.07 + Math.abs(noise(n.copy(v).normalize())) * 0.6;
    const k = 1 - recess;
    v.x *= k * (1 - Math.abs(v.y) * 0.25);
    v.z *= k;
    v.y += noise(n.set(v.z, v.x, v.y).normalize()) * 0.2;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const ni = g.toNonIndexed();
  ni.deleteAttribute('uv');
  ni.computeVertexNormals();
  g.dispose();
  return ni;
}

/**
 * Rocks: cobbles streamed around the rover (deterministic per 32 m cell) plus
 * metre-scale boulders and bedrock outcrops over the DTM window, placed by slope:
 * thin regolith on steep rille walls and crater rims exposes and sheds rock.
 */
export class Rocks {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private boulderNear: THREE.InstancedMesh;
  private boulderFar: THREE.InstancedMesh;
  private outcropMesh: THREE.InstancedMesh;
  private boulders: Rock[] = [];
  private boulderGrid = new Map<string, number[]>();
  private cellKey = '';
  private boulderKey = '';
  private colliders = new Map<string, RAPIER.Collider[]>();
  private boulderColliders = new Map<number, RAPIER.Collider>();
  private rockSize = new Map<number, number>();
  private q: QualitySettings;
  private tmpN = [0, 0, 0];

  constructor(private terrain: TerrainData, private physics: Physics, quality: QualitySettings) {
    this.q = quality;
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: 0x8e8a83 }), 'rock');
    for (let v = 0; v < VARIANTS; v++) {
      // Cobbles are small on screen: 80-triangle shapes are enough.
      const m = new THREE.InstancedMesh(rockGeometry(100 + v * 7, 1), mat, this.capacity());
      this.prep(m);
      this.meshes.push(m);
    }
    this.boulderNear = new THREE.InstancedMesh(rockGeometry(311, 3), mat, 1500);
    this.boulderFar = new THREE.InstancedMesh(rockGeometry(311, 1), mat, 6000);
    this.outcropMesh = new THREE.InstancedMesh(outcropGeometry(5), mat, 800);
    for (const m of [this.boulderNear, this.boulderFar, this.outcropMesh]) this.prep(m);
    // Far boulders are not drawn into the real-time shadow map (instanced meshes are not culled).
    this.boulderFar.castShadow = false;
    this.placeBoulders();
  }

  private capacity(): number {
    return Math.ceil(this.q.maxRocks / VARIANTS) + 64;
  }

  private prep(m: THREE.InstancedMesh): void {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.count = 0;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3).fill(1), 3);
    this.group.add(m);
  }

  setQuality(q: QualitySettings): void {
    this.q = q;
    for (let v = 0; v < VARIANTS; v++) {
      const old = this.meshes[v];
      const m = new THREE.InstancedMesh(old.geometry, old.material, this.capacity());
      this.group.remove(old);
      old.dispose();
      this.prep(m);
      this.meshes[v] = m;
    }
    this.cellKey = '';
    this.boulderKey = '';
  }

  private placeBoulders(): void {
    const t = this.terrain;
    const n = Math.floor(t.meta.sizeX / BOULDER_GRID);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -t.halfX + (i + 0.5) * BOULDER_GRID, z = -t.halfZ + (j + 0.5) * BOULDER_GRID;
        const h = hash2(i, j, 991);
        t.normal(x, z, this.tmpN, 3);
        const slopeDeg = (Math.acos(Math.min(1, this.tmpN[1])) * 180) / Math.PI;
        // Probability per 64 m² cell: sparse on the plains, dense on steep slopes.
        const p = 0.004 + 0.12 * THREE.MathUtils.smoothstep(slopeDeg, 10, 30);
        if (h > p) continue;
        const rnd = mulberry32(Math.floor(hash2(i, j, 4242) * 4294967296));
        const px = x + (rnd() - 0.5) * BOULDER_GRID, pz = z + (rnd() - 0.5) * BOULDER_GRID;
        const outcrop = slopeDeg > 24 && rnd() < 0.35;
        let r: number, sx: number, sy: number, sz: number;
        const q = new THREE.Quaternion();
        if (outcrop) {
          // Slab along the contour, dipping with the slope.
          r = 2 + rnd() * 4;
          sx = r * (1.2 + rnd()); sy = r * (0.35 + rnd() * 0.3); sz = r * (0.6 + rnd() * 0.4);
          const yaw = Math.atan2(this.tmpN[0], this.tmpN[2]) + Math.PI / 2;
          const up = new THREE.Vector3(this.tmpN[0], this.tmpN[1], this.tmpN[2]);
          q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
        } else {
          r = 0.6 * Math.pow(1 - rnd() * 0.97, -1 / 2.2);
          if (r > 6) r = 6;
          sx = r * (0.8 + rnd() * 0.4); sy = r * (0.55 + rnd() * 0.4); sz = r * (0.8 + rnd() * 0.4);
          q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.8, rnd() * 6.28, (rnd() - 0.5) * 0.8));
        }
        // Partially buried; large blocks sink deeper into the regolith.
        const y = t.height(px, pz) - sy * (outcrop ? 0.45 : 0.3);
        const idx = this.boulders.length;
        this.boulders.push({ x: px, y, z: pz, r, sx, sy, sz, q, v: 0, albedo: 0.85 + rnd() * 0.5, outcrop });
        const key = `${Math.floor(px / BOULDER_CELL)},${Math.floor(pz / BOULDER_CELL)}`;
        if (!this.boulderGrid.has(key)) this.boulderGrid.set(key, []);
        this.boulderGrid.get(key)!.push(idx);
      }
    }
  }

  private cellRocks(cx: number, cz: number): Rock[] {
    const t = this.terrain;
    const rnd = mulberry32(Math.floor(hash2(cx, cz, 77) * 4294967296));
    const x0 = cx * CELL, z0 = cz * CELL;
    t.normal(x0 + CELL / 2, z0 + CELL / 2, this.tmpN, 6);
    const slope = 1 - this.tmpN[1];
    const density = this.q.rockDensity * (22 + slope * 400);
    const n = Math.floor(density * (0.5 + rnd()));
    const out: Rock[] = [];
    for (let i = 0; i < n; i++) {
      const x = x0 + rnd() * CELL, z = z0 + rnd() * CELL;
      // Cumulative N(>D) ~ D^-2.1: lots of cobbles, rare large rocks.
      let r = 0.05 * Math.pow(1 - rnd() * 0.9999, -1 / 2.1);
      if (r > 1.5) r = 1.5;
      const sx = r * (0.8 + rnd() * 0.5), sy = r * (0.45 + rnd() * 0.45), sz = r * (0.8 + rnd() * 0.5);
      const y = t.height(x, z) - sy * 0.3;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6));
      // Fresh rock is brighter than space-weathered regolith; albedo varies by lithology.
      out.push({ x, y, z, r, sx, sy, sz, q, v: Math.floor(rnd() * VARIANTS), albedo: 0.75 + rnd() * 0.6 });
    }
    return out;
  }

  update(pos: THREE.Vector3): void {
    this.updateBoulders(pos);
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const key = `${cx},${cz}`;
    if (key === this.cellKey) return;
    this.cellKey = key;

    const rad = Math.ceil(this.q.rockRadius / CELL);
    const counts = new Array(VARIANTS).fill(0);
    const cap = this.meshes[0].instanceMatrix.count;
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const keep = new Set<string>();
    const cRad = Math.ceil(COLLIDER_RADIUS / CELL);
    const cells: [number, number, number][] = [];
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= rad * rad) cells.push([cx + dx, cz + dz, d2]);
      }
    cells.sort((a, b) => a[2] - b[2]);
    for (const [ix, iz, d2] of cells) {
      const rocks = this.cellRocks(ix, iz);
      const far = Math.sqrt(d2) * CELL;
      for (const r of rocks) {
        if (r.r < far * 0.0012) continue;
        const c = counts[r.v];
        if (c >= cap) continue;
        m4.compose(p.set(r.x, r.y, r.z), r.q, s.set(r.sx, r.sy, r.sz));
        this.meshes[r.v].setMatrixAt(c, m4);
        this.meshes[r.v].setColorAt(c, col.setScalar(r.albedo));
        counts[r.v] = c + 1;
      }
      const adj = Math.abs(ix - cx) <= 1 && Math.abs(iz - cz) <= 1;
      if (Math.abs(ix - cx) <= cRad && Math.abs(iz - cz) <= cRad) {
        // Key includes whether small cobbles are simulated, so cells are rebuilt when that changes.
        const k = `${ix},${iz},${adj ? 1 : 0}`;
        keep.add(k);
        if (!this.colliders.has(k)) {
          const min = adj ? COLLIDER_SMALL : COLLIDER_BIG;
          this.colliders.set(k, rocks.filter((r) => r.r >= min).map((r) => this.makeCollider(r)));
        }
      }
    }
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = counts[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.meshes[v].instanceColor!.needsUpdate = true;
    }
    for (const [k, list] of this.colliders) {
      if (!keep.has(k)) {
        for (const c of list) this.removeCollider(c);
        this.colliders.delete(k);
      }
    }
  }

  private updateBoulders(pos: THREE.Vector3): void {
    const bx = Math.floor(pos.x / BOULDER_CELL), bz = Math.floor(pos.z / BOULDER_CELL);
    const key = `${bx},${bz}`;
    if (key === this.boulderKey) return;
    this.boulderKey = key;
    const range = Math.min(this.q.drawDistance, 2500);
    const rad = Math.ceil(range / BOULDER_CELL);
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    let nNear = 0, nFar = 0, nOut = 0;
    const keepCol = new Set<number>();
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        const list = this.boulderGrid.get(`${bx + dx},${bz + dz}`);
        if (!list) continue;
        for (const idx of list) {
          const b = this.boulders[idx];
          const d = Math.hypot(b.x - pos.x, b.z - pos.z);
          if (d > range || b.r < d * 0.0012) continue;
          m4.compose(p.set(b.x, b.y, b.z), b.q, s.set(b.sx, b.sy, b.sz));
          col.setScalar(b.albedo);
          if (b.outcrop) {
            if (nOut < this.outcropMesh.instanceMatrix.count) {
              this.outcropMesh.setMatrixAt(nOut, m4);
              this.outcropMesh.setColorAt(nOut++, col);
            }
          } else if (d < 160 && nNear < this.boulderNear.instanceMatrix.count) {
            this.boulderNear.setMatrixAt(nNear, m4);
            this.boulderNear.setColorAt(nNear++, col);
          } else if (nFar < this.boulderFar.instanceMatrix.count) {
            this.boulderFar.setMatrixAt(nFar, m4);
            this.boulderFar.setColorAt(nFar++, col);
          }
          if (d < COLLIDER_RADIUS + b.r * 2) {
            keepCol.add(idx);
            if (!this.boulderColliders.has(idx)) this.boulderColliders.set(idx, this.makeCollider(b));
          }
        }
      }
    for (const [m, n] of [[this.boulderNear, nNear], [this.boulderFar, nFar], [this.outcropMesh, nOut]] as const) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
    for (const [idx, c] of this.boulderColliders) {
      if (!keepCol.has(idx)) {
        this.removeCollider(c);
        this.boulderColliders.delete(idx);
      }
    }
  }

  private makeCollider(r: Rock): RAPIER.Collider {
    const R = this.physics.R;
    // Rounded box fitted to the rock's scaled extents; rocks are fixed (embedded in regolith).
    const k = r.outcrop ? 0.42 : 0.68;
    const hx = r.sx * k, hy = r.sy * k, hz = r.sz * k;
    const br = Math.min(hx, hy, hz) * 0.45;
    const d = R.ColliderDesc.roundCuboid(hx - br, hy - br, hz - br, br)
      .setTranslation(r.x, r.y, r.z)
      .setRotation({ x: r.q.x, y: r.q.y, z: r.q.z, w: r.q.w })
      .setFriction(0.75)
      .setRestitution(0.15);
    const c = this.physics.world.createCollider(d);
    this.rockSize.set(c.handle, Math.min(r.r, 3));
    return c;
  }

  private removeCollider(c: RAPIER.Collider): void {
    this.rockSize.delete(c.handle);
    this.physics.world.removeCollider(c, false);
  }

  /** Rock size if the collider is a rock, else 0. */
  sizeOf(c: RAPIER.Collider): number {
    return this.rockSize.get(c.handle) ?? 0;
  }

  count(): number {
    return this.meshes.reduce((a, m) => a + m.count, 0) + this.boulderNear.count + this.boulderFar.count + this.outcropMesh.count;
  }
}
