// JATA Qi Admin Console — service worker (PWA shell).
// Strategy:
//   - /ui/* static assets: cache-first (fast offline shell)
//   - everything else (API calls): network-first, never cached
// Version the cache so deploys invalidate stale shells.

const CACHE = 'jataqi-console-v1';
const SHELL = ['/ui/', '/ui/index.html', '/ui/app.js', '/ui/style.css', '/ui/manifest.json', '/ui/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin (API keys etc.)
  if (url.pathname.startsWith('/ui/')) {
    // Cache-first for the shell; fall back to the network, then to the index.
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => caches.match('/ui/index.html'))),
    );
  }
  // API and everything else: network-first, no caching.
});
