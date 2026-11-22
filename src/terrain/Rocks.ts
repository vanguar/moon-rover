import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { QualitySettings } from '../config';
import type { Physics } from '../physics/Physics';
import { makeLunar } from '../render/lunar';
import { hash2, mulberry32, type TerrainData } from './TerrainData';

const CELL = 32;
const VARIANTS = 4;
const COLLIDER_RADIUS = 70;
const COLLIDER_MIN_SIZE = 0.28;

interface Rock {
  x: number; y: number; z: number;
  r: number; sx: number; sy: number; sz: number;
  qx: number; qy: number; qz: number; qw: number;
  v: number;
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  // Random low-frequency bumps + a few flat facets (fractured basalt look).
  const dirs = Array.from({ length: 6 }, () => new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize());
  const cuts = dirs.map(() => 0.55 + rnd() * 0.35);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let s = 1 + (rnd() - 0.5) * 0.18;
    for (let k = 0; k < dirs.length; k++) {
      const d = v.dot(dirs[k]) * s;
      if (d > cuts[k]) s *= cuts[k] / d;
    }
    v.multiplyScalar(s);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals(); // non-indexed: flat facets
  return g;
}

/**
 * Boulders and cobbles streamed around the rover. Placement is deterministic per
 * 32 m cell (hash-seeded), so the same rocks reappear when you come back.
 * Size-frequency follows a steep power law; rock density is raised on the rims
 * of the DTM's steep terrain (ejecta, rille walls).
 */
export class Rocks {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private cellKey = '';
  private colliders = new Map<string, RAPIER.Collider[]>();
  private q: QualitySettings;
  private tmpN = [0, 0, 0];

  constructor(private terrain: TerrainData, private physics: Physics, quality: QualitySettings) {
    this.q = quality;
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: 0x8c8780 }), 'rock');
    for (let v = 0; v < VARIANTS; v++) {
      const m = new THREE.InstancedMesh(rockGeometry(100 + v * 7), mat, Math.ceil(quality.maxRocks / VARIANTS) + 64);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  setQuality(q: QualitySettings): void {
    this.q = q;
    for (let v = 0; v < VARIANTS; v++) {
      const old = this.meshes[v];
      const m = new THREE.InstancedMesh(old.geometry, old.material, Math.ceil(q.maxRocks / VARIANTS) + 64);
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      this.group.remove(old);
      old.dispose();
      this.meshes[v] = m;
      this.group.add(m);
    }
    this.cellKey = '';
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
      // Cumulative N(>D) ~ D^-2.1: lots of cobbles, rare boulders.
      let r = 0.05 * Math.pow(1 - rnd() * 0.9999, -1 / 2.1);
      if (r > 2.2) r = 2.2;
      const sx = r * (0.8 + rnd() * 0.5), sy = r * (0.45 + rnd() * 0.45), sz = r * (0.8 + rnd() * 0.5);
      const y = t.height(x, z) - sy * 0.3;
      const a = rnd() * Math.PI * 2, tilt = (rnd() - 0.5) * 0.6;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, a, (rnd() - 0.5) * 0.6));
      out.push({ x, y, z, r, sx, sy, sz, qx: q.x, qy: q.y, qz: q.z, qw: q.w, v: Math.floor(rnd() * VARIANTS) });
    }
    return out;
  }

  update(pos: THREE.Vector3): void {
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const key = `${cx},${cz}`;
    if (key === this.cellKey) return;
    this.cellKey = key;

    const rad = Math.ceil(this.q.rockRadius / CELL);
    const counts = new Array(VARIANTS).fill(0);
    const cap = this.meshes[0].instanceMatrix.count;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const keepColliders = new Set<string>();
    const cRad = Math.ceil(COLLIDER_RADIUS / CELL);
    // Nearest cells first so the instance budget is spent close to the rover.
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
        // Small cobbles are invisible far away; skip them to save instances.
        if (r.r < far * 0.0015) continue;
        const c = counts[r.v];
        if (c >= cap) continue;
        p.set(r.x, r.y, r.z);
        q.set(r.qx, r.qy, r.qz, r.qw);
        s.set(r.sx, r.sy, r.sz);
        m4.compose(p, q, s);
        this.meshes[r.v].setMatrixAt(c, m4);
        counts[r.v] = c + 1;
      }
      if (Math.abs(ix - cx) <= cRad && Math.abs(iz - cz) <= cRad) {
        const k = `${ix},${iz}`;
        keepColliders.add(k);
        if (!this.colliders.has(k)) this.colliders.set(k, this.makeColliders(rocks));
      }
    }
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = counts[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
    }
    for (const [k, list] of this.colliders) {
      if (!keepColliders.has(k)) {
        for (const c of list) this.physics.world.removeCollider(c, false);
        this.colliders.delete(k);
      }
    }
  }

  private makeColliders(rocks: Rock[]): RAPIER.Collider[] {
    const R = this.physics.R;
    const out: RAPIER.Collider[] = [];
    for (const r of rocks) {
      if (r.r < COLLIDER_MIN_SIZE) continue;
      // Rounded box matching the rock's scaled extents; rocks are fixed (embedded in regolith).
      const br = Math.min(r.sx, r.sy, r.sz) * 0.25;
      const d = R.ColliderDesc.roundCuboid(r.sx * 0.72 - br, r.sy * 0.72 - br, r.sz * 0.72 - br, br)
        .setTranslation(r.x, r.y, r.z)
        .setRotation({ x: r.qx, y: r.qy, z: r.qz, w: r.qw })
        .setFriction(0.8)
        .setRestitution(0.1);
      out.push(this.physics.world.createCollider(d));
    }
    return out;
  }

  /** Visible rock instance count (for stats). */
  count(): number {
    return this.meshes.reduce((a, m) => a + m.count, 0);
  }
}
