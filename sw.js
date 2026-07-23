/* Tumble Trainer v2 — service worker.
   Cache-first, offline-first. Bump CACHE on every asset change so the
   activate handler evicts the stale cache. */

const CACHE = 'tumble-trainer-v4.8.8';

const ASSETS = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'routine-seed.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the browser HTTP cache (GitHub Pages max-age=600),
  // otherwise a new worker can precache STALE copies fetched minutes earlier
  // under the new cache name.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          // Runtime-cache same-origin GETs so later loads work offline too.
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
    })
  );
});
