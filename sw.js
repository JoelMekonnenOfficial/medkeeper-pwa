/* MedKeeper service worker.
 * - Cache-first for app shell, network fallback for everything else.
 * - Message handler for triggered actions (e.g. wake-reschedule on activate).
 * - Notification click handler focuses the app.
 * - periodicSync handler (where supported) nudges the page to recompute reminders.
 */
const CACHE = 'medkeeper-v1.1.0';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './schedule.js',
  './notifications.js',
  './pdf.js',
  './ui.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
  // Ask any open clients to recompute reminders
  notifyClients({ type: 'wake-reschedule' });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle same-origin requests; everything else passes through to network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Refresh in the background for non-navigation requests
        if (req.mode !== 'navigate') {
          fetch(req).then((res) => {
            if (res && res.ok) {
              caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => undefined);
            }
          }).catch(() => undefined);
        }
        return cached;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      }).catch(() => {
        // Offline fallback for navigations
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'skip-waiting') {
    self.skipWaiting();
  } else if (msg.type === 'notify') {
    // Page asks SW to show a notification
    try {
      self.registration.showNotification(msg.title || 'MedKeeper', {
        body: msg.body || '',
        tag: msg.tag || 'medkeeper',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-96.png',
      });
    } catch (_) {}
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'medkeeper-reschedule') {
    event.waitUntil(notifyClients({ type: 'wake-reschedule' }));
  }
});

function notifyClients(message) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    clients.forEach((c) => { try { c.postMessage(message); } catch (_) {} });
  });
}
