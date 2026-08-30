// Bump on every change to precached asset contents or this file's logic.
const CACHE_NAME = 'aflac-prospect-v4';

// Same-origin app shell — install fails if any of these are missing.
// These are native ES modules; each one is a separate request, so each one
// has to be listed.
const CORE_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/ui.js',
  '/app/store.js',
  '/app/field.js',
  '/app/d365.js',
  '/app/markdown.js',
  '/app/desktop.js',
  '/app/app.css',
  '/manifest.json',
  '/icon.jpg'
];

// CDN assets needed for full offline field use — best-effort precache.
// SheetJS is deliberately absent: it is ~950KB, desktop-only, and lazily
// loaded, so the runtime cache below picks it up after first use instead of
// making every phone pay for it on install.
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // CDN precache is best-effort: an unpkg hiccup must not block install
      cache.addAll(CDN_ASSETS).catch((err) => console.warn('CDN precache skipped:', err));
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate
self.addEventListener('fetch', (e) => {
  const { request } = e;

  // Only GETs are cacheable — let POST /api/sync etc. hit the network directly
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never serve API reads from cache. A stale activity list would show an
  // agent yesterday's pipeline as though it were today's.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        // Cache good responses, including opaque ones from CDNs (status 0)
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => { /* quota or scheme errors are non-fatal */ });
        }
        return networkResponse;
      }).catch(async () => {
        // Offline fallback. Only navigations get the app shell — returning HTML
        // for a failed stylesheet, script, or image request just swaps a clean
        // network error for a confusing MIME-type error.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/app/');
          if (shell) return shell;
        }
        return Response.error();
      });

      return cachedResponse || fetchPromise;
    })
  );
});
