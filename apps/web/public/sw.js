/* Fantasyonerim service worker — offline app shell + push notifications.
 * API calls (cross-origin, NEXT_PUBLIC_API_URL) are never intercepted or cached.
 *
 * Updates: scripts/stamp-build.mjs replaces __BUILD_ID__ in out/sw.js on every build, so each deploy ships a
 * byte-different worker (the browser installs it on the next registration.update(), which src/lib/updates.ts calls
 * on resume and every 15 min) with fresh cache names — activate() deletes every older cache. HTML is always
 * network-first, so an old shell is only ever served offline. /version.json is never intercepted. */
const BUILD_ID = '__BUILD_ID__';
const VERSION = `fant-${BUILD_ID}`;
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
/** A navigation that takes longer than this falls back to the cached page — but only if there is one. */
const NETWORK_TIMEOUT_MS = 4000;
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
      // `reload`: bypass the HTTP cache so the new worker never precaches the previous deploy's HTML.
      .then((cache) => cache.addAll(SHELL_URLS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// The page asks a waiting worker to take over (lib/updates.ts). install() already calls skipWaiting(), but Chrome
// only evaluates it once: if the old worker was busy right then, the new one can stay "waiting" for good.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Everything but this build's two caches goes (exact names: one build id may be a prefix of another).
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cachedFallback(request) {
  return (
    (await caches.match(request, { ignoreSearch: true })) ||
    (request.mode === 'navigate' ? await caches.match('/') : undefined)
  );
}

/**
 * Network first. The cache is a fallback only when the network fails, or is slower than NETWORK_TIMEOUT_MS *and*
 * a cached copy exists (the network response still refreshes the cache in the background). No cached copy → wait
 * for the network however long it takes.
 */
async function networkFirst(request) {
  const network = fetch(request).then((response) => {
    if (response.ok) {
      // Clone now (before the page reads the body), store fire-and-forget: never hold the response back on the
      // cache write, and never extend the event with it (see untilAborted below).
      const copy = response.clone();
      caches
        .open(RUNTIME_CACHE)
        .then((cache) => cache.put(request, copy))
        .catch(() => undefined);
    }
    return response;
  });
  network.catch(() => undefined); // a failure after the cached copy was already served is not an error
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout');
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') return first;
    const cached = await cachedFallback(request);
    return cached || (await network);
  } catch (err) {
    const cached = await cachedFallback(request);
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Content-hashed assets. Only 2xx responses are cached, so a 404 for a chunk of an older deploy is never pinned. */
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

/**
 * Settles as soon as the page gives up on the request (navigated away, router prefetch cancelled). A fetch event
 * that never settles keeps this worker "busy": the next deploy's worker then can't activate despite skipWaiting(),
 * and Chrome holds new navigations until it does — so no intercepted request may outlive its page.
 */
function untilAborted(request) {
  return new Promise((resolve) => {
    const { signal } = request;
    if (!signal) return;
    if (signal.aborted) resolve(Response.error());
    else signal.addEventListener('abort', () => resolve(Response.error()), { once: true });
  });
}

function respond(event, handler) {
  event.respondWith(Promise.race([handler(event.request), untilAborted(event.request)]));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // API + image CDNs: straight to network
  if (url.pathname === '/version.json') return; // the update check must always see the live deploy
  // Uploaded media (same-origin via the CDN rewrite): left to the CDN + HTTP cache, never kept in the SW cache,
  // so a deleted community photo isn't served from here afterwards.
  if (url.pathname.startsWith('/media/')) return;
  if (url.pathname.startsWith('/_next/static/')) {
    respond(event, cacheFirst); // content-hashed, immutable
    return;
  }
  // The page's own fetch() calls (Next's RSC payloads and link prefetches) go straight to the network: the router
  // cancels them freely, and when one fails offline it falls back to a full navigation — served below.
  if (request.mode !== 'navigate' && request.destination === '') return;
  respond(event, networkFirst); // pages, icons, manifest
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
