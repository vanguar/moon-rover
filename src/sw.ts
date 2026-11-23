/// <reference lib="webworker" />
/**
 * Service worker — the newest build on every launch, the game still works offline.
 *
 * Lessons from the previous (Workbox, precache-first) worker: the phone kept
 * showing the old version because the page itself came from the precache.
 * Here:
 *  - the page (navigations, *.html, manifest) is network-first, fetched with
 *    `cache: 'no-cache'` past the browser's HTTP cache (GitHub Pages sets
 *    max-age=600), the cached copy is only the offline fallback;
 *  - code in /assets/ has content-hashed names: cache-first is safe — a fresh
 *    page references new files, which simply are not in the cache yet;
 *  - game data and models (data/, models/, draco/) carry a content-hash query
 *    (?v=…, src/version.ts): cache-first on the exact URL, so a new release always
 *    downloads changed data and can never mix it with stale files; older versions
 *    of the same file are deleted from the cache; offline, any cached copy is used;
 *  - photos and icons: served from the cache at once and revalidated in the
 *    background (stale-while-revalidate);
 *  - skipWaiting() first, before precaching; files are precached one by one so
 *    one failed request cannot abort the installation of a new version;
 *  - activate deletes every cache that is not ours (including old Workbox ones).
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

interface ManifestEntry {
  url: string;
  revision: string | null;
}
// Filled in at build time by vite-plugin-pwa (injectManifest).
const MANIFEST = (self as unknown as { __WB_MANIFEST: ManifestEntry[] }).__WB_MANIFEST;

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const BUILD = hash(JSON.stringify(MANIFEST));
const PREFIX = 'planetokhod:';
const CACHE = `${PREFIX}${BUILD}`;
const RUNTIME = `${PREFIX}runtime`;
const SCOPE = new URL(sw.registration.scope);

sw.addEventListener('install', (e) => {
  void sw.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        MANIFEST.map((m) => {
          const url = new URL(m.url, SCOPE).href;
          return c.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('[SW] precache failed', url, err));
        }),
      ),
    ),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE && key !== RUNTIME && key !== DATA) await caches.delete(key);
      }
      // Unversioned copies of game data from older releases (now served from DATA).
      const rt = await caches.open(RUNTIME);
      for (const k of await rt.keys()) {
        const p = new URL(k.url).pathname.slice(SCOPE.pathname.length);
        if (p.startsWith('data/') || p.startsWith('models/')) await rt.delete(k);
      }
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') void sw.skipWaiting();
});

async function fromCache(req: Request | string): Promise<Response | undefined> {
  return (await caches.match(req, { ignoreSearch: typeof req !== 'string' && req.mode === 'navigate' })) ?? undefined;
}

async function put(cacheName: string, req: Request, res: Response): Promise<void> {
  if (!res.ok || res.type === 'opaque') return;
  const c = await caches.open(cacheName);
  await c.put(req, res);
}

async function networkFirst(req: Request, fallback?: string): Promise<Response> {
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) void put(RUNTIME, req, res.clone());
    return res;
  } catch (err) {
    const hit = (await fromCache(req)) ?? (fallback ? await fromCache(fallback) : undefined);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const hit = await fromCache(req);
  if (hit) return hit;
  const res = await fetch(req);
  void put(RUNTIME, req, res.clone());
  return res;
}

const DATA = `${PREFIX}data`;

/** Versioned game data: exact-URL cache-first; one cached version per file. */
async function versionedData(req: Request): Promise<Response> {
  const c = await caches.open(DATA);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok && res.type !== 'opaque') {
      const path = new URL(req.url).pathname;
      for (const k of await c.keys()) if (new URL(k.url).pathname === path) await c.delete(k);
      await c.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const old = await c.match(req, { ignoreSearch: true });
    if (old) return old;
    throw err;
  }
}

async function staleWhileRevalidate(req: Request, event: FetchEvent): Promise<Response> {
  const hit = await fromCache(req);
  const net = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) void put(RUNTIME, req, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(net.catch(() => undefined));
    return hit;
  }
  return net;
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (req.mode === 'navigate' || path === '' || path.endsWith('.html') || path.endsWith('.webmanifest')) {
    e.respondWith(networkFirst(req, new URL('index.html', SCOPE).href));
  } else if (path.startsWith('data/') || path.startsWith('models/') || path.startsWith('draco/')) {
    e.respondWith(versionedData(req));
  } else if (path.startsWith('assets/')) {
    e.respondWith(cacheFirst(req));
  } else {
    e.respondWith(staleWhileRevalidate(req, e));
  }
});
