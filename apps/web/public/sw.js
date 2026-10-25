/* Fantasyonerim service worker — offline app shell + push notifications.
 * API calls (cross-origin, NEXT_PUBLIC_API_URL) are never intercepted or cached. */
const VERSION = 'fant-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const SHELL_URLS = [
  '/',
  '/onboarding/',
  '/news/',
  '/community/',
  '/my-team/',
  '/table/',
  '/live/',
  '/profile/',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/brand/logo-320.png',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached =
      (await caches.match(request, { ignoreSearch: true })) ||
      (request.mode === 'navigate' ? await caches.match('/') : undefined);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // API + image CDNs: straight to network
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request)); // content-hashed, immutable
    return;
  }
  event.respondWith(networkFirst(request));
});

// ---------- push (Phase 2 sends these) ----------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Fantasyonerim';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      image: data.image,
      tag: data.tag,
      dir: data.dir || 'auto',
      lang: data.lang || 'he',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        const url = new URL(client.url);
        if (url.origin === target.origin) {
          if ('navigate' in client && url.href !== target.href) client.navigate(target.href);
          return client.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
