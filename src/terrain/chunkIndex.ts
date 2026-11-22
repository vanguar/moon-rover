import * as THREE from 'three';
import { perimeter } from './perimeter';

const cache = new Map<number, THREE.BufferAttribute>();

/** Shared index buffer for a chunk with `n` segments per side (grid + outward-facing skirt). */
export function chunkIndex(n: number): THREE.BufferAttribute {
  let attr = cache.get(n);
  if (attr) return attr;
  const nGrid = (n + 1) * (n + 1);
  const perim = perimeter(n);
  const count = n * n * 6 + perim.length * 6;
  const idx = nGrid + perim.length > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + n + 1, c = a + 1, d = b + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = c; idx[k++] = b; idx[k++] = d;
    }
  }
  for (let p = 0; p < perim.length; p++) {
    const q = (p + 1) % perim.length;
    const A = perim[p], B = perim[q], C = nGrid + p, D = nGrid + q;
    idx[k++] = A; idx[k++] = B; idx[k++] = C;
    idx[k++] = B; idx[k++] = D; idx[k++] = C;
  }
  attr = new THREE.BufferAttribute(idx, 1);
  cache.set(n, attr);
  return attr;
}
