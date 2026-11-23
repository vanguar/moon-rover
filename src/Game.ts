import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CabinAudio } from './audio/CabinAudio';
import { isMobile, makeQuality, type QualityLevel, type QualitySettings } from './config';
import { Dust } from './fx/Dust';
import { MarsSky } from './fx/MarsSky';
import { MarsWeather, type WeatherMode } from './fx/MarsWeather';
import { Sky } from './fx/Sky';
import { Tracks } from './fx/Tracks';
import { Hud } from './hud/Hud';
import { Input } from './input/Input';
import { Physics } from './physics/Physics';
import { setSurfacePhotometry } from './render/lunar';
import { Rover } from './rover/Rover';
import type { RoverSpec } from './rover/specs';
import { Rocks } from './terrain/Rocks';
import type { TerrainData } from './terrain/TerrainData';
import { FarTerrain } from './terrain/FarTerrain';
import { TerrainRenderer } from './terrain/TerrainRenderer';
import { world } from './world';

export interface GameExtras {
  stars?: Float32Array;
  orthoHi?: THREE.Texture;
  constellations?: Float32Array;
  farShadow?: THREE.Texture;
  farAlbedo?: THREE.Texture;
}

/** Sun irradiance in scene units; everything else is relative to it. */
const SUN_INTENSITY = 9;
const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
/** Initial heading: west (toward Hadley Rille / the Jezero delta). */
const START_YAW = Math.PI - THREE.MathUtils.degToRad(270);
export type CameraMode = 'cabin' | 'chase' | 'top';
const CAMERA_CYCLE: CameraMode[] = ['cabin', 'chase', 'top'];

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
  readonly weather: MarsWeather | null = null;
  private hemi: THREE.HemisphereLight;
  readonly sunDir: THREE.Vector3;
  private time = 0;
  private envTau = -1;
  private still = 0;
  /** Rover size relative to the LRV (camera distances). */
  private sizeK = 1;
  private terrainR: TerrainRenderer;
  private rocks: Rocks;
  rover: Rover;
  private dust: Dust;
  private tracks: Tracks;
  private hud: Hud;
  private q: QualitySettings;
  autoQuality: boolean;
  cameraMode: CameraMode = 'cabin';
  /** Show the full HTML instrument overlay even in the cab. */
  hudOverlay = false;
  constellationsOn = false;
  private composer: EffectComposer | null = null;
  private topHeight = 70;
  private far: FarTerrain | null = null;
  /** Baked sun-shadow mask on the CPU (500²), to place impact flashes in the dark. */
  private shadowMask: Uint8Array | null = null;
  private flashTimer = 8;
  paused = true;

  private look = { yaw: 0, pitch: -0.12 };
  private orbit = { yaw: 0, pitch: 0.28, dist: 9 };
  private chasePos = new THREE.Vector3();
  private clock = new THREE.Timer();
  private fpsAcc = { t: 0, n: 0, fps: 60 };
  private perf = { t: 0, frames: 0, cooldown: 10, strikes: 0 };
  private sunTexel = 1;
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

    if (mars) {
      // Mars: dusty sky, haze, sunlight reduced to 38 % (1.63 AU) and attenuated by dust.
      this.marsSky = new MarsSky(terrain.meta.sun.azimuth, terrain.meta.sun.elevation);
      this.scene.add(this.marsSky.mesh);
      this.sunDir = this.marsSky.sunDir;
      this.scene.fog = new THREE.FogExp2(0x9a6a48, 6.5e-5);
    } else {
      // --- Moon: one hard sun, no sky light. Shadows are filled only by light
      // bounced off sunlit regolith (albedo ~0.12) — modelled as a hemisphere light
      // that reaches surfaces facing down/sideways — and by faint earthshine.
      this.sky = new Sky(terrain.meta.sun.azimuth, terrain.meta.sun.elevation, quality.stars, terrain.meta.earth, extras.stars, {
        constellations: extras.constellations,
        galaxy: terrain.meta.galaxy,
      });
      this.scene.add(this.sky.group);
      this.sunDir = this.sky.sunDir;
    }
    this.sun = new THREE.DirectionalLight(0xfff8f0, SUN_INTENSITY);
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
    }

    this.shadowMask = this.readMask(baked);
    this.terrainR = new TerrainRenderer(terrain, ortho, baked, quality, extras.orthoHi, extras.farShadow, extras.farAlbedo);
    this.scene.add(this.terrainR.group);
    if (terrain.far) {
      this.far = new FarTerrain(terrain, extras.farShadow, isMobile, extras.farAlbedo);
      this.far.setNearRadius(quality.drawDistance - 250);
      this.scene.add(this.far.mesh);
    }
    this.rocks = new Rocks(terrain, physics, quality);
    this.scene.add(this.rocks.group);

    // Moon: start ~45 m west of the LM, facing the rille (west).
    // Mars: at Octavia E. Butler Landing, facing the delta front (west).
    const [startX, startZ] = this.startPoint();
    if (!mars) this.addLunarModule(terrain.meta.landing.x, terrain.meta.landing.z);
    physics.updatePatch(startX, startZ, true);
    this.rover = this.makeRover(spec, startX, startZ, START_YAW);

    this.dust = new Dust(terrain, quality.dustParticles);
    this.scene.add(this.dust.mesh);
    this.tracks = new Tracks(terrain, spec);
    this.scene.add(this.tracks.mesh);
    this.hud = new Hud(terrain);
    this.hud.siteLabel = mars ? 'M2020' : 'LM';
    if (mars) {
      const lvl = quality.level === 'low' ? 0.35 : quality.level === 'medium' ? 0.6 : 1;
      this.weather = new MarsWeather(terrain, this.sunDir, lvl);
      this.weather.setMode(weatherMode);
      this.scene.add(this.weather.group);
      this.updateAtmosphere(0);
    }
    if (ortho.image) this.hud.setMapImage(ortho.image as CanvasImageSource);

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

  /** Swap the rover in place (menu selection), keeping position and heading. */
  setRover(spec: RoverSpec): void {
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
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0.11, 0.065, 0.04), side: THREE.BackSide }),
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
    s.camera.far = 4000;
    // Sun's angular diameter 0.53° gives a penumbra of ~1 cm per metre of
    // occluder distance: keep PCF filtering tight for hard lunar shadows.
    s.radius = 1;
    s.bias = -0.0004;
    s.normalBias = 0.03;
    s.camera.updateProjectionMatrix();
    if (s.map) {
      s.map.dispose();
      (s as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    this.sunTexel = (2 * r) / this.q.shadowMapSize;
  }

  private addLunarModule(x: number, z: number): void {
    // Falcon descent stage (ascent stage left in 1971).
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
      this.setCameraMode(CAMERA_CYCLE[(CAMERA_CYCLE.indexOf(this.cameraMode) + 1) % CAMERA_CYCLE.length]);
      this.audio.click(1800);
    } else if (a === 'top') {
      this.setCameraMode(this.cameraMode === 'top' ? 'cabin' : 'top');
      this.audio.click(1800);
    } else if (a === 'park') {
      this.rover.parkBrake = !this.rover.parkBrake;
      this.audio.click(700);
    } else if (a === 'const') {
      this.constellationsOn = this.sky?.toggleConstellations() ?? false;
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
    this.renderer.setPixelRatio(this.q.pixelRatio);
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

  /** Title screen / pause: keep the world alive (sky, weather, moving parts) without driving. */
  idleFrame(): void {
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
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.paused) {
      this.time += dt;
      this.animateRover(dt, true);
      this.updateEnvironment(dt);
      this.render();
      return;
    }
    this.time += dt;
    this.input.update(dt);
    const rover = this.rover;
    this.physics.step(dt, (h) => rover.step(h, this.input.drive));
    rover.onContacts(this.physics.takeContacts());
    rover.sync(dt);
    this.animateRover(dt, false);
    this.updatePanel(dt);
    const p = rover.object.position;
    this.physics.updatePatch(p.x, p.z);
    this.rocks.update(p);
    this.updateCamera(dt);
    this.terrainR.update(this.camera.position, p);
    this.dust.update(dt, rover, this.camera);
    this.tracks.update(rover);
    this.updateEnvironment(dt);
    this.updateSun(p);
    this.updateImpacts(dt);

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
    this.hud.update(dt, rover, this.fpsAcc.fps);
    this.audio.update(dt, rover, this.input.drive.steer, this.hud.warningLevel);
    rover.knocks.length = 0;
    this.adaptQuality(dt);
    this.render();
  }

  render(): void {
    // Eye/camera adaptation: with sunlit ground in view the faint stars wash out
    // (as on every Apollo photograph); looking up at the black sky they come back.
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const groundFrac = THREE.MathUtils.clamp(0.5 - pitch / vfov, 0, 1);
    this.sky?.setAdaptation(1 - 0.85 * THREE.MathUtils.smoothstep(groundFrac, 0.1, 0.65));
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

  /** Sky, haze, sunlight and weather of the current body. */
  private updateEnvironment(dt: number): void {
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
    const W = world();
    const sunTop = SUN_INTENSITY * W.solarFactor;
    const trans = ms.directTransmission();
    const reddening = 1 - trans;
    this.sun.intensity = sunTop * trans;
    this.sun.color.setRGB(1, 0.93 - 0.12 * reddening, 0.84 - 0.25 * reddening);
    // Sky light: irradiance = π · (mean sky radiance); the sky dome is drawn with the same model.
    const bright = sunTop * 0.3;
    ms.uniforms.uBright.value = bright;
    const c1 = ms.colorAt(new THREE.Vector3(0, 1, 0), new THREE.Color());
    const c2 = ms.colorAt(new THREE.Vector3(this.sunDir.x, 0.15, this.sunDir.z).normalize(), new THREE.Color());
    const c3 = ms.colorAt(new THREE.Vector3(-this.sunDir.x, 0.15, -this.sunDir.z).normalize(), new THREE.Color());
    const skyL = c1.multiplyScalar(0.5).add(c2.multiplyScalar(0.25)).add(c3.multiplyScalar(0.25)).multiplyScalar(bright);
    const sinEl = Math.max(0.05, this.sunDir.y);
    const eTot = this.sun.intensity * sinEl + Math.PI * (skyL.r + skyL.g + skyL.b) / 3;
    this.hemi.color.copy(skyL).multiplyScalar(Math.PI);
    this.hemi.groundColor.setRGB(0.3, 0.19, 0.12).multiplyScalar(eTot * 0.5);
    this.hemi.intensity = 1;
    // Aerial perspective: fog colour = sky near the horizon in the view direction.
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    fwd.y = 0.04;
    const fogC = ms.colorAt(fwd.normalize(), new THREE.Color()).multiplyScalar(bright * 0.92);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(fogC);
    fog.density = 6.5e-5 * Math.pow(w.tau / 0.62, 1.6);
    this.far?.setNearRadius(this.q.drawDistance - 250);
    // Camera auto-exposure (partial: storms still look dark).
    const target = THREE.MathUtils.clamp(1.45 * Math.pow(1.6 / Math.max(eTot, 0.05), 0.55), 0.8, 4.5);
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
    const wv = Math.hypot(w.wind.x, w.wind.z) + w.devilNear * 18;
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

  private updateCamera(dt: number): void {
    const rover = this.rover;
    if (this.cameraMode === 'cabin') {
      const a = rover.model.cockpitAnchor;
      a.updateMatrixWorld();
      a.getWorldPosition(this.camera.position);
      const q = rover.object.quaternion.clone();
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
      this.camera.lookAt(p.x, p.y + 0.8 * this.sizeK, p.z);
      this.camera.near = 0.2 * this.sizeK;
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private adaptQuality(dt: number): void {
    if (!this.autoQuality) return;
    this.perf.t += dt;
    this.perf.frames++;
    this.perf.cooldown -= dt;
    if (this.perf.t < 3) return;
    const fps = this.perf.frames / this.perf.t;
    this.perf.t = 0;
    this.perf.frames = 0;
    if (this.perf.cooldown > 0) return;
    const target = isMobile ? 28 : 45;
    this.perf.strikes = fps < target ? this.perf.strikes + 1 : 0;
    if (this.perf.strikes >= 2) {
      this.perf.strikes = 0;
      const pr = this.renderer.getPixelRatio();
      if (pr > 0.75) {
        this.renderer.setPixelRatio(Math.max(0.75, pr - 0.25));
        this.resize();
      } else {
        const i = LEVELS.indexOf(this.q.level);
        if (i > 0) this.setQuality(LEVELS[i - 1], true);
      }
      this.perf.cooldown = 4;
    }
  }

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

  /** Restart at the landing site. */
  restart(): void {
    const [x, z] = this.startPoint();
    this.physics.updatePatch(x, z, true);
    this.rover.placeAt(x, z, START_YAW);
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
