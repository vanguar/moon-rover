import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig } from 'vite';
import { WORLDS } from './src/world';

/**
 * Content hash of every game data file (public/data, public/models), keyed by its path
 * under public/: part of that file's URL (src/version.ts). A release re-downloads only
 * the files that really changed - not all the terrain of both worlds.
 */
function dataHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative('public', p).split(sep).join('/')] = createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 8);
    }
  };
  for (const d of ['public/data', 'public/models']) {
    try {
      walk(d);
    } catch {
      /* missing directory */
    }
  }
  return out;
}
import { VitePWA } from 'vite-plugin-pwa';
import wasm from 'vite-plugin-wasm';

// GitHub Pages serves the site from /<repo>/; override with BASE_PATH for other hosts.
const base = process.env.BASE_PATH ?? '/moon-rover/';

const DATA_HASHES = dataHashes();
/** Build-wide data stamp (shown on the title screen; fallback for unknown files). */
const DATA_VERSION = createHash('sha1').update(JSON.stringify(DATA_HASHES)).digest('hex').slice(0, 10);

/**
 * Start the big terrain downloads from the HTML itself, before the game code has
 * even arrived (they used to begin only after ~1 MB of JS was fetched and run).
 * The URLs carry the same ?v= hash as the game's own requests, and the game reads
 * every one of them with fetch() (images too, see loadTexture in src/main.ts), so
 * it picks up these responses instead of downloading again.
 */
function preloadData() {
  return {
    name: 'preload-data',
    transformIndexHtml(html: string) {
      // Site data directories and the hashes of the preloaded files (as src/version.ts).
      const files = ['terrain.json', 'heightmap.bin', 'ortho.webp', 'shadow.png'];
      const dirs: Record<string, Record<string, string>> = {};
      const hashes: Record<string, string> = {};
      for (const w of Object.values(WORLDS)) {
        dirs[w.id] = Object.fromEntries(w.sites.map((st) => [st.id, st.dataDir]));
        for (const st of w.sites) for (const f of files) hashes[st.dataDir + f] = DATA_HASHES[st.dataDir + f] ?? DATA_VERSION;
      }
      const script = `<script>(function(){try{
var D=${JSON.stringify(dirs)},H=${JSON.stringify(hashes)};
var u=new URLSearchParams(location.search),s={};
try{s=JSON.parse(localStorage.getItem('moon-rover-settings')||'{}')}catch(e){}
var w=u.get('world')||s.world;if(!D[w])w='moon';
var st=u.get('site')||(s.site||{})[w],d=D[w][st]||D[w][Object.keys(D[w])[0]];
function l(f,hi){var e=document.createElement('link');e.rel='preload';e.as='fetch';e.href=d+f+'?v='+H[d+f];e.crossOrigin='anonymous';if(hi)e.setAttribute('fetchpriority','high');document.head.appendChild(e)}
l('terrain.json',1);l('heightmap.bin',1);l('ortho.webp');l('shadow.png');
}catch(e){}})();</script>`;
      return html.replace('<head>', `<head>
    ${script}`);
    },
  };
}

export default defineConfig({
  base,
  define: {
    // Build stamp shown on the title screen (which version is really running).
    __DATA_VERSION__: JSON.stringify(DATA_VERSION),
    __DATA_HASHES__: JSON.stringify(DATA_HASHES),
    __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
  worker: { format: 'es' },
  plugins: [
    // Rapier's WebAssembly as an ES module import (top-level await; es2022 target).
    wasm(),
    preloadData(),
    VitePWA({
      // Own service worker (src/sw.ts): network-first page, see the comment there.
      // The output keeps the name sw.js so phones with the old worker pick it up as an update.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: {
        name: 'Планетоход — Луна и Марс',
        short_name: 'Планетоход',
        description: 'Езда на луноходах и марсоходах по реальному рельефу: место посадки Аполлона-15 (LROC NAC DTM) и кратер Езеро (HiRISE).',
        lang: 'ru',
        start_url: '.',
        scope: '.',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#10163a',
        theme_color: '#10163a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // The app shell is precached. Game data and models are cached by the worker on first
        // use under their versioned URLs (src/version.ts), so a release never mixes old and
        // new data and phones never download the 25 MB twice.
        globPatterns: ['**/*.{js,css,html,png,jpg,json,wasm,webmanifest}'],
        // assets/draco_*: copies three's DRACOLoader references by default; the game
        // sets its decoder path to draco/ (src/rover/models/nasa.ts) and never loads them.
        globIgnores: ['**/data/**', '**/models/**', '**/draco/**', '**/assets/draco_*', 'sw.js'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
    }),
  ],
});
