
const CACHE_NAME = 'algoam-cache-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/styles.css'
];

self.addEventListener('install', event => {
  console.log('Service Worker: Instal·lat');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting(); // 🔁 activa la nova versió immediatament
});

self.addEventListener('activate', event => {
  console.log('Service Worker: Actiu');
  event.waitUntil(clients.claim()); // 🧠 força que totes les pàgines usin el nou SW
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});



self.addEventListener('install', (event) => {
  console.log('Service Worker: Instal·lat');
  self.skipWaiting(); // 🔁 activa la nova versió immediatament
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Actiu');
  event.waitUntil(clients.claim()); // 🧠 força que totes les pàgines usin el nou SW
});

self.addEventListener('fetch', (event) => {
  // No cachem res per ara, només passem la sol·licitud
  event.respondWith(fetch(event.request));
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});


