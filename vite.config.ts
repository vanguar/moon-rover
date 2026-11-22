import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the site from /<repo>/; override with BASE_PATH for other hosts.
const base = process.env.BASE_PATH ?? '/moon-rover/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Луноход: борозда Хэдли',
        short_name: 'Луноход',
        description: 'Езда на луноходе по реальному рельефу места посадки Аполлона-15 (LROC NAC DTM).',
        lang: 'ru',
        start_url: '.',
        scope: '.',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Game data (heightmap, ortho, shadow mask) is precached for offline play.
        globPatterns: ['**/*.{js,css,html,png,jpg,json,wasm}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
