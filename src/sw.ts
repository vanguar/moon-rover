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
 *  - data, photos and icons: served from the cache at once and revalidated in
 *    the background (stale-while-revalidate);
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
        if (key !== CACHE && key !== RUNTIME) await caches.delete(key);
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
  } else if (path.startsWith('assets/')) {
    e.respondWith(cacheFirst(req));
  } else {
    e.respondWith(staleWhileRevalidate(req, e));
  }
});
