// DAT One — Service Worker
// Cache-first for static assets, network-only for API/auth calls
const CACHE_NAME = 'dat-one-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(STATIC_ASSETS).catch((err) =>
        console.warn('[SW] Pre-cache partial failure (non-fatal):', err)
      )
    )
  );
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: routing ────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API and auth — always network, never cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Non-GET — always network
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // Static assets — cache-first with background revalidation
  event.respondWith(
    caches.match(request).then((cached) => {
      // Revalidate in background even when serving from cache
      const networkFetch = fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      }).catch(() => {});

      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline: serve cached index.html for navigation
          if (request.destination === 'document') return caches.match('/index.html');
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
    })
  );
});
