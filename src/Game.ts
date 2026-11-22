import * as THREE from 'three';
import { CabinAudio } from './audio/CabinAudio';
import { isMobile, makeQuality, type QualityLevel, type QualitySettings } from './config';
import { Dust } from './fx/Dust';
import { Sky } from './fx/Sky';
import { Tracks } from './fx/Tracks';
import { Hud } from './hud/Hud';
import { Input } from './input/Input';
import { Physics } from './physics/Physics';
import { Rover } from './rover/Rover';
import { Rocks } from './terrain/Rocks';
import type { TerrainData } from './terrain/TerrainData';
import { TerrainRenderer } from './terrain/TerrainRenderer';

/** Sun irradiance in scene units; everything else is relative to it. */
const SUN_INTENSITY = 9;
const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input = new Input();
  readonly audio = new CabinAudio();
  private sun: THREE.DirectionalLight;
  private sky: Sky;
  private terrainR: TerrainRenderer;
  private rocks: Rocks;
  readonly rover: Rover;
  private dust: Dust;
  private tracks: Tracks;
  private hud: Hud;
  private q: QualitySettings;
  autoQuality: boolean;
  cameraMode: 'cabin' | 'chase' = 'cabin';
  paused = true;

  private look = { yaw: 0, pitch: -0.12 };
  private orbit = { yaw: 0, pitch: 0.28, dist: 9 };
  private chasePos = new THREE.Vector3();
  private clock = new THREE.Timer();
  private fpsAcc = { t: 0, n: 0, fps: 60 };
  private perf = { t: 0, frames: 0, cooldown: 5 };
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
  ) {
    this.q = quality;
    this.autoQuality = auto;
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(isMobile ? 75 : 68, container.clientWidth / container.clientHeight, 0.08, 20000);

    // --- Lighting: one hard sun, no sky light. Shadows are filled only by light
    // bounced off sunlit regolith (albedo ~0.12) — modelled as a hemisphere light
    // that reaches surfaces facing down/sideways — and by faint earthshine.
    this.sky = new Sky(terrain.meta.sun.azimuth, terrain.meta.sun.elevation, quality.stars, terrain.meta.earth);
    this.scene.add(this.sky.group);
    this.sun = new THREE.DirectionalLight(0xfff8f0, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.scene.add(this.sun, this.sun.target);
    this.configureShadow();
    this.scene.add(new THREE.HemisphereLight(0x000000, 0x9a948c, SUN_INTENSITY * 0.012));
    const earthshine = new THREE.DirectionalLight(0xbcd4ff, SUN_INTENSITY * 0.0015);
    earthshine.position.copy(this.sky.earthDir);
    this.scene.add(earthshine);

    this.terrainR = new TerrainRenderer(terrain, ortho, baked, quality);
    this.scene.add(this.terrainR.group);
    this.rocks = new Rocks(terrain, physics, quality);
    this.scene.add(this.rocks.group);

    // Start ~45 m west of the LM, facing the rille (west).
    const lm = terrain.meta.landing;
    const startX = lm.x - 45, startZ = lm.z + 10;
    this.addLunarModule(lm.x, lm.z);
    physics.updatePatch(startX, startZ, true);
    this.rover = new Rover(physics, terrain, this.sky.sunDir, startX, startZ, Math.PI - THREE.MathUtils.degToRad(270));
    this.scene.add(this.rover.object);
    this.rover.isRock = (c) => this.rocks.sizeOf(c);

    this.dust = new Dust(terrain, quality.dustParticles, this.sky.sunDir);
    this.scene.add(this.dust.points);
    this.tracks = new Tracks(terrain);
    this.scene.add(this.tracks.mesh);
    this.hud = new Hud(terrain);
    if (ortho.image) this.hud.setMapImage(ortho.image as CanvasImageSource);

    this.input.onAction((a) => this.onAction(a));
    this.bindLook(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
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
      if (this.cameraMode === 'cabin') {
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
      if (this.cameraMode === 'chase') this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * (1 + Math.sign(e.deltaY) * 0.1), 4, 40);
    }, { passive: true });
  }

  onAction(a: string): void {
    if (a === 'pause') return; // handled by UI
    if (this.paused) return;
    if (a === 'camera') {
      this.cameraMode = this.cameraMode === 'cabin' ? 'chase' : 'cabin';
      this.audio.setCabin(this.cameraMode === 'cabin');
      this.audio.click(1800);
      this.chasePos.set(0, 0, 0);
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
    this.terrainR.setQuality(this.q);
    this.rocks.setQuality(this.q);
    this.rocks.update(this.rover.object.position);
    this.resize();
    this.onQualityChange?.(this.q);
  }

  resize(): void {
    const c = this.renderer.domElement.parentElement!;
    const w = c.clientWidth, h = c.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dust.setViewportHeight(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  start(): void {
    this.paused = false;
    this.clock.update();
    this.audio.setCabin(this.cameraMode === 'cabin');
    this.renderer.setAnimationLoop(() => this.frame());
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
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.input.update(dt);
    const rover = this.rover;
    this.physics.step(dt, (h) => rover.step(h, this.input.drive));
    rover.onContacts(this.physics.takeContacts());
    rover.sync(dt);
    this.updatePanel(dt);
    rover.knocks.length = 0;
    const p = rover.object.position;
    this.physics.updatePatch(p.x, p.z);
    this.rocks.update(p);
    this.updateCamera(dt);
    this.terrainR.update(this.camera.position, p);
    this.dust.update(dt, rover);
    this.tracks.update(rover);
    this.sky.update(this.camera, this.terrain.height(this.camera.position.x, this.camera.position.z));
    this.updateSun(p);

    this.fpsAcc.t += dt;
    this.fpsAcc.n++;
    if (this.fpsAcc.t > 0.5) {
      this.fpsAcc.fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc.t = 0;
      this.fpsAcc.n = 0;
    }
    this.hud.update(dt, rover, this.fpsAcc.fps);
    this.audio.update(dt, rover, this.input.drive.steer, this.hud.warningLevel);
    this.adaptQuality(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private updatePanel(dt: number): void {
    const r = this.rover;
    const p = r.object.position;
    const t = this.terrain;
    const { roll, pitch, heading } = r.attitude();
    const lm = t.meta.landing;
    const dx = lm.x - p.x, dz = lm.z - p.z;
    let bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (bearing < 0) bearing += 360;
    const n = [0, 1, 0];
    t.normal(p.x, p.z, n, 1.5);
    r.model.panel.update(dt, {
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
    const dir = this.sky.sunDir;
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
      this.camera.near = 0.08;
    } else {
      const p = rover.object.position;
      const f = rover.forwardVector(new THREE.Vector3());
      const yaw = Math.atan2(f.x, f.z) + this.orbit.yaw;
      const d = this.orbit.dist;
      const target = new THREE.Vector3(
        p.x - Math.sin(yaw) * Math.cos(this.orbit.pitch) * d,
        p.y + Math.sin(this.orbit.pitch) * d + 1.2,
        p.z - Math.cos(yaw) * Math.cos(this.orbit.pitch) * d,
      );
      if (this.chasePos.lengthSq() === 0 || dt === 0) this.chasePos.copy(target);
      else this.chasePos.lerp(target, 1 - Math.exp(-dt * 5));
      const gy = this.terrain.height(this.chasePos.x, this.chasePos.z) + 0.6;
      if (this.chasePos.y < gy) this.chasePos.y = gy;
      this.camera.position.copy(this.chasePos);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(p.x, p.y + 0.8, p.z);
      this.camera.near = 0.2;
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
    const target = isMobile ? 30 : 55;
    if (fps < target * 0.92) {
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

  get stats(): { fps: number; rocks: number; calls: number; tris: number } {
    const info = this.renderer.info.render;
    return { fps: this.fpsAcc.fps, rocks: this.rocks.count(), calls: info.calls, tris: info.triangles };
  }
}
