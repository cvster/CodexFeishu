// Legacy service worker retained only to clean up previously cached builds.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', () => {
  // Intentionally no offline caching. Always fall through to the network.
});
