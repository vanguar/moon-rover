/** Planetary body the game runs on. Everything body-specific is read from here. */
export type WorldId = 'moon' | 'mars';
export type SiteId = 'apollo15' | 'apollo17' | 'jezero' | 'pavonis' | 'gale';

/** A landing site of a world: its own terrain, sky, mission and finds. */
export interface SiteConfig {
  id: SiteId;
  /** Data directory under public/ (terrain.json, heightmap.bin, ortho*.jpg, ...). */
  dataDir: string;
}

export interface WorldConfig {
  id: WorldId;
  /** Surface gravity, m/s². */
  gravity: number;
  /** Mean radius, m (horizon curvature, lat/lon readout). */
  radius: number;
  /** Directory of the data every site of this world shares (rock atlas, Milky Way map). */
  commonDir: string;
  /** Landing sites; the first is the default. */
  sites: SiteConfig[];
  /** Sites being prepared: shown in the garage, not yet selectable. */
  upcoming?: string[];
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
    id: 'moon', gravity: 1.62, radius: 1737400, commonDir: 'data/', atmosphere: false, airDensity: 0,
    solarFactor: 1, rockDensity: 1,
    sites: [
      { id: 'apollo15', dataDir: 'data/' },
      { id: 'apollo17', dataDir: 'data/apollo17/' },
    ],
  },
  mars: {
    // Sol 0 of Mars 2020 (Ls 5.6°): Mars 1.63 AU from the Sun -> 38 % of the irradiance at Earth.
    id: 'mars', gravity: 3.721, radius: 3389500, commonDir: 'data/mars/', atmosphere: true, airDensity: 0.017,
    solarFactor: 0.38, rockDensity: 1.5,
    sites: [
      { id: 'jezero', dataDir: 'data/mars/' },
      { id: 'pavonis', dataDir: 'data/pavonis/' },
    ],
    upcoming: ['gale'],
  },
};

let current: WorldConfig = WORLDS.moon;
let currentSite: SiteConfig = WORLDS.moon.sites[0];

export function setWorld(id: WorldId): WorldConfig {
  current = WORLDS[id];
  currentSite = current.sites[0];
  return current;
}

export function world(): WorldConfig {
  return current;
}

/** Choose a site of the current world (unknown ids fall back to the first). */
export function setSite(id: string | undefined): SiteConfig {
  currentSite = current.sites.find((s) => s.id === id) ?? current.sites[0];
  return currentSite;
}

export function site(): SiteConfig {
  return currentSite;
}
