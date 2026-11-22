import * as THREE from 'three';
import './style.css';
import { autoQuality, isMobile, loadSettings, makeQuality, saveSettings, type QualityLevel } from './config';
import { Game } from './Game';
import { Physics } from './physics/Physics';
import { loadTerrainData } from './terrain/TerrainData';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

if (isMobile) document.body.classList.add('mobile');

const settings = loadSettings();
const loadBar = $<HTMLDivElement>('#load-bar');
const loadText = $<HTMLDivElement>('#load-text');
const progress = { height: 0, ortho: 0, other: 0 };
const showProgress = () => {
  const p = progress.height * 0.55 + progress.ortho * 0.35 + progress.other * 0.1;
  loadBar.style.width = `${Math.round(p * 100)}%`;
};

function loadTexture(url: string, key: 'ortho' | 'other'): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (t) => {
        progress[key] = 1;
        showProgress();
        resolve(t);
      },
      (e) => {
        if (e.total) {
          progress[key] = e.loaded / e.total;
          showProgress();
        }
      },
      reject,
    );
  });
}

async function boot(): Promise<void> {
  loadText.textContent = 'Загрузка рельефа LROC NAC DTM…';
  const [terrain, ortho, baked] = await Promise.all([
    loadTerrainData(BASE, (f) => {
      progress.height = f;
      showProgress();
    }),
    loadTexture(`${BASE}data/ortho.jpg`, 'ortho'),
    loadTexture(`${BASE}data/shadow.png`, 'other'),
  ]);
  loadText.textContent = 'Физика…';
  const physics = await Physics.create(terrain);

  const level: QualityLevel = settings.quality === 'auto' ? autoQuality() : settings.quality;
  const game = new Game($('#app'), terrain, physics, ortho, baked, makeQuality(level), settings.quality === 'auto');
  (window as unknown as { game: Game }).game = game;

  loadText.textContent = 'Построение рельефа…';
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (game.isReady() || performance.now() - t0 > 15000) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
  // Pre-render behind the menu so the scene is visible.
  game.renderer.render(game.scene, game.camera);
  game.renderer.setAnimationLoop(() => game.renderer.render(game.scene, game.camera));

  setupMenu(game);
}

function setupMenu(game: Game): void {
  const menu = $('#menu');
  const hud = $('#hud');
  const touch = $('#touch');
  const startBtn = $<HTMLButtonElement>('#start');
  const quality = $<HTMLSelectElement>('#quality');
  const volume = $<HTMLInputElement>('#volume');
  const tilt = $<HTMLInputElement>('#tilt');
  $('#loading').classList.add('hidden');
  $('#ready').classList.remove('hidden');
  quality.value = settings.quality;
  volume.value = String(settings.volume);
  tilt.checked = settings.tiltSteering;

  game.input.bindTouch(touch);
  let started = false;

  quality.addEventListener('change', () => {
    settings.quality = quality.value as UserQuality;
    saveSettings(settings);
    const lvl = settings.quality === 'auto' ? autoQuality() : settings.quality;
    game.setQuality(lvl, settings.quality === 'auto');
  });
  volume.addEventListener('input', () => {
    settings.volume = Number(volume.value);
    saveSettings(settings);
    game.audio.setVolume(settings.volume);
  });
  tilt.addEventListener('change', async () => {
    settings.tiltSteering = tilt.checked;
    saveSettings(settings);
    if (tilt.checked) {
      // iOS requires the permission request inside a user gesture.
      const ok = await game.input.enableTilt();
      if (!ok) {
        tilt.checked = false;
        settings.tiltSteering = false;
        alert('Датчик ориентации недоступен или доступ запрещён.');
      }
    } else game.input.disableTilt();
  });

  const openMenu = () => {
    if (!started) return;
    game.setPaused(true);
    menu.classList.remove('hidden');
    startBtn.textContent = 'ПРОДОЛЖИТЬ';
  };

  startBtn.addEventListener('click', async () => {
    menu.classList.add('hidden');
    hud.classList.remove('hidden');
    if (isMobile) touch.classList.remove('hidden');
    game.audio.start(settings.volume);
    if (isMobile) {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
      } catch {
        /* not supported (iOS Safari) — the PWA manifest asks for landscape */
      }
    }
    if (settings.tiltSteering && !game.input.tiltEnabled) await game.input.enableTilt();
    else game.input.calibrateTilt();
    if (!started) {
      started = true;
      game.start();
    } else game.setPaused(false);
  });

  game.input.onAction((a) => {
    if (a !== 'pause') return;
    if (menu.classList.contains('hidden')) openMenu();
    else if (started) startBtn.click();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) openMenu();
  });
}

type UserQuality = QualityLevel | 'auto';

boot().catch((e) => {
  console.error(e);
  loadText.textContent = `Ошибка загрузки: ${e instanceof Error ? e.message : e}`;
});
