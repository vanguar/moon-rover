import * as THREE from 'three';
import { dataUrl } from '../version';
import type { TerrainData } from './TerrainData';

/**
 * Full-resolution orthophoto around the rover (HiRISE 25 cm on Mars, LROC NAC 50 cm
 * on the Moon), streamed as 256 m tiles into a 3 × 3 ring atlas: tile (i, j) lives in
 * slot (i mod 3, j mod 3), so moving one tile over replaces only one row or column
 * of slots, copied on the GPU without touching the rest. The terrain shader blends
 * it over the base orthophoto where the screen footprint is small enough.
 *
 * The photographed illumination has been divided out (tools/prepare_detail.py), so
 * the game's own Sun lights it correctly from any direction.
 */
const N = 3;

export class DetailTiles {
  readonly texture: THREE.DataTexture;
  /** (x0, z0, tile size m, enabled). */
  readonly rect = new THREE.Vector4(0, 0, 256, 0);
  /** Tile index held by each slot (i + j * 4096), −1 = empty. */
  readonly slots = new Float32Array(N * N).fill(-1);
  private have: Set<string>;
  private res: number;
  private want = new Map<number, number>(); // slot -> wanted id
  private loading = new Set<number>();
  private center = '';

  constructor(private renderer: THREE.WebGLRenderer, private terrain: TerrainData, private base: string) {
    const d = terrain.meta.detail!;
    this.res = d.res;
    this.have = new Set(d.tiles);
    const S = d.res * N;
    this.texture = new THREE.DataTexture(new Uint8Array(S * S * 4), S, S, THREE.RGBAFormat);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    renderer.initTexture(this.texture);
    this.rect.set(d.x0, d.z0, d.tile, 1);
  }

  update(x: number, z: number): void {
    const d = this.terrain.meta.detail!;
    const ci = Math.floor((x - d.x0) / d.tile), cj = Math.floor((z - d.z0) / d.tile);
    const key = `${ci},${cj}`;
    if (key === this.center) return;
    this.center = key;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        const slot = (((i % N) + N) % N) + (((j % N) + N) % N) * N;
        const id = i + j * 4096;
        this.want.set(slot, id);
        if (this.slots[slot] === id || !this.have.has(`${i}_${j}`)) {
          if (!this.have.has(`${i}_${j}`)) this.slots[slot] = -1;
          continue;
        }
        void this.load(i, j, slot, id);
      }
    }
  }

  private async load(i: number, j: number, slot: number, id: number): Promise<void> {
    if (this.loading.has(id)) return;
    this.loading.add(id);
    try {
      const r = await fetch(dataUrl(`${this.base}detail/${i}_${j}.jpg`));
      if (!r.ok) return;
      const bmp = await createImageBitmap(await r.blob());
      // Moved on meanwhile: the slot now wants another tile.
      if (this.want.get(slot) !== id) {
        bmp.close();
        return;
      }
      const src = new THREE.Texture(bmp);
      src.colorSpace = THREE.SRGBColorSpace;
      src.flipY = false;
      src.needsUpdate = true;
      const sx = slot % N, sy = Math.floor(slot / N);
      this.renderer.copyTextureToTexture(src, this.texture, null, new THREE.Vector2(sx * this.res, sy * this.res));
      src.dispose();
      bmp.close();
      this.slots[slot] = id;
    } catch {
      /* offline or decode error: the base orthophoto stays */
    } finally {
      this.loading.delete(id);
    }
  }
}
