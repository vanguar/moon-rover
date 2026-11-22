import * as THREE from 'three';
import { makeLunar } from '../render/lunar';
import type { Rover } from '../rover/Rover';
import type { TerrainData } from '../terrain/TerrainData';

const SEG_LEN = 0.3;
const HALF_W = 0.12;
const PER_TRACK = 3000;
/** Wheels that leave visible ruts: front pair and rear pair (middle runs in the front ruts). */
const TRACK_WHEELS = [0, 1, 4, 5];

function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  // alphaMap reads the green channel: grey = compacted rut, white = grouser imprint, black edges.
  g.fillStyle = 'rgb(140,140,140)';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgb(235,235,235)';
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(4, 8);
  g.lineTo(32, 28);
  g.lineTo(60, 8);
  g.moveTo(4, 40);
  g.lineTo(32, 60);
  g.lineTo(60, 40);
  g.stroke();
  const grd = g.createLinearGradient(0, 0, 64, 0);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.15, 'rgba(0,0,0,0)');
  grd.addColorStop(0.85, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Wheel ruts: quads following the contact patches, draped on the terrain height function. */
export class Tracks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private uv: Float32Array;
  private last: (THREE.Vector3 | null)[] = TRACK_WHEELS.map(() => null);
  private lastL: THREE.Vector3[] = TRACK_WHEELS.map(() => new THREE.Vector3());
  private lastR: THREE.Vector3[] = TRACK_WHEELS.map(() => new THREE.Vector3());
  private dist = TRACK_WHEELS.map(() => 0);
  private head = TRACK_WHEELS.map(() => 0);

  constructor(private terrain: TerrainData) {
    const quads = PER_TRACK * TRACK_WHEELS.length;
    this.pos = new Float32Array(quads * 4 * 3);
    this.uv = new Float32Array(quads * 4 * 2);
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(quads * 4 * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = makeLunar(
      new THREE.MeshLambertMaterial({
        color: 0x000000,
        alphaMap: chevronTexture(),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
      'tracks',
    );
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }

  update(rover: Rover): void {
    let dirty = false;
    const fwd = rover.forwardVector(new THREE.Vector3());
    for (let t = 0; t < TRACK_WHEELS.length; t++) {
      const w = TRACK_WHEELS[t];
      if (!rover.wheelContact[w]) {
        this.last[t] = null;
        continue;
      }
      const c = rover.wheelWorld[w];
      const p = new THREE.Vector3(c.x, 0, c.z);
      const prev = this.last[t];
      if (!prev) {
        this.last[t] = p;
        this.edges(p, fwd, this.lastL[t], this.lastR[t]);
        continue;
      }
      const d = Math.hypot(p.x - prev.x, p.z - prev.z);
      if (d < SEG_LEN) continue;
      if (d > 3) {
        this.last[t] = p;
        this.edges(p, fwd, this.lastL[t], this.lastR[t]);
        continue;
      }
      const dir = new THREE.Vector3(p.x - prev.x, 0, p.z - prev.z).normalize();
      const L = new THREE.Vector3(), R = new THREE.Vector3();
      this.edges(p, dir, L, R);
      const q = t * PER_TRACK + this.head[t];
      this.head[t] = (this.head[t] + 1) % PER_TRACK;
      const v0 = this.dist[t] / 0.5, v1 = (this.dist[t] + d) / 0.5;
      this.dist[t] += d;
      const verts = [this.lastL[t], this.lastR[t], L, R];
      const uvs = [0, v0, 1, v0, 0, v1, 1, v1];
      for (let k = 0; k < 4; k++) {
        this.pos.set([verts[k].x, verts[k].y, verts[k].z], (q * 4 + k) * 3);
      }
      this.uv.set(uvs, q * 8);
      this.lastL[t].copy(L);
      this.lastR[t].copy(R);
      this.last[t] = p;
      dirty = true;
    }
    if (dirty) {
      const g = this.mesh.geometry;
      g.getAttribute('position').needsUpdate = true;
      g.getAttribute('uv').needsUpdate = true;
    }
  }

  private edges(p: THREE.Vector3, dir: THREE.Vector3, L: THREE.Vector3, R: THREE.Vector3): void {
    const sx = -dir.z * HALF_W, sz = dir.x * HALF_W;
    L.set(p.x + sx, 0, p.z + sz);
    R.set(p.x - sx, 0, p.z - sz);
    L.y = this.terrain.height(L.x, L.z) + 0.01;
    R.y = this.terrain.height(R.x, R.z) + 0.01;
  }
}
