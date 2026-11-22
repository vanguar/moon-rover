/// <reference lib="webworker" />
import { TerrainData, type TerrainMeta } from './TerrainData';
import { perimeter } from './perimeter';

/**
 * Builds terrain chunk vertex data off the main thread.
 * Grid of (segs+1)^2 vertices followed by a 4*segs skirt ring.
 */
let terrain: TerrainData | null = null;

export interface BuildRequest {
  type: 'build';
  id: number;
  cx: number;
  cz: number;
  size: number;
  segs: number;
  skirt: number;
}

export interface BuildResult {
  id: number;
  positions: Float32Array;
  normals: Int8Array;
  minY: number;
  maxY: number;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    terrain = new TerrainData(msg.meta as TerrainMeta, msg.heights as Float32Array, msg.far ?? null);
    return;
  }
  if (msg.type === 'build' && terrain) {
    const r = build(terrain, msg as BuildRequest);
    (self as unknown as Worker).postMessage(r, [r.positions.buffer, r.normals.buffer]);
  }
};

function build(t: TerrainData, q: BuildRequest): BuildResult {
  const n = q.segs;
  const step = q.size / n;
  const x0 = q.cx - q.size / 2, z0 = q.cz - q.size / 2;
  // Heights with a one-sample border for normals that match across chunks.
  const m = n + 3;
  const hs = new Float32Array(m * m);
  for (let j = 0; j < m; j++) {
    const z = z0 + (j - 1) * step;
    for (let i = 0; i < m; i++) hs[j * m + i] = t.height(x0 + (i - 1) * step, z);
  }
  const nGrid = (n + 1) * (n + 1);
  const nVerts = nGrid + 4 * n;
  const positions = new Float32Array(nVerts * 3);
  const normals = new Int8Array(nVerts * 3);
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * (n + 1) + i;
      const y = hs[(j + 1) * m + i + 1];
      positions[v * 3] = (i - n / 2) * step;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = (j - n / 2) * step;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const hx = hs[(j + 1) * m + i + 2] - hs[(j + 1) * m + i];
      const hz = hs[(j + 2) * m + i + 1] - hs[j * m + i + 1];
      const nx = -hx, ny = 2 * step, nz = -hz;
      const l = 127 / Math.hypot(nx, ny, nz);
      normals[v * 3] = Math.round(nx * l);
      normals[v * 3 + 1] = Math.round(ny * l);
      normals[v * 3 + 2] = Math.round(nz * l);
    }
  }
  // Skirt: perimeter loop (north edge eastward, east edge southward, ...) lowered.
  const perim = perimeter(n);
  for (let k = 0; k < perim.length; k++) {
    const src = perim[k], v = nGrid + k;
    positions[v * 3] = positions[src * 3];
    positions[v * 3 + 1] = positions[src * 3 + 1] - q.skirt;
    positions[v * 3 + 2] = positions[src * 3 + 2];
    normals[v * 3] = normals[src * 3];
    normals[v * 3 + 1] = normals[src * 3 + 1];
    normals[v * 3 + 2] = normals[src * 3 + 2];
  }
  return { id: q.id, positions, normals, minY: minY - q.skirt, maxY };
}
