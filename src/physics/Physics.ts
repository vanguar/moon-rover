import RAPIER from '@dimforge/rapier3d-compat';
import { MOON_GRAVITY } from '../config';
import type { TerrainData } from '../terrain/TerrainData';

export type Rapier = typeof RAPIER;

/** Size and resolution of the streamed terrain heightfield collider around the rover. */
const PATCH_SIZE = 128;
const PATCH_CELLS = 256; // 0.5 m cells: matches the finest render LOD and small craters
const PATCH_RECENTER = 32;

export const FIXED_DT = 1 / 60;

/**
 * Rapier world in lunar gravity. No air: rigid bodies get zero linear damping
 * and only a tiny angular damping standing in for joint/suspension losses.
 */
export class Physics {
  readonly R: Rapier;
  readonly world: RAPIER.World;
  private terrain: TerrainData;
  private patch: RAPIER.Collider | null = null;
  private patchX = Number.NaN;
  private patchZ = Number.NaN;
  private acc = 0;

  constructor(R: Rapier, terrain: TerrainData) {
    this.R = R;
    this.terrain = terrain;
    this.world = new R.World({ x: 0, y: -MOON_GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  static async create(terrain: TerrainData): Promise<Physics> {
    await RAPIER.init();
    return new Physics(RAPIER, terrain);
  }

  /** Rebuild the terrain heightfield patch when the rover nears its border. */
  updatePatch(x: number, z: number, force = false): void {
    if (!force && Math.abs(x - this.patchX) < PATCH_RECENTER && Math.abs(z - this.patchZ) < PATCH_RECENTER) return;
    const cell = PATCH_SIZE / PATCH_CELLS;
    // Snap to the cell grid so consecutive patches sample identical points.
    const cx = Math.round(x / cell) * cell;
    const cz = Math.round(z / cell) * cell;
    const n = PATCH_CELLS;
    const heights = new Float32Array((n + 1) * (n + 1));
    const x0 = cx - PATCH_SIZE / 2, z0 = cz - PATCH_SIZE / 2;
    for (let c = 0; c <= n; c++) {
      const wx = x0 + c * cell;
      for (let r = 0; r <= n; r++) heights[r + c * (n + 1)] = this.terrain.height(wx, z0 + r * cell);
    }
    const desc = this.R.ColliderDesc.heightfield(n, n, heights, { x: PATCH_SIZE, y: 1, z: PATCH_SIZE })
      .setTranslation(cx, 0, cz)
      .setFriction(0.9)
      .setRestitution(0.05);
    const next = this.world.createCollider(desc);
    if (this.patch) this.world.removeCollider(this.patch, false);
    this.patch = next;
    this.patchX = cx;
    this.patchZ = cz;
  }

  /**
   * Advances the simulation with a fixed step. `pre` runs before every substep
   * (vehicle controller update, forces).
   */
  step(dt: number, pre: (h: number) => void): number {
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < 5) {
      pre(FIXED_DT);
      this.world.step();
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === 5) this.acc = 0;
    return this.acc / FIXED_DT;
  }
}
