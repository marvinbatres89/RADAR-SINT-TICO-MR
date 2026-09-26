const CACHE_NAME = 'radar-sintetico-v1.9.0';
const urlsToCache = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/lightweight-charts@5.0.8/dist/lightweight-charts.standalone.production.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
