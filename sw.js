const CACHE = 'invoice-mgr-v10';
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

// On install — cache everything and immediately take over
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      '/',
      '/index.html',
      '/manifest.json',
      '/icon-192.png',
      '/icon-512.png'
    ])).catch(() => {})
  );
  /* The spreadsheet library is fetched from a CDN, so without this the
     three Excel exports are dead on a device that has never been online.
     Cached in its own call: addAll rejects the whole batch if any one
     entry fails, and a cross-origin miss must not take the app with it. */
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.add(new Request(XLSX_URL, { mode: 'cors' })))
      .catch(() => {})
  );
});

// On activate — delete ALL old caches immediately, take control of all tabs
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, cache fallback
// If network succeeds, always update the cache with fresh content
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Got fresh response — update cache
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(e.request).then(cached => {
          if (cached) return cached;
          // Return cached index.html for navigation requests
          if (e.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
  );
});

// Allow pages to trigger immediate update
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
