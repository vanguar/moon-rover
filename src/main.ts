import * as THREE from 'three';
import './style.css';
import './ui/garage.css';
import { autoQuality, isMobile, loadSettings, makeQuality, saveSettings, type QualityLevel } from './config';
import { Game } from './Game';
import type { WeatherMode } from './fx/MarsWeather';
import { detectLang, LANGS, setLang, setVariant, t, type Lang } from './i18n';
import type { Action } from './input/Input';
import { Physics } from './physics/Physics';
import { roversFor } from './rover/specs';
import { loadTerrainData } from './terrain/TerrainData';
import { Garage } from './ui/Garage';
import { dataUrl } from './version';
import { setWorld, type WorldId } from './world';

const BASE = import.meta.env.BASE_URL;

// PWA: always run the newest build (see src/sw.ts).
// - updateViaCache 'none': GitHub Pages serves sw.js with max-age=600; without
//   this the update check can look at a stale HTTP-cached copy for 10 minutes;
// - an update check at every launch and every return to the foreground;
// - when a new worker replaces an old one (the first launch after a deploy), the
//   page is reloaded once so the fresh build is shown right away — on the title
//   screen at once, during a drive only once the app goes to the background.
declare const __APP_BUILD__: string;
let playing = false;
let pendingReload = false;
let reloaded = false;
const reloadNow = () => {
  if (reloaded) return;
  reloaded = true;
  location.reload();
};
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install: the page is already fresh
    if (playing) pendingReload = true;
    else reloadNow();
  });
  navigator.serviceWorker
    .register(`${BASE}sw.js`, { scope: BASE, updateViaCache: 'none' })
    .then((reg) => {
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => undefined);
      };
      check();
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) w.postMessage('SKIP_WAITING');
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && pendingReload) reloadNow();
        else if (!document.hidden) check();
      });
      setInterval(check, 30 * 60 * 1000);
    })
    .catch((e) => console.warn('[SW] registration failed', e));
}

/** Emergency reset: drop the worker and the caches, then load from the network. */
async function hardReset(): Promise<void> {
  setTimeout(reloadNow, 4000);
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.filter((r) => r.scope === new URL(BASE, location.origin).href).map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('planetokhod:') || k.startsWith('workbox') || k === 'pages' || k === 'mars-data').map((k) => caches.delete(k)));
    }
  } finally {
    reloadNow();
  }
}

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

if (isMobile) document.body.classList.add('mobile');

const settings = loadSettings() as ReturnType<typeof loadSettings> & { lang?: Lang };
// ?world=mars in the URL overrides the saved choice (shareable links).
const urlWorld = new URLSearchParams(location.search).get('world');
if (urlWorld === 'moon' || urlWorld === 'mars') settings.world = urlWorld;
const W = setWorld(settings.world);
document.body.classList.add(`world-${W.id}`);
setVariant(W.id);
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
  const D = `${BASE}${W.dataDir}`;
  const moon = W.id === 'moon';
  const bin = (name: string) =>
    fetch(dataUrl(`${D}${name}`)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Float32Array(b) : undefined)).catch(() => undefined);
  const [terrain, ortho, baked, orthoHi, stars, constellations, farShadow, farAlbedo] = await Promise.all([
    loadTerrainData(D, (f) => {
      progress.height = f;
      showProgress();
    }),
    loadTexture(dataUrl(`${D}ortho.jpg`), 'ortho'),
    loadTexture(dataUrl(`${D}shadow.png`), 'other'),
    loadTexture(dataUrl(`${D}ortho_hi.jpg`), 'other').catch(() => undefined),
    moon ? bin('stars.bin') : Promise.resolve(undefined),
    moon ? bin('constellations.bin') : Promise.resolve(undefined),
    loadTexture(dataUrl(`${D}far_shadow.png`), 'other').catch(() => undefined),
    moon ? Promise.resolve(undefined) : loadTexture(dataUrl(`${D}far_albedo.jpg`), 'other').catch(() => undefined),
  ]);
  loadText.textContent = t('loadPhysics');
  const physics = await Physics.create(terrain);

  const level: QualityLevel = settings.quality === 'auto' ? autoQuality() : settings.quality;
  const list = roversFor(W.id);
  const spec = list.find((r) => r.id === settings.rover[W.id]) ?? list[0];
  const game = new Game($('#app'), terrain, physics, ortho, baked, makeQuality(level), settings.quality === 'auto', { stars, orthoHi, constellations, farShadow, farAlbedo }, spec, settings.weather);
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
  // Live scene behind the title screen (sky, weather and the rover's moving parts keep going).
  game.render();
  game.renderer.setAnimationLoop(() => game.idleFrame());
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
  $('#app-version').textContent = __APP_BUILD__;
  $('#hard-reset').addEventListener('click', () => {
    if (confirm(t('resetConfirm'))) void hardReset();
  });
  const weatherSel = $<HTMLSelectElement>('#weather');
  weatherSel.value = settings.weather;

  // Menu sections: rover garage / settings / controls.
  const mtabs = document.querySelectorAll<HTMLButtonElement>('.mtab');
  const showSection = (id: string) => {
    mtabs.forEach((b) => b.classList.toggle('on', b.dataset.mt === id));
    document.querySelectorAll<HTMLElement>('.mpane').forEach((p) => p.classList.toggle('on', p.dataset.mp === id));
    if (id === 'garage') garage.start();
    else garage.stop();
  };
  const garage = new Garage(
    W.id,
    game.rover.spec.id,
    (s) => {
      settings.rover[W.id] = s.id;
      saveSettings(settings);
      game.setRover(s);
      syncToolbar();
    },
    (w: WorldId) => {
      // A different body needs its own terrain, physics and sky: reload into it.
      settings.world = w;
      saveSettings(settings);
      $('#world-note').textContent = t('worldLoading');
      document.body.classList.add('switching');
      const u = new URL(location.href);
      u.searchParams.delete('world');
      setTimeout(() => location.replace(u.toString()), 60);
    },
  );
  mtabs.forEach((b) => b.addEventListener('click', () => showSection(b.dataset.mt!)));
  showSection('garage');
  weatherSel.addEventListener('change', () => {
    settings.weather = weatherSel.value as WeatherMode;
    saveSettings(settings);
    game.setWeather(settings.weather);
  });
  game.onWeatherChange = (m) => {
    settings.weather = m;
    saveSettings(settings);
    weatherSel.value = m;
  };

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
    garage.updateTexts();
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
  function syncToolbar(): void {
    $('#tb-lights').classList.toggle('on', game.rover.headlights);
    $('#tb-park').classList.toggle('on', game.rover.parkBrake);
    $('#tb-const').classList.toggle('on', game.constellationsOn);
    document.body.classList.toggle('zoomable', game.cameraMode !== 'cabin');
    $('#h-park').classList.toggle('on', game.rover.parkBrake);
    $('#tb-weather').classList.toggle('on', game.weather?.mode === 'storm' || game.weather?.mode === 'devils');
  }
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
    if (document.querySelector('.mtab.on')?.getAttribute('data-mt') === 'garage') garage.start();
    showGameUi(false);
    startLabel.textContent = t('continue');
    restartBtn.classList.remove('hidden');
    exitBtn.classList.remove('hidden');
  };

  const play = async () => {
    playing = true;
    menu.classList.add('hidden');
    garage.stop();
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
