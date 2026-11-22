import * as THREE from 'three';
import './style.css';
import { autoQuality, isMobile, loadSettings, makeQuality, saveSettings, type QualityLevel } from './config';
import { Game } from './Game';
import { detectLang, LANGS, setLang, t, type Lang } from './i18n';
import type { Action } from './input/Input';
import { Physics } from './physics/Physics';
import { loadTerrainData } from './terrain/TerrainData';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

if (isMobile) document.body.classList.add('mobile');

const settings = loadSettings() as ReturnType<typeof loadSettings> & { lang?: Lang };
setLang(settings.lang ?? detectLang());

const loadBar = $<HTMLDivElement>('#load-bar');
const loadText = $<HTMLDivElement>('#load-text');
const progress = { height: 0, ortho: 0, other: 0 };
const showProgress = () => {
  const p = progress.height * 0.5 + progress.ortho * 0.3 + progress.other * 0.2;
  loadBar.style.width = `${Math.round(p * 100)}%`;
};

function loadTexture(url: string, key: 'ortho' | 'other'): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (key === 'ortho') progress.ortho = 1;
        else progress.other = Math.min(1, progress.other + 0.5);
        showProgress();
        resolve(tex);
      },
      (e) => {
        if (e.total && key === 'ortho') {
          progress.ortho = e.loaded / e.total;
          showProgress();
        }
      },
      reject,
    );
  });
}

async function boot(): Promise<void> {
  loadText.textContent = t('loading');
  const bin = (name: string) =>
    fetch(`${BASE}data/${name}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Float32Array(b) : undefined)).catch(() => undefined);
  const [terrain, ortho, baked, orthoHi, stars, constellations] = await Promise.all([
    loadTerrainData(BASE, (f) => {
      progress.height = f;
      showProgress();
    }),
    loadTexture(`${BASE}data/ortho.jpg`, 'ortho'),
    loadTexture(`${BASE}data/shadow.png`, 'other'),
    loadTexture(`${BASE}data/ortho_hi.jpg`, 'other').catch(() => undefined),
    bin('stars.bin'),
    bin('constellations.bin'),
  ]);
  loadText.textContent = t('loadPhysics');
  const physics = await Physics.create(terrain);

  const level: QualityLevel = settings.quality === 'auto' ? autoQuality() : settings.quality;
  const game = new Game($('#app'), terrain, physics, ortho, baked, makeQuality(level), settings.quality === 'auto', { stars, orthoHi, constellations });
  (window as unknown as { game: Game }).game = game;

  loadText.textContent = t('loadBuild');
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (game.isReady() || performance.now() - t0 > 15000) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
  // Live scene behind the title screen.
  game.render();
  game.renderer.setAnimationLoop(() => game.render());
  setupMenu(game);
}

function setupMenu(game: Game): void {
  const menu = $('#menu');
  const hud = $('#hud');
  const touch = $('#touch');
  const toolbar = $('#toolbar');
  const startBtn = $<HTMLButtonElement>('#start');
  const startLabel = startBtn.querySelector<HTMLElement>('span')!;
  const restartBtn = $<HTMLButtonElement>('#restart');
  const exitBtn = $<HTMLButtonElement>('#exit');
  const quality = $<HTMLSelectElement>('#quality');
  const volume = $<HTMLInputElement>('#volume');
  const tilt = $<HTMLInputElement>('#tilt');
  const langSel = $<HTMLSelectElement>('#lang');
  $('#loading').classList.add('hidden');
  $('#ready').classList.remove('hidden');

  for (const l of LANGS) langSel.add(new Option(l.name, l.id));
  langSel.value = document.documentElement.lang;
  quality.value = settings.quality;
  volume.value = String(settings.volume);
  tilt.checked = settings.tiltSteering;

  // Controls tabs: default to the device in use.
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
  const showTab = (id: string) => {
    tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    document.querySelectorAll<HTMLElement>('.tabpane').forEach((p) => p.classList.toggle('on', p.dataset.pane === id));
  };
  tabs.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));
  showTab(isMobile ? 'tc' : 'kb');

  game.input.bindTouch(touch);
  let started = false;

  langSel.addEventListener('change', () => {
    settings.lang = langSel.value as Lang;
    saveSettings(settings);
    setLang(settings.lang);
    startLabel.textContent = t(started ? 'continue' : 'start');
  });
  quality.addEventListener('change', () => {
    settings.quality = quality.value as QualityLevel | 'auto';
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
        alert(t('tiltError'));
      }
    } else game.input.disableTilt();
  });

  // Toolbar buttons -> the same actions as the keyboard.
  toolbar.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      game.input.emit(b.dataset.act as Action);
    });
  });
  const syncToolbar = () => {
    $('#tb-lights').classList.toggle('on', game.rover.headlights);
    $('#tb-park').classList.toggle('on', game.rover.parkBrake);
    $('#tb-const').classList.toggle('on', game.constellationsOn);
    document.body.classList.toggle('zoomable', game.cameraMode !== 'cabin');
    $('#h-park').classList.toggle('on', game.rover.parkBrake);
  };
  game.input.onAction(() => requestAnimationFrame(syncToolbar));
  // Mobile: tap the HUD strip to expand/collapse the full instruments.
  $('#h-panel').addEventListener('pointerdown', () => {
    if (isMobile) document.body.classList.toggle('hud-full');
  });

  const showGameUi = (on: boolean) => {
    hud.classList.toggle('hidden', !on);
    toolbar.classList.toggle('hidden', !on);
    touch.classList.toggle('hidden', !on || !isMobile);
  };

  const openMenu = () => {
    if (!started) return;
    game.setPaused(true);
    menu.classList.remove('hidden');
    showGameUi(false);
    startLabel.textContent = t('continue');
    restartBtn.classList.remove('hidden');
    exitBtn.classList.remove('hidden');
  };

  const play = async () => {
    menu.classList.add('hidden');
    showGameUi(true);
    void game.audio.start(settings.volume);
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
    syncToolbar();
  };

  startBtn.addEventListener('click', play);
  restartBtn.addEventListener('click', () => {
    game.restart();
    void play();
  });
  exitBtn.addEventListener('click', async () => {
    // Leave the drive: back to the title screen, out of fullscreen, sound off.
    game.setPaused(true);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.();
    startLabel.textContent = t('continue');
    restartBtn.classList.remove('hidden');
    exitBtn.classList.add('hidden');
    menu.scrollTop = 0;
  });

  game.input.onAction((a) => {
    if (a !== 'pause') return;
    if (menu.classList.contains('hidden')) openMenu();
    else if (started) void play();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && menu.classList.contains('hidden')) openMenu();
  });
}

boot().catch((e) => {
  console.error(e);
  loadText.textContent = `${t('loadError')}: ${e instanceof Error ? e.message : e}`;
});
