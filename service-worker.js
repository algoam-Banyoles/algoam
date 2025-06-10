
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

  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    // ➡️ per a HTML fem network-first
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // ⭐️ cache-first amb actualització en segon pla
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(resp => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return resp;
        });
        return cached || fetchPromise;
      })
    );
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


