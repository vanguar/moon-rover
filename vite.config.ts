import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the site from /<repo>/; override with BASE_PATH for other hosts.
const base = process.env.BASE_PATH ?? '/moon-rover/';

export default defineConfig({
  base,
  define: {
    // Build stamp shown on the title screen (which version is really running).
    __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      // Own service worker (src/sw.ts): network-first page, see the comment there.
      // The output keeps the name sw.js so phones with the old worker pick it up as an update.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'rovers/*.jpg'],
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
        // Moon data and the app shell are precached for offline play; Mars data (~17 MB) is cached on first visit.
        globPatterns: ['**/*.{js,css,html,png,jpg,json,wasm,bin,webmanifest}'],
        globIgnores: ['**/data/mars/**', 'sw.js'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024, // heightmap.png of the 8 × 8 km site is ~14 MB
      },
    }),
  ],
});
