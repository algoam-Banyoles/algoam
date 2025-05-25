self.addEventListener('install', (event) => {
  console.log('Service Worker: Instal·lat');
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Actiu');
});

self.addEventListener('fetch', (event) => {
  // No cachem res per ara, només passem la sol·licitud
  event.respondWith(fetch(event.request));
});
