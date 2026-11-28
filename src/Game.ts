import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CabinAudio } from './audio/CabinAudio';
import { isMobile, makeQuality, saveAutoQuality, type QualityLevel, type QualitySettings } from './config';
import { Dust } from './fx/Dust';
import { MarsSky } from './fx/MarsSky';
import { MarsWeather, type WeatherMode } from './fx/MarsWeather';
import { Sky } from './fx/Sky';
import { Tracks } from './fx/Tracks';
import { Hud } from './hud/Hud';
import { Input } from './input/Input';
import type { Physics } from './physics/Physics';
import { APOLLO15_EVA1, lunarSky } from './astro/ephemeris';
import { setSurfacePhotometry } from './render/lunar';
import { ShadowBaker } from './render/ShadowBaker';
import { Rover } from './rover/Rover';
import { buildLunarModule } from './rover/models/nasa';
import { ROVERS, type RoverSpec } from './rover/specs';
import { Astronaut } from './eva/Astronaut';
import { EvaCamera } from './eva/EvaCamera';
import { Cave, type CaveMeta } from './terrain/Cave';
import { azElDir, marsSun } from './astro/marsSun';
import { marsSkyState } from './astro/marsSky';
import { MarsNight } from './fx/MarsNight';

import { LoadGovernor } from './perf/LoadGovernor';
import { Footprints } from './eva/Footprints';
import { fmtHM } from './format';
import { Helicopter } from './heli/Helicopter';
import { Radio } from './audio/Radio';
import { Meteors } from './fx/Meteors';
import { Discoveries } from './game/Discoveries';
import { Missions, type MissionKind } from './game/Missions';
import { buildAlsep, buildAlsep17, type Solid } from './game/Hardware';
import { buildLrvModel } from './rover/model';
import { applyWear } from './rover/models/wear';
import { Rocks } from './terrain/Rocks';
import type { TerrainData } from './terrain/TerrainData';
import { FarTerrain } from './terrain/FarTerrain';
import { TerrainRenderer } from './terrain/TerrainRenderer';
import { DetailTiles } from './terrain/DetailTiles';
import { t } from './i18n';
import { site, world } from './world';

/** Optional data for the scene; the centre orthophoto and the Milky Way map come later (setOrthoHi, setMilkyWay). */
export interface GameExtras {
  stars?: Float32Array;
  constellations?: Float32Array;
  farShadow?: THREE.Texture;
  farAlbedo?: THREE.Texture;
  /** Atlas of real photographs of rock surfaces (rover / Apollo frames; prepare_rocktex.py). */
  rockPhoto?: THREE.Texture;
  /** Bright stars as ICRF vectors (Mars: turned with the planet; tools/make_stars_icrf.py). */
  starsIcrf?: Float32Array;
}

/** three.js ACESFilmicToneMapping on the CPU (linear in, tone-mapped linear out). */
function acesFilmic(c: THREE.Color, exposure: number): THREE.Color {
  const k = exposure / 0.6;
  const r = c.r * k, g = c.g * k, b = c.b * k;
  // ACESInputMat (columns as in the GLSL).
  const i = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.076 * r + 0.90834 * g + 0.01566 * b, 0.0284 * r + 0.13383 * g + 0.83777 * b];
  const f = i.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081));
  const o = [1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2], -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2], -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2]];
  const sat = (v: number) => Math.min(1, Math.max(0, v));
  return new THREE.Color(sat(o[0]), sat(o[1]), sat(o[2]));
}

/** PLSS 7 h + OPS 30 min, s. */
const O2_FULL = 7.5 * 3600;
const O2_OPS = 1800;

/** Sun irradiance in scene units; everything else is relative to it. */
const SUN_INTENSITY = 9;
const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
/** Initial heading: west (toward Hadley Rille / the Jezero delta). */
const START_YAW = Math.PI - THREE.MathUtils.degToRad(270);
export type CameraMode = 'cabin' | 'chase' | 'top' | 'partner' | 'tv';
const CAMERA_CYCLE: CameraMode[] = ['cabin', 'chase', 'top'];
/** On foot: behind, the partner's Hasselblad, the rover's TV camera, the helmet, above. */
const EVA_CYCLE: CameraMode[] = ['chase', 'partner', 'tv', 'cabin', 'top'];

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input = new Input();
  readonly audio = new CabinAudio();
  private sun: THREE.DirectionalLight;
  /** Moon: black sky, stars, Earth. Mars: dusty daytime sky. */
  private sky: Sky | null = null;
  private marsSky: MarsSky | null = null;
  private marsNight: MarsNight | null = null;
  readonly weather: MarsWeather | null = null;
  private hemi: THREE.HemisphereLight;
  private earthshine: THREE.DirectionalLight | null = null;
  /** Simulated UTC time (ms) and its rate relative to real time (Moon). */
  simTime: number;
  timeScale = 60;
  private baker: ShadowBaker | null = null;
  private starFrame0 = new THREE.Matrix4();
  private envSun = new THREE.Vector3();
  onTimeChange?: (ms: number) => void;
  readonly sunDir: THREE.Vector3;
  private time = 0;
  private envTau = -1;
  private still = 0;
  /** Rover size relative to the LRV (camera distances). */
  private sizeK = 1;
  private terrainR: TerrainRenderer;
  private rocks: Rocks;
  rover: Rover;
  /** Ingenuity, when it is the selected vehicle (Perseverance then stays parked nearby). */
  heli: Helicopter | null = null;
  private heliHud: HTMLElement | null = null;
  /** Astronaut on foot (Moon, crewed rover): out of the rover, hopping to the target. */
  eva: Astronaut | null = null;
  /** Bootprints of every EVA (they stay: nothing erodes them on the Moon). */
  private footprints: Footprints | null = null;
  /**
   * Suit oxygen of the crew (Moon, crewed LRV), s. Apollo 15-17 PLSS: 7 h at an average
   * work rate, plus ~30 min in the OPS emergency bottle; the suits stay on while driving.
   * Used faster on foot (hopping is work), refilled only at the LM.
   */
  o2 = O2_FULL;
  readonly radio: Radio;
  private meteors: Meteors | null = null;
  readonly finds: Discoveries | null = null;
  mission!: Missions;
  private heliMaxDist = 0;
  /** Rover autopilot: drives to the mission target; hands over when stuck. */
  autoDrive = false;
  private ap = { stuck: 0, avoid: 0, avoidDir: 1, input: { throttle: 0, brake: 0, steer: 0, handbrake: false } };
  onAutoDrive?: (on: boolean) => void;
  /** Opens the mission briefing (set by the UI). */
  onBriefing?: () => void;
  private dust: Dust;
  private tracks: Tracks;
  private hud: Hud;
  private q: QualitySettings;
  autoQuality: boolean;
  cameraMode: CameraMode = 'cabin';
  private evaCam: EvaCamera | null = null;
  /** Watches every frame and sheds load at the first signs of stutter. */
  readonly governor = new LoadGovernor();
  /** CPU time of the previous frame (update + draw submission), s. */
  private cpuLast = 0;
  private parkedLrv: { x: number; z: number; yaw: number } | null = null;
  /** The void under a skylight (Pavonis Mons), if this site has one. */
  private cave: Cave | null = null;
  /** Eye/camera adaptation to the dark of a cave, 1 = daylight. */
  private caveAdapt = 1;
  private caveMeter = 1;
  private wallWarnAt = 0;
  private meterTick = 0;
  /** Small solid hardware (flag pole, ALSEP instruments): circles for the astronaut. */
  private solids: { x: number; z: number; r: number }[] = [];
  private baseFov = 68;
  /** Show the full HTML instrument overlay even in the cab. */
  hudOverlay = false;
  constellationsOn = false;
  private composer: EffectComposer | null = null;
  private topHeight = 70;
  private far: FarTerrain | null = null;
  private detail: DetailTiles | null = null;
  /** Baked sun-shadow mask on the CPU (500²), to place impact flashes in the dark. */
  private shadowMask: Uint8Array | null = null;
  private flashTimer = 8;
  paused = true;

  private look = { yaw: 0, pitch: -0.12 };
  private orbit = { yaw: 0, pitch: 0.28, dist: 9 };
  private chasePos = new THREE.Vector3();
  private cabQ = new THREE.Quaternion(0, 0, 0, 0);
  private cabY = Number.NaN;
  /** Camera shake from wheel and chassis blows (damped spring, felt in the seat). */
  private shake = { a: 0, t: 0, ph: 0 };
  private clock = new THREE.Timer();
  private fpsAcc = { t: 0, n: 0, fps: 60 };
  private sunTexel = 1;
  /** Fixed camera for reference shots (tools/shots.mjs): position, azimuth/pitch in degrees, fov. */
  debugCam: { x: number; z: number; h: number; az: number; pitch: number; fov: number } | null = null;
  onQualityChange?: (q: QualitySettings) => void;

  constructor(
    container: HTMLElement,
    private terrain: TerrainData,
    private physics: Physics,
    ortho: THREE.Texture,
    baked: THREE.Texture,
    quality: QualitySettings,
    auto: boolean,
    extras: GameExtras,
    spec: RoverSpec,
    weatherMode: WeatherMode = 'auto',
  ) {
    const W = world();
    const mars = W.id === 'mars';
    // The site's own moment (terrain.json "epoch": start of the first moonwalk).
    const epoch = Date.parse(terrain.meta.epoch ?? '');
    this.simTime = Number.isFinite(epoch) ? epoch : APOLLO15_EVA1;
    setSurfacePhotometry(W.id, W.radius);
    this.q = quality;
    this.autoQuality = auto;
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile || window.devicePixelRatio < 2, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(isMobile ? 75 : 68, container.clientWidth / container.clientHeight, 0.08, 60000);
    this.baseFov = this.camera.fov;

    if (mars) {
      // Mars: dusty sky, haze, sunlight reduced to 38 % (1.63 AU) and attenuated by dust.
      this.marsSky = new MarsSky(terrain.meta.sun.azimuth, terrain.meta.sun.elevation);
      this.scene.add(this.marsSky.mesh);
      this.marsNight = new MarsNight(extras.starsIcrf);
      this.scene.add(this.marsNight.group);
      this.sunDir = this.marsSky.sunDir;
      this.scene.fog = new THREE.FogExp2(0x9a6a48, 6.5e-5);
    } else {
      // --- Moon: one hard sun, no sky light. Shadows are filled only by light
      // bounced off sunlit regolith (albedo ~0.12) — modelled as a hemisphere light
      // that reaches surfaces facing down/sideways — and by faint earthshine.
      const l0 = this.lunarSite();
      const m0 = lunarSky(this.simTime, l0.lat, l0.lon).icrfToGame;
      const icrfToGame0 = new THREE.Matrix4().set(m0[0][0], m0[0][1], m0[0][2], 0, m0[1][0], m0[1][1], m0[1][2], 0, m0[2][0], m0[2][1], m0[2][2], 0, 0, 0, 0, 1);
      this.sky = new Sky(terrain.meta.sun.azimuth, terrain.meta.sun.elevation, quality.stars, terrain.meta.earth, extras.stars, {
        constellations: extras.constellations,
        galaxy: terrain.meta.galaxy,
        icrfToGame0,
      });
      this.scene.add(this.sky.group);
      this.sunDir = this.sky.sunDir;
    }
    // Sunlight above an atmosphere is white (≈ 5800 K); Mars reddens it in updateAtmosphere.
    this.sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.scene.add(this.sun, this.sun.target);
    this.configureShadow();
    // Fill from the sunlit landscape, estimated physically: regolith albedo ~0.12;
    // an upward-facing surface in shadow sees lit terrain only near its horizon
    // (~2 % of direct flat-ground irradiance), walls and undersides see much more.
    const lin = (v: number, warm = 1) => new THREE.Color().setRGB(v * warm, v, v * (2 - warm));
    this.hemi = new THREE.HemisphereLight(lin(0.05, 1.02), lin(0.16, 1.04), 1);
    this.scene.add(this.hemi);
    this.scene.environment = this.buildEnvironment();
    if (this.sky) {
      const earthshine = new THREE.DirectionalLight(0xbcd4ff, SUN_INTENSITY * 0.0015);
      earthshine.position.copy(this.sky.earthDir);
      this.scene.add(earthshine);
      this.earthshine = earthshine;
    }

    this.shadowMask = this.readMask(baked);
    this.terrainR = new TerrainRenderer(terrain, ortho, baked, quality, extras.farShadow, extras.farAlbedo);
    this.scene.add(this.terrainR.group);
    if (terrain.meta.detail && quality.level !== 'low') {
      this.detail = new DetailTiles(this.renderer, terrain, `${import.meta.env.BASE_URL}${site().dataDir}`);
      this.terrainR.setDetail(this.detail.texture, this.detail.rect, this.detail.slots, terrain.meta.detail.res, !!terrain.meta.detail.slopes, this.detail.fade);
    }
    this.terrainR.setSun(this.sunDir);
    // Terrain shadows follow the Sun: recomputed on the GPU (see ShadowBaker) - on the
    // Moon and, now that its Sun moves through the sol, on Mars.
    this.baker = new ShadowBaker(this.renderer, terrain, isMobile, quality.level === 'high' || quality.level === 'ultra');
    this.baker.setSun(this.sunDir, true);
    this.baker.bakeAll();
    this.terrainR.setShadowMaps(this.baker.near.texture, this.baker.far?.texture ?? null);
    if (!mars) {
      const l = this.lunarSite();
      const m0 = lunarSky(this.simTime, l.lat, l.lon).icrfToGame;
      this.starFrame0.set(m0[0][0], m0[0][1], m0[0][2], 0, m0[1][0], m0[1][1], m0[1][2], 0, m0[2][0], m0[2][1], m0[2][2], 0, 0, 0, 0, 1);
      this.envSun.copy(this.sunDir);
    }
    if (terrain.far) {
      this.far = new FarTerrain(terrain, extras.farShadow, isMobile, extras.farAlbedo, ortho);
      if (this.baker?.far) this.far.setShadowMap(this.baker.far.texture);
      this.far.setNearRadius(quality.drawDistance - 250);
      this.scene.add(this.far.mesh);
    }
    this.rocks = new Rocks(terrain, physics, quality, extras.rockPhoto);
    this.scene.add(this.rocks.group);

    // Moon: start ~45 m west of the LM, facing the rille (west).
    // Mars: at Octavia E. Butler Landing, facing the delta front (west).
    const [startX, startZ] = this.startPoint();
    if (!mars) {
      this.addLunarModule(terrain.meta.landing.x, terrain.meta.landing.z);
      this.addApolloHardware();
    }
    physics.updatePatch(startX, startZ, true);
    this.rover = this.makeRover(spec.heli ? ROVERS.perseverance : spec, startX, startZ, START_YAW);

    this.dust = new Dust(terrain, quality.dustParticles);
    this.scene.add(this.dust.mesh);
    this.tracks = new Tracks(terrain, spec, this.sunDir);
    this.scene.add(this.tracks.mesh);
    this.hud = new Hud(terrain);
    this.hud.siteLabel = site().id === 'pavonis' || site().id === 'gale' ? t('siteStart') : mars ? 'M2020' : 'LM';
    // A skylight into a cave (Pavonis Mons): the void below, and no ground drawn in the throat.
    // Apollo 17 station 4: the orange soil on Shorty's rim, a few metres from the station mark.
    if (site().id === 'apollo17' && terrain.meta.sites?.st4) {
      const s4 = terrain.meta.sites.st4;
      this.terrainR.uniforms.uOrange.value.set(s4.x + 3, s4.z + 2, 0.6, 1);
    }
    const caveMeta = (terrain.meta as { cave?: CaveMeta }).cave;
    if (caveMeta) {
      this.cave = new Cave(caveMeta);
      // The bone-like formation deep in the tube is a journal site too.
      const sites = (terrain.meta.sites ??= {}) as Record<string, { x: number; z: number }>;
      sites.bones = this.cave.bonesSite();
      this.scene.add(this.cave.group);
      this.terrainR.uniforms.uHole.value.set(caveMeta.x, caveMeta.z, caveMeta.rimY, Math.max(...caveMeta.holeR) + 1);
    }
    if (mars) {
      const lvl = quality.level === 'low' ? 0.35 : quality.level === 'medium' ? 0.6 : 1;
      this.weather = new MarsWeather(terrain, this.sunDir, lvl);
      this.weather.setMode(weatherMode);
      // Lightning in a storm front: a direct hit damages the electronics (a reason to
      // keep out of a front's way); a near miss now and then too.
      this.weather.onStrike = (_x, _z, dist) => {
        const r = this.rover;
        this.shake.a = Math.min(0.05, this.shake.a + 0.4 / Math.max(dist, 4));
        if (this.heli) return;
        if (dist < 12) {
          r.electronics = Math.min(1, r.electronics + 0.15 + Math.random() * 0.3);
          r.stall = 2 + Math.random() * 2;
          this.toast(t('strikeHit'));
        } else if (dist < 40 && Math.random() < 0.3) {
          r.electronics = Math.min(1, r.electronics + 0.05);
          this.toast(t('strikeNear'));
        }
      };
      this.scene.add(this.weather.group);
      this.updateAtmosphere(0);
    }
    if (ortho.image) this.hud.setMapImage(ortho.image as CanvasImageSource);

    this.radio = new Radio(() => this.audio.output);
    if (!mars) {
      this.meteors = new Meteors(terrain);
      this.scene.add(this.meteors.points, this.meteors.streaks, this.meteors.heads);
      // Craters made by earlier impacts stay (saved in the browser).
      const craterKey = site().id === 'apollo15' ? 'moon-craters' : `moon-craters-${site().id}`;
      try {
        const saved = JSON.parse(localStorage.getItem(craterKey) ?? '[]') as number[][];
        for (const [x, z, r] of saved) {
          terrain.newCraters.push(x, z, r);
          this.terrainR.addCrater(x, z, r);
        }
      } catch {
        /* storage unavailable */
      }
      this.meteors.onImpact = (x, z, r, dist) => {
        terrain.newCraters.push(x, z, r);
        this.terrainR.addCrater(x, z, r);
        try {
          const saved = JSON.parse(localStorage.getItem(craterKey) ?? '[]') as number[][];
          saved.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(r * 100) / 100]);
          localStorage.setItem(craterKey, JSON.stringify(saved.slice(-60)));
        } catch {
          /* storage unavailable */
        }
        const p = this.rover.object.position;
        if (Math.abs(x - p.x) < 70 && Math.abs(z - p.z) < 70) this.physics.updatePatch(p.x, p.z, true);
        this.sky?.impactFlash(this.scene, new THREE.Vector3(x, terrain.height(x, z) + 0.5, z), dist, 2 + r * 0.4);
        // No sound through vacuum; a close impact is felt through the ground.
        if (dist < 400) this.shake.a = Math.min(0.06, this.shake.a + (r / Math.max(dist, 20)) * 0.6);
        this.radio.say(r > 4 ? 'impactBig' : 'impact', { repeat: true, delay: 1 });
      };
    }
    this.finds = new Discoveries(terrain);
    // Houston comments on finds on the Moon (1.3 light-seconds away), not on Mars.
    this.finds.onFound = (site) => (mars ? this.toast(t(`site_${site.id}`)) : this.radio.say(`find_${site.id}`, { delay: 0.5 }));
    this.setMission(spec.heli ? this.heliMission() : this.groundMission());
    if (spec.heli) this.enterHeli();
    this.input.onAction((a) => this.onAction(a));
    this.bindLook(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
    this.setupComposer();
    this.resize();
    this.rover.sync(0);
    this.updateCamera(0);
    this.terrainR.update(this.camera.position, this.rover.object.position);
    this.rocks.update(this.rover.object.position);
  }

  get quality(): QualitySettings {
    return this.q;
  }

  /** Ready to play: nearby terrain chunks built. */
  isReady(): boolean {
    this.terrainR.update(this.camera.position, this.rover.object.position);
    return this.terrainR.readyAt(this.rover.object.position.x, this.rover.object.position.z) && this.terrainR.pendingCount() < 3;
  }

  private startPoint(): [number, number] {
    const l = this.terrain.meta.landing;
    return world().id === 'mars' ? [l.x - 6, l.z + 4] : [l.x - 45, l.z + 10];
  }

  private makeRover(spec: RoverSpec, x: number, z: number, yaw: number): Rover {
    this.physics.updatePatch(x, z, true);
    const r = new Rover(this.physics, this.terrain, this.sunDir, x, z, yaw, spec);
    this.scene.add(r.object);
    r.isRock = (c) => this.rocks.sizeOf(c);
    r.setHeadlights(false);
    // Camera distances scale with the rover (Sojourner is 65 cm long, Curiosity 3 m).
    const len = Math.max(...spec.wheels.map((w) => Math.abs(w[1]))) * 2 + spec.wheelRadius * 2;
    this.sizeK = THREE.MathUtils.clamp(len / 3.3, 0.18, 1.2);
    this.orbit.dist = 9 * this.sizeK;
    return r;
  }

  /** Ingenuity on its airfield ~15 m from the parked rover (Perseverance watched every flight). */
  private enterHeli(): void {
    if (this.heli) return;
    const r = this.rover.object.position;
    const f = this.rover.forwardVector(new THREE.Vector3());
    // An airfield on flat ground: ahead of the rover if it is level there, else to a
    // side or behind (not on the slope of a funnel, nor over its opening).
    let px = r.x + f.x * 14 + f.z * 4, pz = r.z + f.z * 14 - f.x * 4;
    const n = [0, 1, 0];
    for (const [a, s] of [[14, 4], [6, 12], [6, -12], [-12, 4], [-12, -6]]) {
      const x = r.x + f.x * a + f.z * s, z = r.z + f.z * a - f.x * s;
      this.terrain.normal(x, z, n, 3);
      // Over the opening the ground (seen from above) is below the rim and inside the cave.
      const inHole = this.cave ? this.cave.contains(new THREE.Vector3(x, this.terrain.height(x, z) - 0.5, z)) : false;
      if (n[1] > Math.cos(THREE.MathUtils.degToRad(8)) && !inHole) {
        px = x;
        pz = z;
        break;
      }
    }
    const w = this.weather;
    const zero = new THREE.Vector3();
    this.heli = new Helicopter(this.terrain, px, pz, () => (w ? w.wind : zero));
    const cave = this.cave;
    if (cave) this.heli.groundAt = (x, z, y) => cave.groundAt(x, z, y) ?? this.terrain.height(x, z);
    this.heli.yaw = Math.atan2(f.x, f.z);
    this.scene.add(this.heli.object, this.heli.dustObject);
    this.rover.parkBrake = true;
    this.input.heliMode = true;
    this.audio.setRoverMuted(true);
    this.heliHud = document.getElementById('heli-hud');
    this.heliHud?.classList.remove('hidden');
    document.body.classList.add('heli');
    this.chasePos.set(0, 0, 0);
    this.orbit.dist = 4;
    this.orbit.pitch = 0.35;
    this.cameraMode = 'chase';
    this.setMission(this.heliMission());
  }

  private exitHeli(): void {
    if (!this.heli) return;
    this.scene.remove(this.heli.object, this.heli.dustObject);
    this.heli.dispose();
    this.heli = null;
    this.input.heliMode = false;
    this.audio.setRoverMuted(false);
    this.rover.parkBrake = false;
    this.heliHud?.classList.add('hidden');
    document.body.classList.remove('heli');
    if (this.roverMark) this.roverMark.style.display = 'none';
    this.setMission(this.groundMission());
    this.orbit.dist = 9 * this.sizeK;
  }

  /**
   * EVA (E): an astronaut climbs off a stopped crewed rover - when the battery is
   * flat or the rover is stuck, the target can still be reached on foot - and gets
   * back on within a few metres of it.
   */
  /**
   * Mars: Perseverance carried Ingenuity under its belly - E sets it down on flat ground
   * near the rover, and takes it back once it has landed.
   */
  private toggleIngenuity(): void {
    if (!this.heli) {
      if (this.rover.spec.id !== 'perseverance') {
        this.toast(t('heliNoRover'));
        return;
      }
      if (Math.abs(this.rover.speed) > 0.4) {
        this.toast(t('evaMoving'));
        return;
      }
      this.enterHeli();
      this.toast(t('heliOut'));
      return;
    }
    if (this.heli.phase !== 'landed') {
      this.toast(t('heliLandFirst'));
      return;
    }
    this.exitHeli();
    this.toast(t('heliIn'));
  }

  toggleEva(): void {
    if (world().id === 'mars') {
      this.toggleIngenuity();
      return;
    }
    if (this.eva) {
      const r = this.rover.object.position;
      if (Math.hypot(this.eva.pos.x - r.x, this.eva.pos.z - r.z) > 4) {
        this.toast(t('evaFar'));
        return;
      }
      this.exitEva();
      this.toast(t('evaIn'));
      return;
    }
    if (world().id !== 'moon' || !this.rover.spec.crew || this.heli) {
      this.toast(t('evaNoCrew'));
      return;
    }
    if (Math.abs(this.rover.speed) > 0.4) {
      this.toast(t('evaMoving'));
      return;
    }
    this.setAutoDrive(false);
    const r = this.rover.object.position, f = this.rover.forwardVector(new THREE.Vector3());
    // Out on the left side (the commander's seat), facing where the rover faces.
    const x = r.x + f.z * 1.6, z = r.z - f.x * 1.6;
    const ground = (gx: number, gz: number) => Math.max(this.terrain.height(gx, gz), this.rocks.surfaceAt(gx, gz));
    this.eva = new Astronaut(this.terrain, ground, x, z, Math.atan2(f.x, f.z), (px, pz, br) => this.hardwareAt(px, pz, br));
    if (!this.footprints) {
      this.footprints = new Footprints(this.terrain, this.sunDir, 0.5 / world().radius);
      this.scene.add(this.footprints.mesh);
    }
    const fp = this.footprints;
    this.eva.onStep = (lx, lz, yaw, v, side) => {
      // On a rock top there is no soil to print.
      if (this.rocks.surfaceAt(lx, lz) >= this.terrain.height(lx, lz) + 0.02) return;
      if (side === 0) fp.land(lx, lz, yaw, v);
      else fp.step(lx, lz, yaw, v);
    };
    this.scene.add(this.eva.object);
    this.rover.parkBrake = true;
    this.heliHud = document.getElementById('heli-hud');
    this.heliHud?.classList.remove('hidden');
    document.body.classList.add('eva');
    this.chasePos.set(0, 0, 0);
    this.orbit.dist = 4.5;
    this.orbit.pitch = 0.3;
    if (this.cameraMode !== 'chase') this.setCameraMode('chase');
    (this.evaCam ??= new EvaCamera(this.terrain)).start(this.eva);
    this.toast(t('evaOut'));
    if (this.sky) this.radio.say('evaOut', { delay: 1 });
  }

  /**
   * Hardware an astronaut cannot walk through: the LM descent stage (~4.3 m across)
   * and its four footpads, the rover just left (its frame and wheels, 3.1 × 2.1 m) and
   * the parked LRV.
   */
  private hardwareAt(x: number, z: number, r: number): boolean {
    const lm = this.terrain.meta.landing;
    if (world().id === 'moon' && lm) {
      const dx = x - lm.x, dz = z - lm.z;
      if (Math.hypot(dx, dz) < 2.2 + r) return true;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        if (Math.hypot(dx - Math.cos(a) * 4.4, dz - Math.sin(a) * 4.4) < 0.5 + r) return true;
      }
    }
    const box = (cx: number, cz: number, yaw: number, hw: number, hl: number) => {
      const dx = x - cx, dz = z - cz, c = Math.cos(yaw), s = Math.sin(yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c; // into the box frame (+z forward)
      return Math.abs(lx) < hw + r && Math.abs(lz) < hl + r;
    };
    const rp = this.rover.object.position, f = this.rover.forwardVector(new THREE.Vector3());
    const half = this.rover.spec.wheels.reduce((m, w) => Math.max(m, Math.abs(w[1])), 0) + this.rover.spec.wheelRadius;
    const halfW = this.rover.spec.wheels.reduce((m, w) => Math.max(m, Math.abs(w[0])), 0) + 0.1;
    if (box(rp.x, rp.z, Math.atan2(f.x, f.z), halfW, half)) return true;
    for (const o of this.solids) if (Math.hypot(x - o.x, z - o.z) < o.r + r) return true;
    const lrv = this.parkedLrv;
    return !!lrv && box(lrv.x, lrv.z, lrv.yaw, 1.0, 1.5);
  }

  private exitEva(): void {
    if (this.cameraMode === 'partner' || this.cameraMode === 'tv') this.setCameraMode('chase');
    this.camera.fov = this.baseFov;
    if (!this.eva) return;
    this.scene.remove(this.eva.object);
    this.eva.dispose();
    this.eva = null;
    this.heliHud?.classList.add('hidden');
    document.body.classList.remove('eva');
    this.chasePos.set(0, 0, 0);
    this.orbit.dist = 9 * this.sizeK;
  }

  private updateO2(dt: number): void {
    if (world().id !== 'moon' || !this.rover.spec.crew) {
      this.hud.o2 = null;
      return;
    }
    const lm = this.terrain.meta.landing;
    const p = this.eva ? this.eva.pos : this.rover.object.position;
    const atLm = Math.hypot(p.x - lm.x, p.z - lm.z) < 20 && (this.eva ? this.eva.speed < 0.3 : Math.abs(this.rover.speed) < 0.2);
    const before = this.o2;
    if (atLm) this.o2 = Math.min(O2_FULL, this.o2 + dt * 120); // PLSS recharge in the LM
    else {
      // Metabolic rate: seated ~0.75 of the PLSS design average, standing 0.85, hopping up to 1.5.
      const rate = this.eva ? 0.85 + 0.65 * Math.min(1, this.eva.speed / 1.5) : 0.75;
      this.o2 = Math.max(0, this.o2 - dt * rate);
    }
    if (this.sky) {
      if (before > 3600 && this.o2 <= 3600) this.radio.say('o2Low', { repeat: true });
      if (before > O2_OPS && this.o2 <= O2_OPS) this.radio.say('o2Ops', { repeat: true });
    }
    if (this.o2 <= 0 && before > 0) {
      this.autoDrive = false;
      this.onFail?.('o2');
    }
    this.hud.o2 = this.o2;
  }

  private updateEvaHud(): void {
    const a = this.eva, el = this.heliHud;
    if (!a || !el) return;
    const r = this.rover.object.position;
    const d = Math.hypot(a.pos.x - r.x, a.pos.z - r.z);
    el.innerHTML =
      `<b>${t('evaTitle')}</b><br>` +
      `${t('evaSpeed')} <b>${(a.speed * 3.6).toFixed(1)}</b> ${t('evaKmh')} · ${t('evaToRover')} <b>${d.toFixed(0)}</b> ${t('hM')} · O₂ <b>${fmtHM(this.o2)}</b>` +
      `<div class="hk">${t(d < 4 ? 'evaKeysNear' : 'evaKeys')}</div>`;
  }

  /** Swap the rover in place (menu selection), keeping position and heading. */
  setRover(spec: RoverSpec): void {
    if (spec.heli) {
      if (this.rover.spec.id !== 'perseverance') this.setRover(ROVERS.perseverance);
      this.enterHeli();
      return;
    }
    this.exitHeli();
    const old = this.rover;
    const p = old.object.position.clone();
    const { heading } = old.attitude();
    const lights = old.headlights;
    old.dispose();
    this.rover = this.makeRover(spec, p.x, p.z, -THREE.MathUtils.degToRad(heading) + Math.PI);
    this.rover.setHeadlights(lights);
    this.tracks.setRover(spec);
    this.chasePos.set(0, 0, 0);
    this.look.yaw = 0;
    this.applyHudMode();
    this.updateCamera(0);
  }

  /**
   * Reflection environment for metals. Moon: black sky above the horizon, the
   * sunlit grey regolith below (brighter toward the antisolar point: opposition
   * surge). Mars: the dusty sky above, the ochre ground below.
   */
  private buildEnvironment(): THREE.Texture {
    const envScene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    if (this.marsSky) {
      const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), this.marsSky.mesh.material as THREE.Material);
      envScene.add(skyMesh);
      const ground = new THREE.Mesh(
        new THREE.SphereGeometry(9, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        // The lit ground below the horizon: as bright as the Sun makes it (black at night;
        // a constant here lit the rover and the far slopes from below in the dark).
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0.11, 0.065, 0.04).multiplyScalar(THREE.MathUtils.smoothstep(this.sunDir.y, -0.25, 0.3)), side: THREE.BackSide }),
      );
      envScene.add(ground);
      const rt = pmrem.fromScene(envScene, 0, 0.1, 100);
      pmrem.dispose();
      return rt.texture;
    }
    const anti = this.sunDir.clone().negate();
    anti.y = 0;
    anti.normalize();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uAnti: { value: anti } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vD; uniform vec3 uAnti;
        void main(){
          vec3 d = normalize(vD);
          float below = smoothstep(0.02, -0.04, d.y);
          float opp = pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), uAnti), 0.0), 6.0);
          float lit = 0.08 * (1.0 + 0.9 * opp) * (1.0 - 0.5 * smoothstep(-0.2, -1.0, d.y));
          gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * lit * below, 1.0);
        }`,
    });
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
    const rt = pmrem.fromScene(envScene, 0, 0.1, 100);
    pmrem.dispose();
    return rt.texture;
  }

  private setupComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    // Bloom (with MSAA in an HDR target) is the costliest pass: only on Ultra.
    if (this.q.level !== 'ultra') return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    // Lens bloom: only the sun disc and specular glints exceed the threshold.
    c.addPass(new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.22, 0.3, 2.2));
    c.addPass(new OutputPass());
    this.composer = c;
  }

  private configureShadow(): void {
    const s = this.sun.shadow;
    const r = this.q.shadowRange;
    s.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    s.camera.left = -r;
    s.camera.right = r;
    s.camera.top = r;
    s.camera.bottom = -r;
    s.camera.near = 10;
    s.camera.far = 4200;
    // Sun's angular diameter 0.53° gives a penumbra of ~1 cm per metre of
    // occluder distance: keep PCF filtering tight for hard lunar shadows.
    // Hard but anti-aliased: the solar disc's penumbra is ~1 cm per metre to the occluder.
    s.radius = 1.5;
    s.bias = -0.0002;
    s.normalBias = 0.015;
    s.camera.updateProjectionMatrix();
    if (s.map) {
      s.map.dispose();
      (s as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    this.sunTexel = (2 * r) / this.q.shadowMapSize;
  }

  private addLunarModule(x: number, z: number): void {
    // Falcon: the official NASA LM model, real size; a simple stand-in if it failed to load.
    const nasa = buildLunarModule();
    if (nasa) {
      nasa.position.set(x, this.terrain.height(x, z) - 0.1, z);
      // Falcon landed facing roughly west; the +Z hatch side of the model faces the rille.
      nasa.rotation.y = -Math.PI / 2;
      this.scene.add(nasa);
      // The flag where it was surveyed (Apollo 17), else ~10 m north-east of the LM.
      const flag = this.terrain.meta.sites?.flag;
      this.addFlag(flag ? flag.x : x + 8, flag ? flag.z : z - 6);
      // Solid like the real one: the descent stage from ~0.75 m up (struts compressed by the
      // landing; the LRV's console and seats at ~1.1 m would strike it)
      // landing) with the ascent stage above, the engine bell under it down to ~0.4 m,
      // the four primary struts from the body out to the footpads, the pads.
      const R = this.physics.R;
      const gy = this.terrain.height(x, z);
      this.physics.world.createCollider(R.ColliderDesc.cylinder(2.15, 2.15).setTranslation(x, gy + 2.9, z));
      this.physics.world.createCollider(R.ColliderDesc.cylinder(0.45, 0.8).setTranslation(x, gy + 0.85, z));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const px = x + Math.cos(a) * 4.4, pz = z + Math.sin(a) * 4.4, py = this.terrain.height(px, pz);
        this.physics.world.createCollider(R.ColliderDesc.ball(0.5).setTranslation(px, py + 0.3, pz));
        const top = new THREE.Vector3(x + Math.cos(a) * 2.0, gy + 1.9, z + Math.sin(a) * 2.0);
        const pad = new THREE.Vector3(px, py + 0.35, pz);
        const mid = top.clone().add(pad).multiplyScalar(0.5);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(pad).normalize());
        this.physics.world.createCollider(R.ColliderDesc.capsule(top.distanceTo(pad) / 2, 0.14).setTranslation(mid.x, mid.y, mid.z).setRotation(q));
      }
      return;
    }
    const g = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: 0xc89a3a, metalness: 1, roughness: 0.28 });
    const black = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.5 });
    const silver = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 1, roughness: 0.2 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 1.65, 8), gold);
    body.position.y = 1.9;
    g.add(body);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.12, 8), black);
    top.position.y = 2.78;
    g.add(top);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.2), silver);
      leg.position.set(Math.cos(a) * 2.8, 1.3, Math.sin(a) * 2.8);
      leg.lookAt(Math.cos(a) * 1.6, 2.6, Math.sin(a) * 1.6);
      leg.rotateX(Math.PI / 2);
      g.add(leg);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.12, 16), silver);
      pad.position.set(Math.cos(a) * 3.9, 0.06, Math.sin(a) * 3.9);
      g.add(pad);
    }
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.0, 20, 1, true), black);
    nozzle.position.y = 0.75;
    g.add(nozzle);
    // Flag.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2.4), silver);
    pole.position.set(6, 1.2, 3);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.75), new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(6.6, 2.0, 3);
    g.add(flag);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    g.position.set(x, this.terrain.height(x, z) - 0.15, z);
    this.scene.add(g);
    const R = this.physics.R;
    this.physics.world.createCollider(R.ColliderDesc.cylinder(1.3, 2.2).setTranslation(x, g.position.y + 1.6, z));
  }

  /** The flag planted ~10 m north-east of the LM (aluminium pole, nylon flag on a top bar). */
  private addFlag(x: number, z: number): void {
    // The pole is solid (2.4 m, driven ~20 cm into the regolith).
    const R = this.physics.R;
    this.physics.world.createCollider(R.ColliderDesc.cylinder(1.2, 0.05).setTranslation(x, this.terrain.height(x, z) + 1.2, z));
    this.solids.push({ x, z, r: 0.05 });
    const g = new THREE.Group();
    const pole = new THREE.MeshStandardMaterial({ color: 0xd6d8da, metalness: 0.9, roughness: 0.3 });
    const c = document.createElement('canvas');
    c.width = 380;
    c.height = 200;
    const k = c.getContext('2d')!;
    for (let i = 0; i < 13; i++) {
      k.fillStyle = i % 2 ? '#f3f1ea' : '#b2263a';
      k.fillRect(0, (i * 200) / 13, 380, 200 / 13 + 1);
    }
    k.fillStyle = '#2b3a6b';
    k.fillRect(0, 0, 152, 108);
    k.fillStyle = '#f3f1ea';
    for (let r = 0; r < 9; r++) for (let q = 0; q < (r % 2 ? 5 : 6); q++) k.fillRect(10 + q * 25 + (r % 2 ? 12 : 0), 8 + r * 11, 3, 3);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const flagGeo = new THREE.PlaneGeometry(1.5, 0.9, 16, 4);
    // Permanent ripples: the flag was never fully unfurled (no air to straighten it).
    const pa = flagGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) pa.setZ(i, Math.sin(pa.getX(i) * 6) * 0.04 * (pa.getX(i) + 0.75));
    flagGeo.computeVertexNormals();
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.85 }));
    flag.position.set(0.76, 2.0, 0);
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 2.55), pole).translateY(1.2));
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.55), pole);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0.76, 2.45, 0);
    g.add(bar);
    g.add(flag);
    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    g.position.set(x, this.terrain.height(x, z) - 0.15, z);
    g.rotation.y = 0.5;
    this.scene.add(g);
  }

  private bindLook(el: HTMLElement): void {
    let id: number | null = null;
    let lx = 0, ly = 0;
    el.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = (e.clientX - lx) * 0.005, dy = (e.clientY - ly) * 0.005;
      lx = e.clientX;
      ly = e.clientY;
      if (this.cameraMode === 'top') {
        this.orbit.yaw -= dx;
      } else if (this.cameraMode === 'cabin') {
        this.look.yaw = THREE.MathUtils.clamp(this.look.yaw - dx, -2.4, 2.4);
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch - dy, -1.0, 1.2);
      } else {
        this.orbit.yaw -= dx;
        this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy, -0.1, 1.3);
      }
    });
    const end = (e: PointerEvent) => { if (e.pointerId === id) id = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => { this.look.yaw = 0; this.look.pitch = -0.12; this.orbit.yaw = 0; });
    el.addEventListener('wheel', (e) => {
      this.zoom(Math.sign(e.deltaY));
    }, { passive: true });
  }

  /** Zoom the chase/top camera: +1 = out, -1 = in. */
  zoom(dir: number): void {
    if (this.cameraMode === 'chase') this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * (1 + dir * 0.12), 4 * this.sizeK, 60 * this.sizeK);
    else if (this.cameraMode === 'top') this.topHeight = THREE.MathUtils.clamp(this.topHeight * (1 + dir * 0.15), 12, 1500);
  }

  setCameraMode(m: CameraMode): void {
    this.cameraMode = m;
    this.audio.setCabin(m === 'cabin');
    this.chasePos.set(0, 0, 0);
    this.applyHudMode();
  }

  applyHudMode(): void {
    // The 3D console replaces the HTML instruments only on the LRV (robots are driven through their cameras).
    document.body.classList.toggle('cab', this.cameraMode === 'cabin' && !this.hudOverlay && !isMobile && !!this.rover?.model.panel);
  }

  onAction(a: string): void {
    if (a === 'pause') return; // handled by UI
    if (this.paused) return;
    if (a === 'camera') {
      const cycle = this.eva ? EVA_CYCLE : CAMERA_CYCLE;
      this.setCameraMode(cycle[(cycle.indexOf(this.cameraMode) + 1) % cycle.length]);
      if (this.eva) this.toast(t(`evaCam_${this.cameraMode}`));
      this.audio.click(1800);
    } else if (a === 'top') {
      this.setCameraMode(this.cameraMode === 'top' ? 'cabin' : 'top');
      this.audio.click(1800);
    } else if (a === 'park') {
      this.rover.parkBrake = !this.rover.parkBrake;
      this.audio.click(700);
    } else if (a === 'const') {
      this.constellationsOn = this.sky?.toggleConstellations() ?? false;
    } else if (a === 'daytime') {
      // Mars: on to the next part of the sol (day -> sunset -> night -> dawn -> day).
      if (this.marsSky) {
        const order = [15, 17.6, 22, 5.6];
        const now = this.marsLtst;
        const next = order.find((h) => ((h - now + 24) % 24) > 0.3 && ((h - now + 24) % 24) <= 9) ?? order[0];
        this.setMarsLtst(next);
        this.toast(t(next === 15 ? 'tDay' : next === 17.6 ? 'tSunset' : next === 22 ? 'tNight' : 'tDawn'));
        this.audio.click(1000);
      }
    } else if (a === 'weather') {
      if (this.weather) {
        this.weather.cycle();
        this.onWeatherChange?.(this.weather.mode);
        this.audio.click(1200);
      }
    } else if (a === 'hud') {
      this.hudOverlay = !this.hudOverlay;
      this.applyHudMode();
    } else if (a === 'zoomin') {
      this.zoom(-1);
    } else if (a === 'zoomout') {
      this.zoom(1);
    } else if (a === 'drive') {
      this.setAutoDrive(!this.autoDrive);
    } else if (a === 'eva') {
      this.toggleEva();
    } else if (a === 'mission') {
      this.onBriefing?.();
    } else if (a === 'photo') {
      this.takePhoto();
    } else if (a === 'brush') {
      this.rover.brushDust();
      this.audio.click(500);
    } else if (a === 'auto') {
      this.heli?.startAuto();
      this.audio.click(1500);
    } else if (a === 'reset' && this.heli) {
      this.heli.reset();
      this.audio.click(900);
    } else if (a === 'reset') {
      this.rover.reset();
      this.audio.click(900);
    } else if (a === 'lights') {
      this.rover.setHeadlights(!this.rover.headlights);
      this.audio.click(2600);
    }
  }

  setQuality(level: QualityLevel, auto: boolean): void {
    this.autoQuality = auto;
    this.q = makeQuality(level);
    if (!auto) this.drs.scale = 1;
    this.renderer.setPixelRatio(this.q.pixelRatio * this.drs.scale);
    this.configureShadow();
    this.setupComposer();
    this.terrainR.setQuality(this.q);
    this.far?.setNearRadius(this.q.drawDistance - 250);
    this.rocks.setQuality(this.q);
    this.rocks.update(this.rover.object.position);
    this.resize();
    this.onQualityChange?.(this.q);
  }

  resize(): void {
    const c = this.renderer.domElement.parentElement!;
    const w = c.clientWidth, h = c.clientHeight;
    this.renderer.setSize(w, h);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.weather?.sand.setViewport(h);
  }

  start(): void {
    this.paused = false;
    this.clock.update();
    this.setCameraMode(this.cameraMode);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  onWeatherChange?: (m: WeatherMode) => void;

  setWeather(m: WeatherMode): void {
    this.weather?.setMode(m);
  }

  private menuOpen = false;
  private idleTick = 0;
  /**
   * The menu is open: the live background is rendered at 60 % resolution and
   * 30 fps (it sits behind the blurred menu), leaving the GPU to the menu itself
   * and the rover previews.
   */
  setMenuOpen(open: boolean): void {
    if (open === this.menuOpen) return;
    this.menuOpen = open;
    this.renderer.setPixelRatio(this.q.pixelRatio * this.drs.scale * (open ? 0.6 : 1));
    this.resize();
  }

  /** Title screen / pause: keep the world alive (sky, weather, moving parts) without driving. */
  idleFrame(): void {
    if (this.menuOpen && (this.idleTick++ & 1)) return;
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;
    this.rover.sync(0);
    this.animateRover(dt, true);
    this.updateCamera(dt);
    this.updateEnvironment(dt);
    this.render();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) this.audio.suspend();
    else {
      this.audio.resume();
      this.clock.update();
    }
  }

  private frame(): void {
    const cpu0 = performance.now();
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.paused) {
      if (this.menuOpen && (this.idleTick++ & 1)) return;
      this.time += dt;
      this.animateRover(dt, true);
      this.updateEnvironment(dt);
      this.render();
      return;
    }
    this.time += dt;
    this.input.update(dt);
    const rover = this.rover;
    const parkedInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    const drive = this.heli || this.eva ? parkedInput : this.autoDrive ? this.autopilot(dt) : this.input.drive;
    const alpha = this.physics.step(dt, (h) => rover.step(h, drive));
    if (this.heli) {
      const d = this.input.drive;
      this.heli.attachAudio(this.audio.output);
      // The solar panel needs the Sun: none at night, in a cave, under the pit's rim.
      const sunUp = THREE.MathUtils.smoothstep(this.sunDir.y, 0.02, 0.15);
      this.heli.sunlight = sunUp * (this.cave ? this.cave.lightAt(this.heli.pos, this.sunDir).sun : 1);
      this.heli.update(dt, { fwd: d.throttle - d.brake, yaw: d.steer, lift: this.input.lift }, true);
      // Under the cave roof the helicopter cannot climb through the rock.
      const hp = this.heli.pos;
      if (this.cave?.contains(hp) || (this.cave && this.cave.depth(hp) > 0)) {
        // The rock is solid: a touch pushes back, a knock (> ~1.2 m/s) breaks the rotor
        // blades (carbon fibre, 1.2 m across) and Ingenuity drops. Warn when close.
        const hit = this.cave.collide(hp, this.heli.vel, 0.75);
        if (hit.impact > 1.2 && this.heli.phase !== 'crashed' && this.heli.phase !== 'landed') {
          this.heli.crash('heliWall');
          this.toast(t('heliWall'));
        } else if (hit.clearance < 2.5 && this.heli.phase !== 'crashed' && this.heli.phase !== 'landed' && performance.now() - this.wallWarnAt > 2500) {
          this.wallWarnAt = performance.now();
          this.toast(t('heliWallNear'));
        }
      }
      this.heli.setListener(this.camera.position.distanceTo(this.heli.pos));
      this.updateHeliHud();
    }
    if (this.eva) {
      const d = this.input.drive;
      this.eva.update(dt, { fwd: d.throttle - d.brake, turn: d.steer, jump: d.handbrake });
      this.updateEvaHud();
    }
    rover.onContacts(this.physics.takeContacts());
    rover.sync(dt, alpha);
    this.animateRover(dt, false);
    this.updatePanel(dt);
    const p = rover.object.position;
    this.physics.updatePatch(p.x, p.z);
    // Where the player is: the rover, the helicopter or the astronaut on foot.
    const fp = this.heli ? this.heli.pos : this.eva ? this.eva.pos : p;
    this.rocks.update(fp);
    this.updateCamera(dt);
    this.terrainR.update(this.camera.position, fp);
    this.detail?.update(fp.x, fp.z);
    this.detail?.tick(dt);
    this.dust.update(dt, rover, this.camera);
    this.tracks.update(rover, dt);
    this.updateEnvironment(dt);
    this.updateSun(fp);
    this.updateImpacts(dt);
    if (this.meteors) this.meteors.update(dt, fp, this.camera);
    this.updateEnergy(dt);
    this.updateO2(dt);
    this.radio.update(dt);
    this.updateMission();
    this.updateCliff(dt);
    this.radioEvents();

    this.fpsAcc.t += dt;
    this.fpsAcc.n++;
    if (this.fpsAcc.t > 0.5) {
      this.fpsAcc.fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc.t = 0;
      this.fpsAcc.n = 0;
    }
    if (this.weather) {
      const w = this.weather;
      this.hud.weather = { wind: Math.hypot(w.wind.x, w.wind.z), tau: w.tau, storm: w.storm, devilDist: w.devilDist, devils: w.devilList() };
    }
    this.hud.focus = this.eva ? { pos: this.eva.pos, heading: this.eva.heading, speed: this.eva.speed } : null;
    this.hud.update(dt, rover, this.fpsAcc.fps);
    this.audio.update(dt, rover, this.input.drive.steer, this.hud.warningLevel);
    rover.knocks.length = 0;
    this.adaptQuality(dt);
    this.render();
    this.cpuLast = (performance.now() - cpu0) / 1000;
  }

  render(): void {
    // Eye/camera adaptation: with sunlit ground in view the faint stars wash out
    // (as on every Apollo photograph); looking up at the black sky they come back.
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const groundFrac = THREE.MathUtils.clamp(0.5 - pitch / vfov, 0, 1);
    // The Sun itself in the field of view blinds eye and film alike: no stars at all.
    const sunOff = Math.acos(THREE.MathUtils.clamp(fwd.dot(this.sunDir), -1, 1));
    const sunGlare = 1 - THREE.MathUtils.smoothstep(sunOff, vfov * 0.5, vfov * 0.5 + 0.35);
    this.sky?.setAdaptation((1 - 0.85 * THREE.MathUtils.smoothstep(groundFrac, 0.1, 0.65)) * (1 - 0.95 * sunGlare));
    // The visor mirrors the scene when the astronaut is seen up close (not from inside the helmet).
    const e = this.eva;
    if (e && this.cameraMode !== 'cabin' && this.q.level !== 'low' && this.governor.relief === 0 && this.camera.position.distanceTo(e.pos) < 25) {
      e.updateVisor(this.renderer, this.scene, (on) => this.sky?.hideFlare(on));
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Moving parts: masts follow the camera, arms deploy when parked, suspension links follow the wheels. */
  private animateRover(dt: number, idle: boolean): void {
    const r = this.rover;
    const moving = Math.abs(r.speed) > 0.03 || this.input.drive.throttle > 0.02 || this.input.drive.brake > 0.02;
    this.still = moving ? 0 : this.still + dt;
    const mast = this.cameraMode === 'cabin' && !r.spec.crew;
    r.model.animate({
      dt, time: this.time, speed: r.speed, steer: r.steerAngle,
      lookYaw: mast ? this.look.yaw : idle ? Math.sin(this.time * 0.2) * 0.8 : 0,
      lookPitch: mast ? this.look.pitch + 0.12 : idle ? -0.1 : 0,
      parked: idle || r.parkBrake || this.still > 3,
      wheelLocal: r.wheelLocal, preview: false,
    });
  }

  setAutoDrive(on: boolean, reason?: string): void {
    if (on && (this.heli || this.eva || !this.mission.target())) {
      this.toast(t(this.heli ? 'apNoHeli' : this.eva ? 'evaNoAuto' : 'apNoTarget'));
      on = false;
    }
    if (on === this.autoDrive && !reason) return;
    this.autoDrive = on;
    this.ap.stuck = 0;
    this.ap.avoid = 0;
    if (on) this.rover.parkBrake = false;
    this.audio.click(on ? 1700 : 900);
    this.toast(t(reason ?? (on ? 'apOn' : 'apOff')));
    this.onAutoDrive?.(on);
  }

  /**
   * Autopilot (like the rovers' AutoNav, much simplified): steer toward the mission
   * target, keep speed down on slopes and rough ground, turn away from slopes over 18°
   * ahead; any driver input takes over; no progress for 4 s means stuck - the driver
   * has to get it out (reverse, turn, rock it free).
   */
  private autopilot(dt: number): { throttle: number; brake: number; steer: number; handbrake: boolean } {
    const ap = this.ap, out = ap.input, r = this.rover, d = this.input.drive;
    if (d.throttle > 0.05 || d.brake > 0.05 || Math.abs(d.steer) > 0.15 || d.handbrake) {
      this.setAutoDrive(false, 'apManual');
      return d;
    }
    const tg = this.mission.target();
    const p = r.object.position;
    if (!tg || Math.hypot(tg.x - p.x, tg.z - p.z) < 6) {
      this.setAutoDrive(false, tg ? 'apArrived' : 'apNoTarget');
      return d;
    }
    const f = r.forwardVector(new THREE.Vector3());
    const hdg = Math.atan2(f.x, f.z);
    let want = Math.atan2(tg.x - p.x, tg.z - p.z);
    // Look ahead 6 m: too steep (or a cliff) -> veer off to one side for a while.
    const n = [0, 1, 0];
    this.terrain.normal(p.x + Math.sin(hdg) * 6, p.z + Math.cos(hdg) * 6, n, 1.5);
    const slopeAhead = (Math.acos(Math.min(1, n[1])) * 180) / Math.PI;
    if (slopeAhead > 18 && ap.avoid <= 0) {
      ap.avoid = 3;
      ap.avoidDir = Math.random() < 0.5 ? -1 : 1;
    }
    if (ap.avoid > 0) {
      ap.avoid -= dt;
      want = hdg + ap.avoidDir * 0.9;
    }
    let err = want - hdg;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    // Steering sign: positive input steers right (clockwise seen from above = -yaw here).
    out.steer = THREE.MathUtils.clamp(-err * 1.6, -1, 1);
    const { roll, pitch } = r.attitude();
    const rough = Math.max(Math.abs(roll), Math.abs(pitch));
    const turnSlow = 1 - 0.5 * Math.min(1, Math.abs(err) / 1.2);
    out.throttle = THREE.MathUtils.clamp(0.75 * turnSlow * (1 - THREE.MathUtils.smoothstep(rough, 8, 22) * 0.6), 0.2, 0.75);
    out.brake = 0;
    out.handbrake = false;
    // Stuck: commanding drive but hardly moving.
    if (Math.abs(r.speed) < 0.12) ap.stuck += dt;
    else ap.stuck = Math.max(0, ap.stuck - dt * 2);
    if (ap.stuck > 4) {
      this.setAutoDrive(false, 'apStuck');
      if (this.sky) this.radio.say('stuck', { repeat: true });
      return d;
    }
    return out;
  }

  /**
   * Real cliffs: the inner walls of Hadley Rille (slopes > 35°, ~30 m drops) and the
   * delta scarp / Kodiak on Mars. The terrain ahead is scanned for a steep drop and the
   * driver is warned; a fall (the rover losing more height than any drivable slope
   * allows) ends the mission - no one can recover a rover at the foot of a cliff.
   */
  private cliff = { t: 0, peakY: Number.NaN, warn: false, safe: new THREE.Vector3(), safeYaw: 0, safeT: 0, failed: false, last: new THREE.Vector3(Number.NaN, 0, 0) };
  /** Mission failed: reason 'o2' (out of oxygen) or undefined (fell off a cliff). */
  onFail?: (reason?: 'o2') => void;
  cliffAhead = false;

  private updateCliff(dt: number): void {
    const c = this.cliff, r = this.rover, p = r.object.position, t = this.terrain;
    if (this.heli || this.eva || c.failed) return;
    // Remember the last safe spot (flat, not near a drop) to restart from.
    c.safeT -= dt;
    // A jump in position (restart, reset, teleport) starts the height tracking afresh.
    if (!(c.last.distanceTo(p) < 5)) c.peakY = Number.NaN;
    c.last.copy(p);
    // Fall detection: allowed descent 2.2 m/s (any drivable slope at full speed).
    c.peakY = Number.isNaN(c.peakY) ? p.y : Math.max(p.y, c.peakY - 2.2 * dt);
    const { roll, pitch } = r.attitude();
    const n = [0, 1, 0];
    t.normal(p.x, p.z, n, 1.5);
    const slopeHere = (Math.acos(Math.min(1, n[1])) * 180) / Math.PI;
    if (c.peakY - p.y > 8 || (Math.max(Math.abs(roll), Math.abs(pitch)) > 75 && slopeHere > 28)) {
      c.failed = true;
      this.autoDrive = false;
      this.audio.click(300);
      if (this.sky) this.radio.say('fell', { repeat: true });
      this.onFail?.();
      return;
    }
    c.t -= dt;
    if (c.t > 0) return;
    c.t = 0.25;
    // Look ahead along the direction of travel (or the heading when slow).
    const f = r.forwardVector(new THREE.Vector3());
    const dir = r.speed < -0.2 ? -1 : 1;
    let ahead = false;
    const h0 = t.height(p.x, p.z);
    for (const d of [4, 8, 12, 16, 20]) {
      const x = p.x + f.x * d * dir, z = p.z + f.z * d * dir;
      t.normal(x, z, n, 1.5);
      const sl = (Math.acos(Math.min(1, n[1])) * 180) / Math.PI;
      const drop = h0 - t.height(x + f.x * 6 * dir, z + f.z * 6 * dir);
      if (sl > 33 && drop > 3) {
        ahead = true;
        break;
      }
    }
    if (!ahead && slopeHere < 12 && c.safeT <= 0) {
      c.safe.copy(p);
      c.safeYaw = -THREE.MathUtils.degToRad(r.attitude().heading) + Math.PI;
      c.safeT = 2;
    }
    if (ahead && !c.warn) {
      this.audio.click(2200);
      if (this.sky) this.radio.say('cliff', { repeat: true });
    }
    c.warn = ahead;
    this.cliffAhead = ahead;
    this.hud.cliff = ahead;
  }

  /** After a fall: back to the last safe spot on the rim (the mission continues). */
  recoverFromFall(): void {
    const c = this.cliff;
    const s = c.safe.lengthSq() > 0 ? c.safe : this.rover.object.position;
    this.physics.updatePatch(s.x, s.z, true);
    this.rover.placeAt(s.x, s.z, c.safeYaw);
    c.peakY = Number.NaN;
    c.failed = false;
    this.chasePos.set(0, 0, 0);
  }

  /** The helicopter mission of the current site (Pavonis: down into the skylight). */
  private heliMission(): MissionKind {
    return site().id === 'pavonis' ? 'pavonisHeli' : 'heli';
  }

  /** The rover mission of the current site. */
  private groundMission(): MissionKind {
    const id = site().id;
    return id === 'apollo17' ? 'moon17' : id === 'pavonis' ? 'pavonis' : id === 'gale' ? 'gale' : world().id === 'mars' ? 'mars' : 'moon';
  }

  setMission(kind: MissionKind): void {
    this.mission = new Missions(this.terrain, kind);
    this.mission.onStep = (key, finished) => {
      this.audio.click(1400);
      // Mars is 5–20 light-minutes away: no live voice loop there.
      if (this.sky) this.radio.say(finished ? 'missionDone' : 'nextStep', { repeat: true, delay: 0.3 });
      this.toast(finished ? t(`${this.mission.id}_done`) : `${t('newTask')}: ${t(key)}`);
    };
  }

  /** Short message in the middle of the screen. */
  toast(text: string): void {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden', 'go');
    void el.offsetWidth;
    el.classList.add('go');
  }

  private updateMission(): void {
    const h = this.heli;
    if (h) this.heliMaxDist = h.phase === 'landed' ? this.heliMaxDist : Math.max(this.heliMaxDist, Math.hypot(h.pos.x - h.pad.x, h.pos.z - h.pad.z));
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    let camHdg = (Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI;
    if (camHdg < 0) camHdg += 360;
    this.hud.target = this.mission.target();
    if (this.finds) this.hud.sites = this.finds.sites.map((st) => ({ x: st.x, z: st.z, found: this.finds!.found.has(st.id) }));
    this.mission.update({
      roverPos: h ? h.pos : this.eva ? this.eva.pos : this.rover.object.position,
      odometer: this.rover.odometer,
      found: this.finds?.found ?? new Set(),
      atBase: this.hud.atBase,
      heli: h ? { agl: h.agl, phase: h.phase, pos: h.pos, pad: h.pad, flights: h.flights, maxDist: this.heliMaxDist } : null,
    }, camHdg);
  }

  /** The parked LRV and the ALSEP at their surveyed positions. */
  private addApolloHardware(): void {
    const s = this.terrain.meta.sites;
    if (!s) return;
    const hw = this.terrain.meta.hardware;
    if (s.alsep) {
      const alsep = hw ? buildAlsep17(this.terrain, s.alsep.x, s.alsep.z, hw) : buildAlsep(this.terrain, s.alsep.x, s.alsep.z);
      this.scene.add(alsep);
      // Each instrument is solid for the rover and the astronaut.
      const R = this.physics.R;
      for (const o of alsep.userData.solids as Solid[]) {
        const ox = s.alsep.x + o.x, oz = s.alsep.z + o.z;
        this.physics.world.createCollider(R.ColliderDesc.cylinder(o.h / 2, o.r).setTranslation(ox, this.terrain.height(ox, oz) + o.h / 2, oz));
        this.solids.push({ x: ox, z: oz, r: o.r });
      }
    }
    if (s.lrv) {
      const m = buildLrvModel();
      applyWear(m.root, { dust: { value: 0.7 }, dustColor: new THREE.Color(0.2, 0.195, 0.188), lowY: -0.4, rootInv: { value: new THREE.Matrix4() } });
      const x = s.lrv.x, z = s.lrv.z;
      const g = new THREE.Group();
      g.add(m.root);
      // Final parking (Apollo 15 ~90 m, Apollo 17 ~150 m east of the LM): the TV camera
      // pointed at the LM to film the lift-off.
      const lm = this.terrain.meta.landing;
      g.rotation.y = Math.atan2(lm.x - x, lm.z - z);
      this.parkedLrv = { x, z, yaw: g.rotation.y };
      g.position.set(x, this.terrain.height(x, z) + 0.76, z);
      m.animate({ dt: 0.016, time: 0, speed: 0, steer: 0, lookYaw: 0, lookPitch: 0, parked: true, wheelLocal: m.wheels.map((w) => w.steer.position.clone()), preview: false });
      this.scene.add(g);
      const R = this.physics.R;
      this.physics.world.createCollider(R.ColliderDesc.cuboid(0.9, 0.35, 1.5).setTranslation(x, g.position.y - 0.2, z).setRotation(new THREE.Quaternion().setFromEuler(g.rotation)));
    }
  }

  private shotN = 0;
  /** Photo (F): shutter, saves the frame, and discovers the site in view. */
  private takePhoto(): void {
    this.audio.click(3200);
    this.render();
    const flash = document.getElementById('flash');
    flash?.classList.remove('go');
    void flash?.offsetWidth;
    flash?.classList.add('go');
    const site = this.finds?.photograph(this.camera);
    if (!site) {
      try {
        const a = document.createElement('a');
        a.href = this.renderer.domElement.toDataURL('image/jpeg', 0.92);
        a.download = `planetokhod-${++this.shotN}.jpg`;
        a.click();
      } catch {
        /* canvas not readable */
      }
    }
  }

  private radioState = { started: false, shadow: false, low: false, base: false, far: false };
  /** Houston comments on what happens (each reply 2.6 s later: light time Earth–Moon and back). */
  private radioEvents(): void {
    if (!this.sky) return;
    const r = this.rover, st = this.radioState;
    if (!st.started) {
      st.started = true;
      this.radio.say('start', { delay: 1 });
    }
    if (r.sunLit < 0.5 && !st.shadow) this.radio.say('shadow', { repeat: true });
    st.shadow = r.sunLit < 0.5;
    if (r.battery < 0.2 && !st.low) this.radio.say('lowbatt', { repeat: true });
    st.low = r.battery < 0.2;
    if (this.hud.atBase && !st.base) this.radio.say('base', { repeat: true });
    st.base = this.hud.atBase;
    const lm = this.terrain.meta.landing, p = r.object.position;
    const far = Math.hypot(p.x - lm.x, p.z - lm.z) > 2500;
    if (far && !st.far) this.radio.say('far');
    st.far = far;
    if (Math.abs(r.attitude().roll) > 30) this.radio.say('roll');
    if (r.lastHit >= 0) {
      if ((r.wheelDamage[r.lastHit] ?? 0) >= 1) this.radio.say('wheelDead', { repeat: true });
      else if ((r.wheelDamage[r.lastHit] ?? 0) > 0.3) this.radio.say('wheelHurt');
      r.lastHit = -1;
    }
  }

  private litTimer = 0;
  /**
   * Is the rover in sunlight (ray to the Sun over the terrain, incl. distant massifs)?
   * And charging at the base: parked within 20 m of the LM (game liberty: the real
   * LRV had no recharge; the energy loop needs a base).
   */
  private updateEnergy(dt: number): void {
    const r = this.rover, p = r.object.position;
    this.litTimer -= dt;
    if (this.litTimer <= 0) {
      this.litTimer = 0.5;
      r.sunLit = this.sky ? ShadowBaker.litAt(this.terrain, p.x, p.z, this.sunDir, 1.2) : 1;
    }
    const lm = this.terrain.meta.landing;
    const atBase = !this.heli && world().id === 'moon' && Math.hypot(p.x - lm.x, p.z - lm.z) < 20 && Math.abs(r.speed) < 0.2;
    r.chargeW = atBase ? r.spec.batteryWh * 0.02 : 0;
    this.hud.atBase = atBase;
  }

  /** Where the sky is computed: the LM (or the window centre). */
  private lunarSite(): { lat: number; lon: number } {
    const m = this.terrain.meta;
    return m.sites?.lm ?? { lat: m.centerLat, lon: m.centerLon };
  }

  /** Jump to a moment (UTC ms) and set the time rate (1 = real time). */
  setTime(ms: number, scale = this.timeScale): void {
    this.simTime = ms;
    this.timeScale = scale;
    this.updateClock(0, true);
  }

  /**
   * Advance the ephemeris clock: Sun, Earth and stars move, terrain shadows are
   * recomputed on the GPU, the light level follows the Sun's elevation.
   */
  private updateClock(dt: number, jump = false): void {
    if (this.marsSky) {
      this.updateMarsClock(dt, jump);
      return;
    }
    if (!this.sky) return;
    this.simTime += dt * 1000 * this.timeScale;
    const l = this.lunarSite();
    const st = lunarSky(this.simTime, l.lat, l.lon);
    this.sunDir.set(...st.sun);
    const earth = new THREE.Vector3(...st.earth);
    const m = st.icrfToGame;
    const mt = new THREE.Matrix4().set(m[0][0], m[0][1], m[0][2], 0, m[1][0], m[1][1], m[1][2], 0, m[2][0], m[2][1], m[2][2], 0, 0, 0, 0, 1);
    const rot = mt.multiply(this.starFrame0.clone().transpose());
    this.sky.setCelestial(this.sunDir, earth, new THREE.Quaternion().setFromRotationMatrix(rot));
    this.terrainR.setSun(this.sunDir);
    this.baker?.setSun(this.sunDir, jump);
    if (jump) this.baker?.bakeAll();
    // Under heavy load the shadow re-bake runs every other frame.
    else if (this.governor.relief < 2 || (this.idleTick++ & 1)) this.baker?.update();
    // Below the horizon (or behind a mountain) the Sun stops lighting; the bounce light goes with it.
    const up = THREE.MathUtils.smoothstep(this.sunDir.y, -0.0046, 0.0046);
    this.sun.intensity = SUN_INTENSITY * up;
    this.hemi.intensity = THREE.MathUtils.clamp(this.sunDir.y / 0.33, 0, 1.6) * up + 0.02;
    if (this.earthshine) {
      this.earthshine.position.copy(earth);
      // Earthshine ∝ the Earth's lit fraction (full Earth ≈ 0.1 lux·m²/... ≈ 50× brighter than full Moon light).
      this.earthshine.intensity = SUN_INTENSITY * 0.0035 * st.earthPhase * Math.max(0, earth.y);
    }
    // Reflections: rebuild the opposition-lit environment when the Sun has moved > 3°.
    if (this.envSun.angleTo(this.sunDir) > 0.05) {
      this.envSun.copy(this.sunDir);
      const old = this.scene.environment;
      this.scene.environment = this.buildEnvironment();
      old?.dispose();
    }
    this.onTimeChange?.(this.simTime);
  }

  /**
   * Mars: the sol goes on (Mars24 ephemeris, 1 game minute per second like the Moon's
   * clock): the Sun crosses the sky, sets in its blue twilight, the shadows follow.
   */
  private updateMarsClock(dt: number, jump = false): void {
    const ms = this.marsSky!;
    this.simTime += dt * 1000 * this.marsTimeScale;
    const m = this.terrain.meta;
    const s = marsSun(this.simTime, m.centerLat, m.centerLon);
    const dir = new THREE.Vector3();
    azElDir(s.az, s.el, dir);
    this.marsLtst = s.ltst;
    ms.setSun(dir);
    this.sunDir.copy(dir);
    if (this.marsNight) {
      // The stars, moons and Earth, turned so that their Sun is the Mars24 Sun (the two
      // computations differ by ~1.5 deg in longitude conventions).
      const st = marsSkyState(this.simTime, m.centerLat, m.centerLon);
      this.nightFix.setFromUnitVectors(st.sun, dir);
      this.nightState = st;
    }
    this.terrainR.setSun(this.sunDir);
    this.baker?.setSun(this.sunDir, jump);
    if (jump) this.baker?.bakeAll();
    else if (this.governor.relief < 2 || (this.idleTick++ & 1)) this.baker?.update();
    // The sky light (reflection environment) follows the Sun: dusk darkens it, night ends
    // it. Rebuilt in updateEnvironment, once the sky's brightness is set for this Sun (built
    // here it kept the previous - daytime - sky: rover and far slopes glowing at night).
    if (jump || this.envSun.angleTo(this.sunDir) > 0.04) {
      this.envSun.copy(this.sunDir);
      this.envDirty = true;
    }
    this.onTimeChange?.(this.simTime);
  }

  private nightFix = new THREE.Quaternion();
  private envDirty = false;
  private nightState: ReturnType<typeof marsSkyState> | null = null;

  /** Mars: jump the clock forward to the next time the local solar time is h (hours). */
  setMarsLtst(h: number): void {
    if (!this.marsSky) return;
    const m = this.terrain.meta;
    const SOL = 88775244;
    for (let k = 1; k <= 740; k++) {
      const t = this.simTime + (k * SOL) / 720;
      const l = marsSun(t, m.centerLat, m.centerLon).ltst;
      if (Math.abs(((l - h + 36) % 24) - 12) < 0.05) {
        this.simTime = t;
        this.updateClock(0, true);
        return;
      }
    }
  }

  /** Local true solar time at the site on Mars (h). */
  marsLtst = 15;
  /** Rate of the Mars clock (game seconds per real second); 0 = the sol stands still. */
  marsTimeScale = 60;

  /** Sky, haze, sunlight and weather of the current body. */
  private updateEnvironment(dt: number): void {
    this.updateClock(this.paused ? 0 : dt);
    if (this.sky) {
      this.sky.update(this.camera, this.terrain.height(this.camera.position.x, this.camera.position.z));
      return;
    }
    this.updateAtmosphere(dt);
  }

  private updateAtmosphere(dt: number): void {
    const ms = this.marsSky, w = this.weather;
    if (!ms || !w) return;
    w.update(dt, this.camera, this.rover.object.position);
    ms.update(this.camera, this.time, w.tau);
    w.convection = THREE.MathUtils.smoothstep(this.sunDir.y, 0.2, 0.55);
    if (this.marsNight && this.nightState) {
      // Night: the stars come out as the Sun goes ~4-17 deg below the horizon.
      const dark = 1 - THREE.MathUtils.smoothstep(this.sunDir.y, -0.29, -0.06);
      this.marsNight.update(this.camera, this.nightState, this.nightFix, dark, w.tau);
    }
    const W = world();
    const sunTop = SUN_INTENSITY * W.solarFactor;
    const trans = ms.directTransmission();
    this.terrainR.uniforms.uDiffuse.value = THREE.MathUtils.clamp(1 - trans / 0.6, 0, 1);
    this.terrainR.uniforms.uStorm.value.set(w.storm, w.settled, this.time);
    this.terrainR.uniforms.uWind.value.set(w.wind.x, w.wind.z);
    const reddening = 1 - trans;
    this.sun.intensity = sunTop * trans;
    this.sun.color.setRGB(1, 0.93 - 0.12 * reddening, 0.84 - 0.25 * reddening);
    // Sky light: irradiance = π · (mean sky radiance); the sky dome is drawn with the same model.
    const bright = sunTop * 0.3;
    ms.uniforms.uBright.value = bright;
    if (this.envDirty) {
      this.envDirty = false;
      const old = this.scene.environment;
      this.scene.environment = this.buildEnvironment();
      old?.dispose();
    }
    const c1 = ms.colorAt(new THREE.Vector3(0, 1, 0), new THREE.Color());
    const c2 = ms.colorAt(new THREE.Vector3(this.sunDir.x, 0.15, this.sunDir.z).normalize(), new THREE.Color());
    const c3 = ms.colorAt(new THREE.Vector3(-this.sunDir.x, 0.15, -this.sunDir.z).normalize(), new THREE.Color());
    const skyL = c1.multiplyScalar(0.5).add(c2.multiplyScalar(0.25)).add(c3.multiplyScalar(0.25)).multiplyScalar(bright);
    const sinEl = Math.max(0.05, this.sunDir.y);
    const eTot = this.sun.intensity * sinEl + Math.PI * (skyL.r + skyL.g + skyL.b) / 3;
    this.hemi.color.copy(skyL).multiplyScalar(Math.PI);
    // The cave sees the Sun and the sky only through its opening (its own shader).
    this.cave?.setLight(this.sunDir, this.sun.color.clone().multiplyScalar(this.sun.intensity), skyL);
    this.cave?.updateVisibility(this.camera.position);
    this.hemi.groundColor.setRGB(0.3, 0.19, 0.12).multiplyScalar(eTot * 0.5);
    // Lightning in an approaching storm front briefly lights the landscape.
    this.hemi.intensity = 1 + w.front.flash * 0.9;
    // With the camera in the cave, what it sees (the helicopter) is lit as the cave is
    // at that point - the scene's sun and sky would light it through the rock.
    if (this.cave && this.cave.depth(this.camera.position) > 2) {
      const at = this.heli ? this.heli.pos : this.camera.position;
      const l = this.cave.lightAt(at, this.sunDir);
      this.sun.intensity *= l.sun;
      this.hemi.intensity *= l.sky;
    }
    // Ruts: sky light vs. the direct Sun decides how dark the shaded rut wall is.
    this.tracks.setAmbient(Math.max(0.05, (Math.PI * (skyL.r + skyL.g + skyL.b)) / 3 / Math.max(this.sun.intensity, 0.05)));
    // Aerial perspective: fog colour = sky near the horizon in the view direction.
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    fwd.y = 0.04;
    const fogC = ms.colorAt(fwd.normalize(), new THREE.Color()).multiplyScalar(bright * 0.92);
    const fog = this.scene.fog as THREE.FogExp2;
    // three.js mixes the fog in after tone mapping (only converting its colour to sRGB),
    // while the sky behind is exposed and tone-mapped: pass the fog colour through the
    // same curve, or hazy distance turns into a dark brown band instead of the sky.
    fog.color.copy(acesFilmic(fogC, this.renderer.toneMappingExposure));
    // Inside a devil or a storm front the dust closes in around the rover: the haze
    // thickens smoothly with proximity (devilNear eases in from 3 radii), no edge.
    const inDevil = w.devilNear * w.devilNear * (3 - 2 * w.devilNear);
    fog.density = 6.5e-5 * Math.pow(w.tau / 0.62, 1.6) * (1 + inDevil * 60);
    this.far?.setNearRadius(this.q.drawDistance - 250);
    // Camera auto-exposure (partial: storms still look dark).
    // Under the cave roof no weather is seen (devils, blowing sand belong outside).
    w.group.visible = !(this.cave && this.cave.depth(this.camera.position) > 12);
    // In a cave the eye (or the camera's auto-exposure) adapts to the dark, slowly.
    const deep = this.cave ? this.cave.depth(this.camera.position) : 0;
    // Metered on what is in view, like a camera's auto-exposure (Cave.meter): looking at
    // the sunlit patch it stays low, looking into the dark passage it opens up (to ~300×,
    // as a dark-adapted eye or a long exposure would). Measured a few times a second.
    if (this.cave && deep > 1 && (this.meterTick++ & 7) === 0) this.caveMeter = this.cave.meter(this.camera, this.sunDir);
    const dark = THREE.MathUtils.clamp(Math.pow(0.5 / Math.max(this.caveMeter, 1e-4), 0.9), 1, 300);
    const adaptT = 1 + (dark - 1) * THREE.MathUtils.smoothstep(deep, 2, 12);
    this.caveAdapt += (adaptT - this.caveAdapt) * (dt > 0 ? 1 - Math.exp(-dt * 0.5) : 1);
    const target = THREE.MathUtils.clamp(1.45 * Math.pow(1.6 / Math.max(eTot, 0.05), 0.55), 0.8, 4.5) * this.caveAdapt;
    this.renderer.toneMappingExposure += (target - this.renderer.toneMappingExposure) * (dt > 0 ? 1 - Math.exp(-dt * 0.8) : 1);
    w.setLighting(this.sun.color.clone().multiplyScalar(this.sun.intensity * 0.12), skyL.clone().multiplyScalar(0.35), fogC, fog.density);
    // Reflections follow the sky only when it changes a lot (PMREM is not free).
    if (Math.abs(w.tau - this.envTau) > 0.4) {
      this.envTau = w.tau;
      const old = this.scene.environment;
      this.scene.environment = this.buildEnvironment();
      old?.dispose();
    }
    // Rover: sunlight on the panels, dust settling (storms) and devils sweeping it off.
    const r = this.rover;
    r.solarScale = Math.min(1, trans * 1.15 + 0.3 * Math.exp(-w.tau * 0.3));
    r.panelDust = THREE.MathUtils.clamp(r.panelDust + dt * (2e-5 + w.storm * 1.2e-3) - dt * w.devilNear * 0.08 * r.panelDust, 0, 0.9);
    // In a devil: its own flow at the rover (Rankine: fastest at the core wall, nearly
    // calm in the eye) and the sand it carries, striking the rover.
    const rp = r.object.position, devil = w.nearestDevil(rp.x, rp.z);
    let wv = Math.hypot(w.wind.x, w.wind.z);
    if (devil) {
      const fl = w.sand.flow(devil, rp.x, 1, rp.z, new THREE.Vector3());
      wv = Math.max(wv, Math.hypot(fl.x, fl.z) * devil.s);
    }
    const rf = r.forwardVector(new THREE.Vector3());
    const sp = r.spec;
    const top = sp.top.offset[1] + sp.top.half[1] + 0.25, bot = -0.45;
    w.sand.update(dt, devil, {
      pos: rp, yaw: Math.atan2(rf.x, rf.z),
      half: [Math.max(...sp.wheels.map((q) => Math.abs(q[0]))) + sp.wheelWidth / 2, (top - bot) / 2, Math.max(...sp.wheels.map((q) => Math.abs(q[1]))) + sp.wheelRadius],
      up: (top + bot) / 2,
    }, this.camera.position);
    const rate = dt > 0 ? w.sand.hits / dt : 0;
    this.audio.grains += (rate - this.audio.grains) * Math.min(1, dt * 6);
    this.audio.grainV = w.sand.hits ? Math.sqrt(w.sand.hitEnergy / w.sand.hits) : this.audio.grainV;
    // Sandblasting: barely anything per devil (years of it frost the rover's paint).
    r.sandblast.value = Math.min(1, r.sandblast.value + w.sand.hitEnergy * 1.5e-7);
    const area = r.spec.body.half[0] * 2 * (r.spec.body.half[1] * 2 + 0.3) + 0.2;
    const f = 0.5 * W.airDensity * wv * wv * 1.1 * area;
    r.windForce.set(w.wind.x, 0, w.wind.z).normalize().multiplyScalar(f);
    this.dust.wind.copy(w.wind);
    this.audio.wind = Math.min(1, wv / 22) * 0.9;
  }

  private updatePanel(dt: number): void {
    const r = this.rover;
    if (!r.model.panel) return;
    const p = r.object.position;
    const t = this.terrain;
    const { roll, pitch, heading } = r.attitude();
    const lm = t.meta.landing;
    const dx = lm.x - p.x, dz = lm.z - p.z;
    let bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (bearing < 0) bearing += 360;
    const n = [0, 1, 0];
    t.normal(p.x, p.z, n, 1.5);
    r.model.panel?.update(dt, {
      speedKmh: Math.abs(r.speed) * 3.6, pitch, roll, heading, bearing,
      range: Math.hypot(dx, dz) / 1000, distance: r.odometer / 1000, battery: r.battery,
      volts: r.volts, battTempC: r.battTemp, motorTempC: r.motorTemp,
      slope: (Math.acos(Math.min(1, n[1])) * 180) / Math.PI, elevation: p.y + t.meta.minHeight,
      parkBrake: r.parkBrake || this.input.drive.handbrake, headlights: r.headlights,
      warnRoll: Math.abs(roll) > 30 || Math.abs(pitch) > 30, warnBatt: r.battery < 0.15,
      warnTemp: Math.max(...r.motorTemp) > 110,
    });
  }

  private updateSun(p: THREE.Vector3): void {
    // Shadow frustum centred ahead of the camera, snapped to shadow texels
    // in light space to stop edge shimmering.
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize().multiplyScalar(this.q.shadowRange * 0.4);
    const c = new THREE.Vector3(p.x + fwd.x, p.y, p.z + fwd.z);
    const dir = this.sunDir;
    const lightRot = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    c.applyMatrix4(inv);
    c.x = Math.round(c.x / this.sunTexel) * this.sunTexel;
    c.y = Math.round(c.y / this.sunTexel) * this.sunTexel;
    c.applyMatrix4(lightRot);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(dir, 2000);
    this.sun.target.updateMatrixWorld();
  }

  /** On-screen marker over the rover while flying Ingenuity (or at the screen edge, pointing to it). */
  private roverMark: HTMLDivElement | null = null;
  private updateRoverMark(): void {
    const h = this.heli;
    if (!h) {
      if (this.roverMark) this.roverMark.style.display = 'none';
      return;
    }
    if (!this.roverMark) {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;z-index:60;pointer-events:none;transform:translate(-50%,-100%);font:600 14px/1.2 system-ui,sans-serif;color:#ffd27a;background:rgba(20,14,8,0.72);padding:3px 8px;border-radius:10px;white-space:nowrap;text-align:center';
      document.body.appendChild(d);
      this.roverMark = d;
    }
    const m = this.roverMark;
    const rp = this.rover.object.position;
    const dist = Math.hypot(rp.x - h.pos.x, rp.z - h.pos.z);
    const v = new THREE.Vector3(rp.x, rp.y + 3.2, rp.z).project(this.camera);
    const behind = v.z > 1;
    const W = window.innerWidth, H = window.innerHeight;
    let x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
    let arrow = '▼';
    if (behind || x < 30 || x > W - 30 || y < 40 || y > H - 30) {
      // Off screen: pinned to the edge, the arrow pointing toward the rover.
      let dx = v.x, dy = -v.y;
      if (behind) { dx = -dx; dy = -dy; }
      const k = 0.85 / Math.max(Math.abs(dx), Math.abs(dy), 1e-3);
      x = (dx * k * 0.5 + 0.5) * W;
      // Kept clear of the panels at the bottom.
      y = Math.min((dy * k * 0.5 + 0.5) * H, H * 0.62);
      const ang = Math.atan2(dy, dx);
      arrow = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
    }
    m.style.display = '';
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    m.textContent = `${t('heliRover')} · ${Math.round(dist)} ${t('hM')} ${arrow}`;
  }

  private updateHeliHud(): void {
    this.updateRoverMark();
    const h = this.heli, el = this.heliHud;
    if (!h || !el) return;
    const sp = Math.hypot(h.vel.x, h.vel.z);
    el.innerHTML =
      `<b>INGENUITY</b> · ${t(`heliPhase_${h.phase}`)}<br>` +
      `${t('heliAlt')} <b>${h.agl.toFixed(1)}</b> ${t('hM')} · ${t('heliSpeed')} <b>${sp.toFixed(1)}</b> ${t('hMs')} · ↕ <b>${h.vel.y.toFixed(1)}</b><br>` +
      `${t('heliRotor')} <b>${Math.round(h.rpm)}</b> ${t('hRpm')} · ${t('hBatt')} <b>${Math.round(h.battery * 100)}</b>% (${Math.round(h.endurance)} ${t('hS')})<br>` +
      `${t('heliFlights')} <b>${h.flights}</b> · ${t('heliTime')} <b>${Math.round(h.flightTime)}</b> ${t('hS')}` +
      (h.status ? `<div class="hs">${t(h.status)}</div>` : '') +
      `<div class="hk">${t('heliKeys')}</div>`;
  }

  private updateCamera(dt: number): void {
    const rover = this.rover;
    if ((this.heli || this.eva) && !this.debugCam) {
      const h = (this.heli ?? this.eva)!;
      if (this.eva && this.evaCam && (this.cameraMode === 'partner' || this.cameraMode === 'tv')) {
        const r = this.rover.object.position;
        this.evaCam.shoot(this.cameraMode, dt, this.eva, this.camera, { pos: r, fwd: this.rover.forwardVector(new THREE.Vector3()) }, this.baseFov);
        return;
      }
      this.camera.fov = this.baseFov;
      if (this.cameraMode === 'cabin') {
        h.camAnchor.updateMatrixWorld();
        h.camAnchor.getWorldPosition(this.camera.position);
        h.camAnchor.getWorldQuaternion(this.camera.quaternion);
        this.camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.look.pitch + 0.12, this.look.yaw, 0, 'YXZ')));
        this.camera.near = 0.05;
      } else {
        const p = h.object.position;
        const top = this.cameraMode === 'top';
        const dr = this.input.drive;
        const ec = this.eva && this.evaCam && !top ? this.evaCam.chase(dt, this.eva, Math.abs(dr.throttle) + Math.abs(dr.brake) + Math.abs(dr.steer) > 0.05) : null;
        const yaw = h.yaw + this.orbit.yaw + (ec ? this.evaCam!.idleYaw : 0);
        const d = top ? Math.max(6, this.topHeight * 0.3) : this.orbit.dist;
        const pitch = top ? 1.45 : this.orbit.pitch;
        // Aim at the helicopter's body, or at an astronaut's chest.
        const aimY = this.eva ? 1.2 : 0.3;
        const target = new THREE.Vector3(p.x - Math.sin(yaw) * Math.cos(pitch) * d, p.y + aimY + Math.sin(pitch) * d, p.z - Math.cos(yaw) * Math.cos(pitch) * d);
        if (this.chasePos.lengthSq() === 0 || dt === 0) this.chasePos.copy(target);
        else this.chasePos.lerp(target, 1 - Math.exp(-dt * 4));
        const cave = this.cave;
        if (cave && cave.contains(p)) {
          // Following into a cave: the camera stays inside it, between floor and roof.
          cave.clampCamera(this.chasePos, p);
        } else {
          const gy = this.terrain.height(this.chasePos.x, this.chasePos.z) + 0.4;
          if (this.chasePos.y < gy) this.chasePos.y = gy;
        }
        this.camera.position.copy(this.chasePos);
        // Stepping off the rover: first seen from in front, then the camera swings behind.
        if (ec && ec.intro > 0) this.camera.position.lerp(ec.from, ec.intro);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(p.x, p.y + aimY - 0.05, p.z);
        this.camera.near = 0.05;
      }
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      return;
    }
    if (this.debugCam) {
      const d = this.debugCam;
      this.camera.position.set(d.x, this.terrain.height(d.x, d.z) + d.h, d.z);
      this.camera.up.set(0, 1, 0);
      // Azimuth from north, clockwise; the camera looks down its -z axis.
      this.camera.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(d.pitch), -THREE.MathUtils.degToRad(d.az), 0, 'YXZ'));
      this.camera.fov = d.fov;
      this.camera.near = 0.05;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      return;
    }
    if (this.cameraMode === 'cabin') {
      const a = rover.model.cockpitAnchor;
      a.updateMatrixWorld();
      a.getWorldPosition(this.camera.position);
      // Vertical stabilisation of the eye point (seat damping).
      if (dt > 0 && Number.isFinite(this.cabY)) this.cabY += (this.camera.position.y - this.cabY) * (1 - Math.exp(-dt / 0.12));
      else this.cabY = this.camera.position.y;
      this.camera.position.y = this.cabY;
      // Head stabilisation: the view follows the chassis attitude with a short lag
      // (~80 ms), so suspension buzz over pebbles does not shake the picture, while
      // real pitch and roll on slopes and bumps come through.
      const qT = rover.object.quaternion;
      if (dt <= 0 || this.cabQ.lengthSq() === 0) this.cabQ.copy(qT);
      // Stabilised head: ~0.18 s lag filters the chatter of small bumps; the camera
      // height is smoothed too, so slopes and big lurches still come through.
      else this.cabQ.slerp(qT, 1 - Math.exp(-dt / 0.18));
      const q = this.cabQ.clone();
      // Jolts: each knock kicks a damped ~9 Hz shake (rocks hard and sharp, bumps soft).
      // Only real blows on rock or the chassis shake the view; regolith bumps are
      // absorbed by the seat suspension (cf. the LRV's seat and the crew's own legs).
      for (const k of rover.knocks) if (k.hard > 0.5 && k.strength > 0.5) this.shake.a = Math.min(0.025, this.shake.a + (k.strength - 0.5) * 0.008);
      this.shake.a *= Math.exp(-dt * 9);
      this.shake.ph += dt * 57;
      if (this.shake.a > 1e-4) {
        const sa = this.shake.a;
        q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(this.shake.ph) * sa, Math.sin(this.shake.ph * 0.73 + 1.3) * sa * 0.4, Math.sin(this.shake.ph * 1.31 + 0.4) * sa * 0.7)));
        this.camera.position.y += Math.sin(this.shake.ph * 0.9) * sa * 0.35;
      }
      const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.look.pitch, Math.PI + this.look.yaw, 0, 'YXZ'));
      this.camera.quaternion.copy(q).multiply(look);
      this.camera.near = Math.min(0.08, 0.1 * this.sizeK);
    } else if (this.cameraMode === 'top') {
      // Bird's-eye view, north up (drag rotates), zoom with the wheel or buttons.
      const p = rover.object.position;
      const target = new THREE.Vector3(p.x, p.y + this.topHeight, p.z);
      if (this.chasePos.lengthSq() === 0 || dt === 0) this.chasePos.copy(target);
      else this.chasePos.lerp(target, 1 - Math.exp(-dt * 6));
      this.camera.position.copy(this.chasePos);
      this.camera.up.set(Math.sin(this.orbit.yaw), 0, -Math.cos(this.orbit.yaw));
      this.camera.lookAt(this.chasePos.x, p.y, this.chasePos.z);
      this.camera.near = Math.max(0.5, this.topHeight * 0.05);
    } else {
      const p = rover.object.position;
      const f = rover.forwardVector(new THREE.Vector3());
      const yaw = Math.atan2(f.x, f.z) + this.orbit.yaw;
      const d = this.orbit.dist;
      const target = new THREE.Vector3(
        p.x - Math.sin(yaw) * Math.cos(this.orbit.pitch) * d,
        p.y + Math.sin(this.orbit.pitch) * d + 1.2 * this.sizeK,
        p.z - Math.cos(yaw) * Math.cos(this.orbit.pitch) * d,
      );
      if (this.chasePos.lengthSq() === 0 || dt === 0) this.chasePos.copy(target);
      else this.chasePos.lerp(target, 1 - Math.exp(-dt * 5));
      const gy = this.terrain.height(this.chasePos.x, this.chasePos.z) + 0.6 * this.sizeK;
      if (this.chasePos.y < gy) this.chasePos.y = gy;
      this.camera.position.copy(this.chasePos);
      this.camera.up.set(0, 1, 0);
      for (const k of rover.knocks) if (k.hard > 0.5 && k.strength > 0.5) this.shake.a = Math.min(0.025, this.shake.a + (k.strength - 0.5) * 0.006);
      this.shake.a *= Math.exp(-dt * 9);
      this.shake.ph += dt * 57;
      this.camera.lookAt(p.x, p.y + 0.8 * this.sizeK + Math.sin(this.shake.ph) * this.shake.a * 2, p.z);
      this.camera.near = 0.2 * this.sizeK;
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /**
   * Dynamic resolution: keeps the frame rate steady instead of the image sharpness.
   * Every 0.5 s the share of late frames (longer than 1.25 × the target period) is
   * measured; the internal render resolution drops by 10 % at once when frames are
   * late and creeps back up by 5 % after a few calm seconds. Only if the resolution
   * is already at its floor does Auto quality step down a level (shadows, draw
   * distance, rocks), and it steps back up after a long calm spell.
   */
  private adaptQuality(dt: number): void {
    const d = this.drs;
    d.warm -= dt;
    if (dt > 0.25 || d.warm > 0) return; // tab switch, loading
    // Display refresh: the shortest frame intervals seen recently (60, 90, 120, 144 Hz).
    d.minDt = Math.min(d.minDt * 1.0005 + 1e-6, dt);
    const period = Math.max(d.minDt, isMobile ? 1 / 30 : 1 / 58);
    const minScale0 = Math.min(1, Math.max(isMobile ? 0.5 : 0.6, 0.75 / this.q.pixelRatio));
    // Fast path: the watchdog sheds load within a few frames of a slowdown.
    const step = this.governor.update(dt, this.cpuLast, period);
    const g = this.governor;
    this.dust.budget = g.particleBudget;
    this.weather?.setRelief(g.relief, g.particleBudget);
    // Under load the cave sheds its pebbles first (thousands of small instances).
    this.cave?.setRelief(g.relief);
    if (step < 0 && d.scale > minScale0 + 1e-3) {
      d.scale = Math.max(minScale0, d.scale + step);
      d.calm = 0;
      this.renderer.setPixelRatio(this.q.pixelRatio * d.scale);
      this.resize();
    }
    d.t += dt;
    d.n++;
    if (dt > period * 1.25) d.late++;
    if (d.t < 0.5) return;
    const lateFrac = d.late / d.n;
    d.t = 0;
    d.n = 0;
    d.late = 0;
    // Resolution never drops below 0.75 device pixels per CSS pixel: under that the
    // image turns to mush (it used to reach 0.5 on phones) - a lower level is better.
    const maxScale = 1, minScale = Math.min(1, Math.max(isMobile ? 0.5 : 0.6, 0.75 / this.q.pixelRatio));
    let scale = d.scale;
    // Calibration: the first ~25 s of play find the level this device can hold
    // (level changes recompile shaders - a short freeze - so they happen early).
    d.played += 0.5;
    const settling = d.played < 25;
    if (lateFrac > 0.12) {
      d.calm = 0;
      d.easy = 0;
      // Badly late (most frames missed, e.g. inside a dust devil): step down faster.
      if (scale > minScale + 1e-3) scale = Math.max(minScale, scale - (lateFrac > 0.5 ? 0.2 : 0.1));
      // A level change recompiles the big terrain shader (a 1–3 s freeze on an iGPU):
      // only downward; while calibrating after 2 slow checks (4 s apart), later after
      // 4 and at most once per 90 s.
      else if (this.autoQuality && ++d.floorHits >= (settling ? 2 : 4) && this.time - d.downAt > (settling ? 4 : 90)) {
        d.floorHits = 0;
        const i = LEVELS.indexOf(this.q.level);
        if (i > 0) {
          const slow = this.q.level;
          this.setQuality(LEVELS[i - 1], true);
          scale = 0.85;
          d.downAt = this.time;
          saveAutoQuality(this.q.level, false, slow);
        }
      }
    } else if (lateFrac < 0.02) {
      d.floorHits = 0;
      d.calm += 0.5;
      if (d.calm >= 3 && scale < maxScale) {
        scale = Math.min(maxScale, scale + 0.05);
        d.calm = 0;
      }
      // A minute at full resolution with time to spare: next session tries a level up.
      if (scale >= maxScale - 1e-3) d.easy += 0.5;
      if (this.autoQuality && d.easy >= 60 && !d.savedEasy) {
        d.savedEasy = true;
        saveAutoQuality(this.q.level, true);
      }
    }
    else d.easy = 0; // a few late frames: no headroom to speak of
    if (this.autoQuality && !settling && !d.savedLevel) {
      d.savedLevel = true;
      saveAutoQuality(this.q.level, false);
    }
    if (Math.abs(scale - d.scale) > 1e-3) {
      d.scale = scale;
      this.renderer.setPixelRatio(this.q.pixelRatio * scale);
      this.resize();
    }
  }

  /** Dynamic-resolution state (see adaptQuality). */
  private drs = { t: 0, n: 0, late: 0, scale: 1, calm: 0, floorHits: 0, warm: 4, minDt: 1 / 60, downAt: -1e9, played: 0, easy: 0, savedEasy: false, savedLevel: false };

  private readMask(baked: THREE.Texture): Uint8Array | null {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 500;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(baked.image as CanvasImageSource, 0, 0, 500, 500);
      const d = g.getImageData(0, 0, 500, 500).data;
      const out = new Uint8Array(500 * 500);
      for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
      return out;
    } catch {
      return null;
    }
  }

  /** Occasional meteoroid impact flash somewhere in shadow, in front of the camera. */
  private updateImpacts(dt: number): void {
    if (!this.sky) return;
    this.sky.updateFlashes(dt, this.scene);
    this.flashTimer -= dt;
    if (this.flashTimer > 0 || !this.shadowMask) return;
    this.flashTimer = 10 + Math.random() * 30;
    const t = this.terrain;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const base = Math.atan2(fwd.x, fwd.z);
    for (let i = 0; i < 30; i++) {
      const a = base + (Math.random() - 0.5) * 1.2;
      const d = 150 + Math.random() * 1500;
      const x = this.camera.position.x + Math.sin(a) * d, z = this.camera.position.z + Math.cos(a) * d;
      if (!t.inside(x, z)) continue;
      const mx = x, mz = z;
      const ix = Math.min(499, Math.max(0, Math.floor(((mx + t.halfX) / t.meta.sizeX) * 500)));
      const iz = Math.min(499, Math.max(0, Math.floor(((mz + t.halfZ) / t.meta.sizeZ) * 500)));
      if (this.shadowMask[iz * 500 + ix] > 60) continue; // only in darkness
      this.sky.impactFlash(this.scene, new THREE.Vector3(x, t.height(x, z) + 0.3, z), d);
      return;
    }
  }

  /** High-resolution centre orthophoto, loaded after the title screen is up. */
  setOrthoHi(tex: THREE.Texture): void {
    this.terrainR.setOrthoHi(tex);
  }

  /** Photographic Milky Way (Moon), loaded after the title screen is up; until then a procedural one. */
  setMilkyWay(tex: THREE.Texture): void {
    this.sky?.setMilkyWayMap(tex);
    this.marsNight?.setMilkyWay(tex);
  }

  /** Restart at the landing site. */
  restart(): void {
    this.exitEva();
    this.o2 = O2_FULL;
    this.rover.repair();
    const [x, z] = this.startPoint();
    this.physics.updatePatch(x, z, true);
    this.rover.placeAt(x, z, START_YAW);
    if (this.heli) {
      // A fresh helicopter on the airfield next to the rover's start.
      const heliOn = true;
      this.exitHeli();
      if (heliOn) this.enterHeli();
    }
    this.rover.battery = 1;
    this.rover.panelDust = 0;
    this.rover.parkBrake = false;
    this.chasePos.set(0, 0, 0);
  }

  get stats(): { fps: number; rocks: number; calls: number; tris: number } {
    const info = this.renderer.info.render;
    return { fps: this.fpsAcc.fps, rocks: this.rocks.count(), calls: info.calls, tris: info.triangles };
  }
}
