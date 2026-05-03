const CACHE_NAME = 'algoam-cache-v5';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './styles.css',
  './canal.js',
  './canals.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        ASSETS.map(asset =>
          cache.add(asset).catch(err => console.warn('No s\'ha pogut emmagatzemar', asset, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// Network-first per a TOT: els canvis de codi s'apliquen a la primera
// recàrrega. La cache només serveix de fallback offline.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// ---------- Push notifications ----------

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { channel: 'Multiview', title: 'Nou directe' }; }

  const title = data.channel ? `${data.channel} en directe` : 'Multiview — nou directe';
  const body = data.title || 'Una nova emissió ha començat';
  const tag = data.videoId ? `live-${data.videoId}` : 'multiview-live';
  const urlToOpen = data.videoId
    ? `./?play=${encodeURIComponent(data.videoId)}`
    : './';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: urlToOpen, ...data },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      // Reuse an existing window if it's our app
      const u = new URL(client.url);
      if (u.origin === self.location.origin) {
        client.focus();
        client.navigate(targetUrl).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
