export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  pixelRatio: number;
  shadowMapSize: number;
  /** Half-size of the real-time sun shadow frustum, metres. */
  shadowRange: number;
  drawDistance: number;
  /** Segments per terrain chunk for LOD level 0..4. */
  lodSegments: number[];
  /** Distance thresholds between LOD levels, metres. */
  lodDistances: number[];
  rockRadius: number;
  rockDensity: number;
  maxRocks: number;
  dustParticles: number;
  stars: number;
}

const PRESETS: Record<QualityLevel, Omit<QualitySettings, 'level' | 'pixelRatio'> & { maxPixelRatio: number }> = {
  low: {
    maxPixelRatio: 1.25, shadowMapSize: 2048, shadowRange: 30, drawDistance: 1600,
    lodSegments: [128, 64, 32, 16, 8], lodDistances: [70, 260, 600, 1100],
    rockRadius: 110, rockDensity: 0.45, maxRocks: 2500, dustParticles: 1200, stars: 2500,
  },
  medium: {
    maxPixelRatio: 1.25, shadowMapSize: 2048, shadowRange: 40, drawDistance: 2600,
    lodSegments: [128, 64, 32, 16, 8], lodDistances: [110, 360, 800, 1600],
    rockRadius: 170, rockDensity: 0.7, maxRocks: 6000, dustParticles: 2500, stars: 4500,
  },
  high: {
    maxPixelRatio: 1.5, shadowMapSize: 4096, shadowRange: 50, drawDistance: 3800,
    lodSegments: [256, 128, 64, 32, 16], lodDistances: [90, 380, 900, 1900],
    rockRadius: 240, rockDensity: 1.0, maxRocks: 12000, dustParticles: 5000, stars: 7000,
  },
  ultra: {
    maxPixelRatio: 3, shadowMapSize: 4096, shadowRange: 70, drawDistance: 5000,
    lodSegments: [256, 128, 64, 32, 16], lodDistances: [140, 500, 1200, 2500],
    rockRadius: 320, rockDensity: 1.2, maxRocks: 20000, dustParticles: 8000, stars: 9000,
  },
};

export const isMobile: boolean = (() => {
  const ua = navigator.userAgent;
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (touch && Math.min(screen.width, screen.height) < 900);
})();

const LEVEL_ORDER: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const AUTO_KEY = 'moon-rover-autoq';

/**
 * What automatic quality settled on for this device in earlier sessions: the level it
 * ran at, whether it had headroom left (then the next session tries one level up),
 * and the lowest level found too slow (never probed again).
 */
interface AutoMemory {
  level: QualityLevel;
  headroom?: boolean;
  ceiling?: QualityLevel;
}

function loadAutoMemory(): AutoMemory | null {
  try {
    const m = JSON.parse(localStorage.getItem(AUTO_KEY) ?? 'null') as AutoMemory | null;
    return m && LEVEL_ORDER.includes(m.level) ? m : null;
  } catch {
    return null;
  }
}

/** Remember the level automatic quality ended up with (see Game.adaptQuality). */
export function saveAutoQuality(level: QualityLevel, headroom: boolean, tooSlow?: QualityLevel): void {
  try {
    const prev = loadAutoMemory();
    let ceiling = prev?.ceiling;
    if (tooSlow && (!ceiling || LEVEL_ORDER.indexOf(tooSlow) < LEVEL_ORDER.indexOf(ceiling))) ceiling = tooSlow;
    localStorage.setItem(AUTO_KEY, JSON.stringify({ level, headroom, ceiling } satisfies AutoMemory));
  } catch {
    /* storage unavailable */
  }
}

export function autoQuality(): QualityLevel {
  // Learned on this device: start where it settled, one level up if there was headroom
  // (but never at a level that already proved too slow).
  const m = loadAutoMemory();
  if (m) {
    const i = LEVEL_ORDER.indexOf(m.level);
    const up = LEVEL_ORDER[Math.min(i + 1, LEVEL_ORDER.length - 1)];
    const cap = m.ceiling ? LEVEL_ORDER.indexOf(m.ceiling) - 1 : LEVEL_ORDER.length - 1;
    return m.headroom && LEVEL_ORDER.indexOf(up) <= cap ? up : m.level;
  }
  if (isMobile) {
    // First run: start high enough to look good; the first seconds of driving step it
    // down quickly if the phone cannot keep up.
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    return mem >= 6 && (navigator.hardwareConcurrency ?? 4) >= 8 ? 'high' : 'medium';
  }
  // Integrated GPUs (Intel Iris/UHD, Apple M-series iGPU is fine) start one level lower.
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(name)) return 'medium';
  } catch {
    /* ignore */
  }
  return 'high';
}

export function makeQuality(level: QualityLevel): QualitySettings {
  const p = PRESETS[level];
  const { maxPixelRatio, ...rest } = p;
  return { level, pixelRatio: Math.min(window.devicePixelRatio || 1, maxPixelRatio), ...rest };
}

const STORE_KEY = 'moon-rover-settings';

export interface UserSettings {
  quality: QualityLevel | 'auto';
  world: 'moon' | 'mars';
  rover: { moon: string; mars: string };
  /** Landing site chosen on each world (src/world.ts). */
  site: { moon?: string; mars?: string };
  /** Mars weather: 'auto' cycles calm / dust devils / storms. */
  weather: 'auto' | 'calm' | 'devils' | 'storm';
  tiltSteering: boolean;
  volume: number;
}

export function loadSettings(): UserSettings {
  const def: UserSettings = {
    quality: 'auto', tiltSteering: false, volume: 0.8, world: 'moon', rover: { moon: 'lrv', mars: 'perseverance' }, site: {}, weather: 'auto',
  };
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (!s) return def;
    const v = JSON.parse(s) as Partial<UserSettings>;
    return { ...def, ...v, rover: { ...def.rover, ...(v.rover ?? {}) }, site: { ...(v.site ?? {}) } };
  } catch {
    return def;
  }
}

export function saveSettings(s: UserSettings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
