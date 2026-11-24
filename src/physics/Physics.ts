import RAPIER from '@dimforge/rapier3d';
import { world } from '../world';
import type { TerrainData } from '../terrain/TerrainData';

export type Rapier = typeof RAPIER;

/** Size and resolution of the streamed terrain heightfield collider around the rover. */
const PATCH_SIZE = 128;
const PATCH_CELLS = 256; // 0.5 m cells: matches the finest render LOD and small craters
const PATCH_RECENTER = 32;

export const FIXED_DT = 1 / 120;

export interface ContactForce {
  c1: number;
  c2: number;
  force: number;
}

/**
 * Rapier world in the current body's gravity. Moon: no air: rigid bodies get zero linear damping
 * and only a tiny angular damping standing in for joint/suspension losses.
 */
export class Physics {
  readonly R: Rapier;
  readonly world: RAPIER.World;
  private terrain: TerrainData;
  private patch: RAPIER.Collider | null = null;
  private patchX = Number.NaN;
  private patchZ = Number.NaN;
  /** Next patch being sampled a few columns per frame (no hitch when it is swapped in). */
  private pending: { cx: number; cz: number; heights: Float32Array; col: number } | null = null;
  private acc = 0;
  private events: RAPIER.EventQueue;
  /** Contact force events (above each collider's threshold) since the last read. */
  private contacts: ContactForce[] = [];

  constructor(R: Rapier, terrain: TerrainData) {
    this.R = R;
    this.terrain = terrain;
    this.world = new R.World({ x: 0, y: -world().gravity, z: 0 });
    this.world.timestep = FIXED_DT;
    this.events = new R.EventQueue(true);
    this.world.numSolverIterations = 8;
  }

  static async create(terrain: TerrainData): Promise<Physics> {
    // The WebAssembly module is instantiated when this chunk loads (vite-plugin-wasm,
    // a separate streamed .wasm instead of the compat build's 4 MB of base64 in JS).
    return new Physics(RAPIER, terrain);
  }

  /**
   * Keep the terrain heightfield patch centred on the rover. Sampling 66 k heights
   * takes several milliseconds, so a new patch is built incrementally over a few
   * frames as soon as the rover drifts off-centre, and swapped in when complete.
   */
  updatePatch(x: number, z: number, force = false): void {
    const off = Math.max(Math.abs(x - this.patchX), Math.abs(z - this.patchZ));
    if (force || !(off < PATCH_SIZE / 2 - 12)) {
      // Teleport or far off the patch: build synchronously.
      this.pending = this.newPending(x, z);
      this.fillPending(PATCH_CELLS + 1);
      return;
    }
    if (!this.pending) {
      if (off < PATCH_RECENTER * 0.6) return;
      this.pending = this.newPending(x, z);
    }
    this.fillPending(PATCH_CELLS / 8);
  }

  private newPending(x: number, z: number): { cx: number; cz: number; heights: Float32Array; col: number } {
    const cell = PATCH_SIZE / PATCH_CELLS;
    // Snap to the cell grid so consecutive patches sample identical points.
    return { cx: Math.round(x / cell) * cell, cz: Math.round(z / cell) * cell, heights: new Float32Array((PATCH_CELLS + 1) * (PATCH_CELLS + 1)), col: 0 };
  }

  private fillPending(cols: number): void {
    const p = this.pending!;
    const n = PATCH_CELLS;
    const cell = PATCH_SIZE / n;
    const x0 = p.cx - PATCH_SIZE / 2, z0 = p.cz - PATCH_SIZE / 2;
    const end = Math.min(n + 1, p.col + cols);
    for (let c = p.col; c < end; c++) {
      const wx = x0 + c * cell;
      for (let r = 0; r <= n; r++) p.heights[r + c * (n + 1)] = this.terrain.height(wx, z0 + r * cell);
    }
    p.col = end;
    if (p.col <= n) return;
    const desc = this.R.ColliderDesc.heightfield(n, n, p.heights, { x: PATCH_SIZE, y: 1, z: PATCH_SIZE })
      .setTranslation(p.cx, 0, p.cz)
      .setFriction(0.7)
      .setRestitution(0.05);
    const next = this.world.createCollider(desc);
    if (this.patch) this.world.removeCollider(this.patch, false);
    this.patch = next;
    this.patchX = p.cx;
    this.patchZ = p.cz;
    this.pending = null;
  }

  takeContacts(): ContactForce[] {
    const c = this.contacts;
    this.contacts = [];
    return c;
  }

  /**
   * Advances the simulation with a fixed step. `pre` runs before every substep
   * (vehicle controller update, forces).
   */
  step(dt: number, pre: (h: number) => void): number {
    // Returns the interpolation factor between the last two physics states for rendering.
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < 8) {
      pre(FIXED_DT);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        if (this.contacts.length < 64) this.contacts.push({ c1: e.collider1(), c2: e.collider2(), force: e.totalForceMagnitude() });
      });
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === 8) this.acc = 0;
    return this.acc / FIXED_DT;
  }
}
