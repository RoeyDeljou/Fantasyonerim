/* Fantasyonerim service worker — offline app shell + push notifications.
 * API calls (cross-origin, NEXT_PUBLIC_API_URL) are never intercepted or cached. */
const VERSION = 'fant-v3';
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
  '/terms/',
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

// ---------- push ----------
// Payload shape = PushPayloadSchema in packages/shared/src/news.ts: { title, body, url, tag, icon, image }.
// Parsed defensively: a malformed push still shows *something* (browsers penalise silent pushes).

const DEFAULT_ICON = '/icons/icon-192.png';
const BADGE = '/icons/favicon-32.png';

function str(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Only same-origin, app-relative targets (e.g. "/news/?item=abc"); anything else opens News. */
function safeUrl(v) {
  const s = str(v, 500);
  if (!s || !s.startsWith('/') || s.startsWith('//')) return '/news/';
  return s;
}

function httpsUrl(v) {
  const s = str(v, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s, self.location.origin);
    return u.protocol === 'https:' || u.origin === self.location.origin ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function parsePayload(event) {
  if (!event.data) return {};
  try {
    const json = event.data.json();
    return json && typeof json === 'object' ? json : {};
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener('push', (event) => {
  const data = parsePayload(event);
  const title = str(data.title, 120) || 'Fantasyonerim · פנטזיונרים';
  const body = str(data.body, 400) || '';
  const tag = str(data.tag, 100);
  const text = title + ' ' + body;
  const options = {
    body,
    icon: httpsUrl(data.icon) || DEFAULT_ICON,
    badge: BADGE,
    // dir "auto" lets each notification follow its own text; lang is a hint for the TTS / font fallback.
    dir: 'auto',
    lang: /[֐-׿]/.test(text) ? 'he' : 'en',
    data: { url: safeUrl(data.url) },
  };
  const image = httpsUrl(data.image);
  if (image) options.image = image;
  if (tag) {
    options.tag = tag;
    // A new deadline reminder replaces the previous one but must still alert.
    options.renotify = tag.startsWith('deadline');
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    safeUrl(event.notification.data && event.notification.data.url),
    self.location.origin,
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const same = clients.filter((c) => new URL(c.url).origin === target.origin);
      const client = same.find((c) => c.focused) || same[0];
      if (client) {
        let c = client;
        if ('navigate' in client && client.url !== target.href) {
          try {
            c = (await client.navigate(target.href)) || client;
          } catch {
            // navigate() rejects for clients this worker doesn't control — open a fresh window instead
            return self.clients.openWindow(target.href);
          }
        }
        return c.focus();
      }
      return self.clients.openWindow(target.href);
    }),
  );
});

// `pushsubscriptionchange` is deliberately not handled here: the worker has no bearer token. The app re-syncs
// the subscription on every start (lib/push.ts → resyncPush), which re-POSTs the new endpoint.
