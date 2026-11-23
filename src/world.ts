/** Planetary body the game runs on. Everything body-specific is read from here. */
export type WorldId = 'moon' | 'mars';

export interface WorldConfig {
  id: WorldId;
  /** Surface gravity, m/s². */
  gravity: number;
  /** Mean radius, m (horizon curvature, lat/lon readout). */
  radius: number;
  /** Data directory under public/. */
  dataDir: string;
  /** Has an atmosphere: sky light, haze, wind, drag on dust. */
  atmosphere: boolean;
  /** Air density at the surface, kg/m³. */
  airDensity: number;
  /** Solar irradiance relative to 1 AU at the game epoch. */
  solarFactor: number;
  /** Rock abundance multiplier (Jezero's floor is far rockier than a mare). */
  rockDensity: number;
}

export const WORLDS: Record<WorldId, WorldConfig> = {
  moon: {
    id: 'moon', gravity: 1.62, radius: 1737400, dataDir: 'data/', atmosphere: false, airDensity: 0,
    solarFactor: 1, rockDensity: 1,
  },
  mars: {
    // Sol 0 of Mars 2020 (Ls 5.6°): Mars 1.63 AU from the Sun -> 38 % of the irradiance at Earth.
    id: 'mars', gravity: 3.721, radius: 3389500, dataDir: 'data/mars/', atmosphere: true, airDensity: 0.017,
    solarFactor: 0.38, rockDensity: 1.5,
  },
};

let current: WorldConfig = WORLDS.moon;

export function setWorld(id: WorldId): WorldConfig {
  current = WORLDS[id];
  return current;
}

export function world(): WorldConfig {
  return current;
}
