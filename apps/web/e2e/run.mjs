/* global document, window, navigator, caches, Event, PromiseRejectionEvent, getComputedStyle */
// End-to-end suite for the web app: real apps/api (FPL_MODE=demo) + the static export, driven by Playwright.
//
//   npm run e2e -w @fant/web
//
// What it does (see apps/web/README.md):
//   1. recreates a dedicated Postgres database (fantasyonerim_e2e) and runs `prisma migrate deploy`
//   2. builds the static export into apps/web/out/.e2e with NEXT_PUBLIC_API_URL pointing at the e2e API
//      (+ a production-like copy in out/.e2e-cdn with the Vercel `/cdn/` JSON paths on, served one port up)
//   3. boots apps/api on :4100 in demo mode (offline, deterministic FPL data) and serves the export on :5100
//   4. runs the user journeys below at a 390×844 phone viewport and fails on any unexpected console error
//
// Env overrides: E2E_DB_NAME, E2E_DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT, E2E_SKIP_BUILD=1, E2E_SKIP_DB_RESET=1, E2E_HEADED=1,
// E2E_ONLY_UPDATES=1 (register, then only the app-update journeys), E2E_DEBUG_DIR=<dir> (screenshot + text of every
// open page when a journey fails).
import { spawn, spawnSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // globally installed; not a dependency of the repo

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(WEB_DIR, '../..');
const API_DIR = path.join(ROOT, 'apps/api');
const DIST = 'out/.e2e';
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5100);
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
// A second, production-like copy of the export (built with the Vercel CDN paths on: FANT_CDN_JSON=1) served one
// port up, with `/cdn/*` proxied to the API like vercel.json's rewrite.
const CDN_DIST = 'out/.e2e-cdn';
const WEB_CDN_PORT = WEB_PORT + 1;
const WEB_CDN = `http://localhost:${WEB_CDN_PORT}`;
// Parallel runs (several agents / CI jobs on one Postgres) each pick their own: E2E_DB_NAME=fantasyonerim_e2e_web
const DB_NAME = process.env.E2E_DB_NAME ?? 'fantasyonerim_e2e';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `postgresql://fant:fant@localhost:5432/${DB_NAME}`;
const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password' };
const DEMO = {
  tripleCaptain: '1000003',
  normal: '1000001',
  vice: '1000002',
  league: '314159',
  // fresh fans for the admin-invite journeys
  host: '1000004',
  reuser: '1000005',
  redeemer: '1000006',
  lateInvitee: '1000007',
};

const log = (...a) => console.warn('[e2e]', ...a);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

// ---------- 1. database ----------
function resetDatabase() {
  if (process.env.E2E_SKIP_DB_RESET) return;
  log(`recreating database ${DB_NAME}`);
  const asPostgres = (args) => spawnSync('sudo', ['-n', '-u', 'postgres', ...args], { stdio: 'inherit' });
  let r = asPostgres(['dropdb', '--if-exists', DB_NAME]);
  if (r.status === 0) r = asPostgres(['createdb', '-O', 'fant', DB_NAME]);
  if (r.status !== 0) {
    // No sudo: fall back to the connection user (needs CREATEDB).
    spawnSync('dropdb', ['--if-exists', '-h', 'localhost', '-U', 'fant', DB_NAME], { stdio: 'inherit' });
    run('createdb', ['-h', 'localhost', '-U', 'fant', DB_NAME], {
      env: { ...process.env, PGPASSWORD: 'fant' },
    });
  }
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: API_DIR, env: { ...process.env, DATABASE_URL } });
}

// News fixtures: the content jobs are disabled in e2e (no network), so the feed is seeded straight into the
// throwaway database — three real-looking episodes (both links / Apple only / not on the platforms yet) and
// one unexpired Instagram story whose media is served by the static export itself.
const EP = {
  both: {
    id: 'e2e_ep62',
    title: "פרק 62 - אין צ'יפים, נגמרו הצ'יפים",
    spotify: 'https://open.spotify.com/episode/e2e62',
    apple: 'https://podcasts.apple.com/il/podcast/id1819558192?i=1000000062',
  },
  apple: {
    id: 'e2e_ep61',
    title: 'פרק 61 - לגרוס את כולם',
    apple: 'https://podcasts.apple.com/il/podcast/id1819558192?i=1000000061',
  },
  none: { id: 'e2e_ep63', title: 'פרק 63 - עוד לא בפלטפורמות' },
};
function seedNews() {
  const links = (l) =>
    `'${JSON.stringify({ spotify: l.spotify ?? null, apple: l.apple ?? null, instagram: l.instagram ?? null, x: null, audio: 'https://example.invalid/a.mp3' })}'`;
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const ep = (e, n, hoursAgo) =>
    `(${q(e.id)}, ${q('e2e-' + e.id)}, 'podcast', ${q(e.title)}, 'תיאור הפרק — e2e', ${links(e)}, '{"episodeNumber":${n},"seasonNumber":null,"durationSec":4403}', now() - interval '${hoursAgo} hours', NULL, now())`;
  const sql = `
    INSERT INTO "NewsItem"(id,"dedupeKey",source,title,text,links,podcast,"publishedAt","expiresAt","updatedAt") VALUES
    ${ep(EP.none, 63, 1)}, ${ep(EP.both, 62, 30)}, ${ep(EP.apple, 61, 200)},
    ('e2e_story', 'e2e-story', 'instagram_story', NULL, NULL, ${links({ instagram: 'https://www.instagram.com/stories/fantasyonerimfpl/' })}, NULL, now() - interval '2 hours', now() + interval '22 hours', now());
    INSERT INTO "NewsMedia"(id,"itemId","order",kind,url,"posterUrl",width,height,"sourceUrl") VALUES
    ('e2e_story_m', 'e2e_story', 0, 'image', '${WEB}/icons/icon-512.png', NULL, 512, 512, 'e2e');`;
  run('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql]);
}

// YouTube fixtures. apps/api (demo mode) doesn't serve YouTube items yet, so they are injected into the user
// context's GET /v1/news responses (first page only) — the episode gets a YouTube link, plus one Short and one
// regular video. Real data: Shorts thumbnails are 1080×1920, videos 1280×720.
const YT = {
  episodeUrl: 'https://www.youtube.com/watch?v=zDzFZbqJUa0',
  short: { id: 'e2e_yt_short', videoId: 'uf2qPDejzuk', url: 'https://www.youtube.com/shorts/uf2qPDejzuk' },
  video: { id: 'e2e_yt_video', videoId: 'zDzFZbqJUa0', url: 'https://www.youtube.com/watch?v=zDzFZbqJUa0' },
};
function ytItem(source, v, title, hoursAgo, w, h) {
  return {
    id: v.id,
    source,
    title,
    text: null,
    media: [{ kind: 'image', url: `${WEB}/icons/icon-512.png`, posterUrl: null, width: w, height: h }],
    links: { spotify: null, apple: null, instagram: null, x: null, youtube: v.url, audio: null, web: null },
    podcast: null,
    publishedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    expiresAt: null,
  };
}
async function injectYouTube(ctx) {
  await ctx.route(
    (u) => u.origin === API && u.pathname === '/v1/news',
    async (r) => {
      const params = new URL(r.request().url()).searchParams;
      if (r.request().method() !== 'GET' || params.get('cursor')) return r.continue();
      const filter = params.get('filter');
      const res = await r.fetch();
      const body = await res.json();
      const items = body.items.map((i) =>
        i.id === EP.both.id ? { ...i, links: { ...i.links, youtube: YT.episodeUrl } } : i,
      );
      const extra = [
        ytItem(
          'youtube_short',
          YT.short,
          'שורט e2e: הקפטן של השבוע ומה עושים עם הצ׳יפים שנשארו לנו עד סוף העונה',
          3,
          1080,
          1920,
        ),
        ytItem('youtube_video', YT.video, 'סרטון e2e', 50, 1280, 720),
      ];
      const want = { shorts: 'youtube_short', videos: 'youtube_video' }[filter ?? ''];
      items.push(...extra.filter((i) => !filter || i.source === want));
      items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      await r.fulfill({ response: res, json: { ...body, items } });
    },
  );
  // The injected items make "Shorts" and "Videos" non-empty, so their chips are listed too.
  await ctx.route(
    (u) => u.origin === API && u.pathname === '/v1/news/filters',
    async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      const have = new Set([...body.filters, 'shorts', 'videos']);
      const order = ['episodes', 'shorts', 'videos', 'instagram', 'x', 'updates'];
      await r.fulfill({ response: res, json: { filters: order.filter((f) => have.has(f)) } });
    },
  );
}

/** A throwaway VAPID pair so /v1/push/vapid-public-key answers (P-256, base64url). */
function vapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

// ---------- 2. static build ----------
function buildWeb(dist = DIST, extraEnv = {}) {
  if (process.env.E2E_SKIP_BUILD && existsSync(path.join(WEB_DIR, dist, 'index.html'))) return;
  log(`building static export for e2e (${dist})`);
  const envFile = path.join(WEB_DIR, 'next-env.d.ts');
  const envBackup = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
  try {
    run('npx', ['next', 'build'], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: API,
        FANT_E2E_DIST: dist,
        NEXT_TELEMETRY_DISABLED: '1',
        FANT_CDN_JSON: '0',
        VERCEL: '',
        ...extraEnv,
      },
    });
    // the same post-build step as `npm run build` (version.json + build-stamped sw.js)
    run('node', ['scripts/stamp-build.mjs', dist], { cwd: WEB_DIR });
  } finally {
    if (envBackup !== null) writeFileSync(envFile, envBackup);
  }
}

// ---------- 3. servers ----------
async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await globalThis.fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const VAPID = vapidKeys();
// Uploaded community photos land here (LocalDiskMediaStore, served by the e2e API under /media/*).
const MEDIA_DIR = mkdtempSync(path.join(tmpdir(), 'fant-e2e-media-'));

/** A small valid RGB PNG (gradient), generated in-process so the suite needs no fixture files. */
function makePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = 61 + Math.round((x / width) * 138); // purple → mint
      raw[row + 2 + x * 3] = 24 + Math.round((y / height) * 215);
      raw[row + 3 + x * 3] = 91 + Math.round((x / width) * 122);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function startApi() {
  log(`starting apps/api (demo) on ${API}`);
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: API_DIR,
    detached: true, // own process group, so the whole npx → tsx → node tree is stopped at the end
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      FPL_MODE: 'demo',
      CORS_ORIGINS: `${WEB},${WEB_CDN}`,
      ADMIN_BOOTSTRAP_USERNAME: ADMIN.username,
      ADMIN_BOOTSTRAP_PASSWORD: ADMIN.password,
      SECRETS_KEY: randomBytes(32).toString('base64'),
      JOBS_ENABLED: 'false', // no network in e2e: News is seeded (seedNews)
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPID_PRIVATE_KEY: VAPID.privateKey,
      VAPID_SUBJECT: 'mailto:e2e@example.com',
      API_PUBLIC_URL: API,
      WEB_APP_URL: WEB, // admin invite links point at the e2e web app
      MEDIA_STORE: 'local',
      MEDIA_DIR,
      LOG_LEVEL: 'warn',
    },
  });
  return child;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
};

/**
 * "Deploy" simulation for the update journeys: while set, every text file is served with the build id `from`
 * replaced by `to` — HTML (<html data-build>), version.json and a byte-different sw.js, i.e. what a new deploy looks
 * like to an installed app, without a second `next build`.
 */
const deploy = { from: null, to: null };
/** Requests the production-like copy sent to its `/cdn/*` proxy. */
const cdnHits = [];
const SWAPPED = new Set(['.html', '.js', '.txt', '.json']);

function startStatic(dist = DIST, port = WEB_PORT, cdnProxy = false) {
  const root = path.join(WEB_DIR, dist);
  const server = createServer(async (req, res) => {
    // vercel.json's `/cdn/*` rewrite: the API's public JSON, fetched server-side (no browser headers forwarded).
    if (cdnProxy && (req.url ?? '').startsWith('/cdn/')) {
      cdnHits.push({ path: req.url, authorization: req.headers.authorization ?? null });
      try {
        // like vercel.json: `/cdn/v1/config/` → API `/v1/config`
        const upstream = await globalThis.fetch(
          API + (req.url ?? '').slice('/cdn'.length).replace(/\/(?=$|\?)/, ''),
        );
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'public, max-age=0, s-maxage=30',
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.writeHead(502);
        res.end();
      }
      return;
    }
    let file = path.join(root, decodeURIComponent(new URL(req.url ?? '/', WEB).pathname));
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // fall through to 404
    }
    try {
      let data = await readFile(file);
      const ext = path.extname(file);
      if (deploy.from && deploy.to && SWAPPED.has(ext)) {
        data = Buffer.from(data.toString('utf8').replaceAll(deploy.from, deploy.to));
      }
      res.writeHead(200, {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        // like vercel.json: the update check and the worker are never served from the HTTP cache
        ...(file.endsWith('version.json') ? { 'cache-control': 'no-store, max-age=0' } : {}),
        ...(file.endsWith('sw.js') ? { 'cache-control': 'no-cache' } : {}),
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(await readFile(path.join(root, '404.html')).catch(() => 'not found'));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ---------- 4. journeys ----------
const results = [];
const consoleErrors = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
    log(`✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    // Where it failed (the journey line in this file), for a quick look at the log.
    const at = e instanceof Error ? (e.stack ?? '').split('\n').find((l) => l.includes('run.mjs')) : null;
    if (at) log(`    ${at.trim()}`);
    if (process.env.E2E_DEBUG_DIR && globalThis.__browser) {
      let n = 0;
      for (const c of globalThis.__browser.contexts())
        for (const pg of c.pages()) {
          n++;
          await pg.screenshot({ path: `${process.env.E2E_DEBUG_DIR}/fail-${n}.png` }).catch(() => {});
          log(`    page ${n}: ${pg.url()}`);
          log(
            `    ${(await pg.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '?')).replace(/\n/g, ' | ')}`,
          );
        }
    }
    throw e;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Polls a Node-side condition (e.g. recorded requests) until it holds. */
async function waitUntil(cond, what, ms = 15_000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Console errors we provoke on purpose (wrong code, denied admin…) are expected 4xx resource loads. */
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
    if (/resources\.premierleague\.com|fantasy\.premierleague\.com/.test(m.location().url)) return; // CDN images
    // Headless Chromium runs every context incognito, where pushManager.subscribe() is unsupported by design.
    if (/does not support the Push API in incognito mode/.test(text)) return;
    consoleErrors.push(`${tag}: ${text}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${tag}: ${e.message}`));
}

// ---------- push mock ----------
// Headless Chromium has no push service, so PushManager is replaced in-page: getSubscription()/subscribe() return a
// fake subscription that `globalThis.__push` controls (set `.sub = null` to simulate the browser dropping it).
// Options: permission ('granted' | 'denied' | 'default'), standalone (navigator.standalone for iOS UAs).
function pushMock({ permission = 'granted', standalone } = {}) {
  const state = { sub: null, subscribes: 0, unsubscribes: 0, n: 0 };
  globalThis.__push = state;
  const make = (key) => {
    state.n += 1;
    const endpoint = `https://push.example.test/sub/${state.n}-${Math.random().toString(36).slice(2)}`;
    const sub = {
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: key },
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: { p256dh: 'BPmockp256dhKeyForE2eTests000000', auth: 'mockAuth1234' },
      }),
      unsubscribe: async () => {
        state.unsubscribes += 1;
        if (state.sub === sub) state.sub = null;
        return true;
      },
      getKey: () => null,
    };
    return sub;
  };
  if (globalThis.PushManager) {
    globalThis.PushManager.prototype.getSubscription = async function () {
      return state.sub;
    };
    globalThis.PushManager.prototype.subscribe = async function (opts) {
      state.subscribes += 1;
      const k = opts.applicationServerKey;
      const buf = k instanceof ArrayBuffer ? k.slice(0) : new Uint8Array(k).buffer.slice(0);
      state.sub = make(buf);
      return state.sub;
    };
    globalThis.PushManager.prototype.permissionState = async () => permission;
  }
  if (globalThis.Notification) {
    Object.defineProperty(globalThis.Notification, 'permission', { get: () => permission });
    globalThis.Notification.requestPermission = async () => permission;
  }
  const query = globalThis.navigator.permissions.query.bind(globalThis.navigator.permissions);
  globalThis.navigator.permissions.query = (d) =>
    d && d.name === 'notifications'
      ? Promise.resolve({ state: permission === 'default' ? 'prompt' : permission })
      : query(d);
  if (standalone !== undefined)
    Object.defineProperty(globalThis.navigator, 'standalone', { get: () => standalone });
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** A context signed in with `token`, the push mock installed, and POST /v1/push/subscriptions recorded. */
async function pushContext(browser, token, mock, opts = {}) {
  const ctx = await newContext(browser, opts);
  await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
  await ctx.addInitScript(pushMock, mock);
  const posted = [];
  await ctx.route(`${API}/v1/push/subscriptions`, async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    posted.push(JSON.parse(r.request().postData() ?? '{}').endpoint);
    await r.fulfill({ status: 204, headers: { 'access-control-allow-origin': WEB } });
  });
  return { ctx, posted };
}

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': WEB },
  body: JSON.stringify(body),
});

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', ...opts });
  // Image CDNs are irrelevant to behaviour and may be unreachable in CI.
  await ctx.route(/premierleague\.com/, (r) => r.abort());
  // Listening happens on Spotify / Apple: their pages are never loaded in e2e, only the navigation is checked.
  await ctx.route(
    /open\.spotify\.com|podcasts\.apple\.com|instagram\.com|youtube\.com\/(watch|shorts)/,
    (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>external</title>' }),
  );
  // The inline player: the embed URL is asserted, the real player isn't loaded.
  await ctx.route(/youtube-nocookie\.com|ytimg\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<title>youtube embed</title>' }),
  );
  return ctx;
}

async function noHorizontalScroll(page, where) {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  assert(sw <= cw, `${where}: horizontal scroll (${sw} > ${cw})`);
}

/** Opens an admin collapsible card (a no-op when it is already open) and returns it. */
async function openCard(page, id) {
  const card = page.locator(`[data-testid=admin-card][data-card="${id}"]`);
  await card.waitFor();
  if ((await card.getAttribute('data-open')) !== 'true') {
    const toggle = card.getByTestId('card-toggle').first();
    assert((await toggle.getAttribute('aria-expanded')) === 'false', `${id}: aria-expanded before opening`);
    await toggle.click();
  }
  await page.locator(`[data-testid=admin-card][data-card="${id}"][data-open=true]`).waitFor();
  return card;
}

/** The queries kept on this device (lib/persist.ts), as key strings like "news,feed". */
async function persistedKeys(page) {
  return page.evaluate(() => {
    const raw = globalThis.localStorage.getItem('fant.queryCache');
    if (!raw) return [];
    try {
      return JSON.parse(raw).clientState.queries.map((q) => q.queryKey.join(','));
    } catch {
      return ['<unparseable>'];
    }
  });
}
/** Anything tied to the signed-in user. */
const PRIVATE_KEY = /^(me|fpl,(entry|picks|live)|community|league)/;

/** Every API call answers `ms` late (a sleeping API waking up). */
async function slowApi(page, ms) {
  await page.route(`${API}/**`, async (r) => {
    await sleep(ms);
    await r.continue().catch(() => {}); // the page may have navigated away meanwhile
  });
}

/**
 * A 150-manager league in pages of 50 (standings + live) built from the demo's first page, with the e2e fan
 * (DEMO.tripleCaptain) at official rank 114 / live rank 112 when `rank` is set, and GET /v1/league/position
 * answering `{ page, rank }`.
 */
async function bigLeague(ctx, { page, rank }) {
  const me = Number(DEMO.tripleCaptain);
  const synth = async (r, live) => {
    const res = await r.fetch({
      url: r
        .request()
        .url()
        .replace(/page=\d+/, 'page=1'),
    });
    const body = await res.json();
    const n = Number(new URL(r.request().url()).searchParams.get('page') ?? '1');
    const rows = Array.from({ length: 50 }, (_, i) => {
      const pos = (n - 1) * 50 + i + 1;
      const src = body.rows[i % body.rows.length];
      const mine = rank !== null && pos === rank;
      const entryId = mine ? me : pos === 1 && src.entryId !== me ? src.entryId : 3000000 + pos;
      const common = {
        ...src,
        entryId,
        entryName: mine ? src.entryName : `Team ${pos}`,
        managerName: `Manager ${pos}`,
      };
      return live
        ? { ...common, liveRank: mine ? rank - 2 : pos, officialRank: pos }
        : { ...common, rank: pos, lastRank: pos };
    });
    await r.fulfill({ response: res, json: { ...body, page: n, hasNext: n < 3, rows } });
  };
  await ctx.route(
    (u) => u.origin === API && u.pathname === '/v1/league/standings',
    (r) => synth(r, false),
  );
  await ctx.route(
    (u) => u.origin === API && u.pathname === '/v1/league/live',
    (r) => synth(r, true),
  );
  await ctx.route(
    (u) => u.origin === API && u.pathname === '/v1/league/position',
    (r) => r.fulfill(json({ entryId: me, page, rank, member: page !== null })),
  );
}

/** The podcast league's invite (what the API serves once an admin set the code). */
const LEAGUE_JOIN = { code: 'KJJGKB', url: 'https://fantasy.premierleague.com/leagues/auto-join/KJJGKB' };

/** GET /v1/config with the league invite set; `position` (if given) answers GET /v1/league/position. */
async function joinLeagueRoutes(ctx, position) {
  await ctx.route(
    (u) => u.origin === API && u.pathname === '/v1/config',
    async (r) => {
      const res = await r.fetch();
      await r.fulfill({ response: res, json: { ...(await res.json()), leagueJoin: LEAGUE_JOIN } });
    },
  );
  if (position)
    await ctx.route(
      (u) => u.origin === API && u.pathname === '/v1/league/position',
      (r) => r.fulfill(json(position())),
    );
}

async function journeys(browser) {
  let recoveryCode = '';
  const user = await newContext(browser);
  await injectYouTube(user);
  const page = await user.newPage();
  watch(page, 'user');
  const leagueCalls = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${API}/v1/league/`)) leagueCalls.push(r.url());
  });

  await step('register with a Team ID (demo 1000003) and see the recovery code', async () => {
    await page.goto(`${WEB}/`);
    await page.waitForURL('**/onboarding/');
    await page.getByRole('button', { name: 'בואו נתחיל' }).click();
    await page.getByLabel('איך לקרוא לכם?').fill('E2E Tester');
    await page.getByLabel('Team ID של FPL').fill(DEMO.tripleCaptain);
    await page.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
    await page.getByText('זו הקבוצה שלכם?').waitFor();
    await page.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click();
    const code = page.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await code.waitFor();
    recoveryCode = (await code.textContent())?.trim() ?? '';
    assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(recoveryCode), `bad recovery code "${recoveryCode}"`);
    await page.getByRole('button', { name: 'שמרתי, יאללה' }).click();
    await page.waitForURL('**/news/');
  });

  if (process.env.E2E_ONLY_UPDATES) {
    await updateJourneys(user);
    await user.close();
    return;
  }

  await step('reload keeps the session', async () => {
    await page.reload();
    await page.waitForURL('**/news/');
    await page.getByRole('link', { name: 'פרופיל והגדרות' }).waitFor();
  });

  await step('News shows the podcast episode cards from the API (no in-app audio)', async () => {
    await page.goto(`${WEB}/news/`);
    await page.locator('[data-testid=news-card][data-source=podcast]').first().waitFor();
    assert((await page.locator('[data-source=podcast]').count()) === 3, 'expected the 3 seeded episodes');
    await page.getByText('פרק 62', { exact: true }).waitFor();
    // The badge shows the number, so the title drops the repeated "פרק 62 -" prefix.
    await page.getByRole('heading', { name: "אין צ'יפים, נגמרו הצ'יפים" }).waitFor();
    await page.getByText('1:13:23').first().waitFor();
    assert(
      (await page.locator('audio').count()) === 0,
      'there must be no <audio> element (listening is on Spotify/Apple)',
    );
    await page.getByTestId('listen-soon').getByText('הפרק יעלה לספוטיפיי ולאפל בקרוב').waitFor();
    await noHorizontalScroll(page, 'news');
  });

  await step(
    '"Listen" opens the Spotify/Apple chooser with the episode links; one link opens directly',
    async () => {
      const card = page.locator('#news-' + EP.both.id);
      await card.getByTestId('listen-button').click();
      const sheet = page.locator('dialog[open] [data-testid=listen-sheet]');
      await sheet.getByText('Spotify').waitFor();
      const hrefs = await sheet.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      assert(
        hrefs.length === 3 &&
          hrefs[0] === EP.both.spotify &&
          hrefs[1] === EP.both.apple &&
          hrefs[2] === YT.episodeUrl,
        `listen sheet hrefs: ${hrefs.join(', ')}`,
      );
      await page.keyboard.press('Escape');
      // Apple-only episode: no sheet, the Apple URL opens straight away.
      const opened = user.waitForEvent('page');
      await page
        .locator('#news-' + EP.apple.id)
        .getByTestId('listen-button')
        .click();
      const tab = await opened;
      await tab.waitForLoadState('domcontentloaded').catch(() => undefined);
      assert(tab.url() === EP.apple.apple, `opened ${tab.url()}`);
      await tab.close();
      assert(!(await page.locator('dialog[open]').count()), 'no sheet for a single platform');
    },
  );

  await step('episode card shows Spotify, Apple and YouTube buttons that fit at 390px', async () => {
    const buttons = page.locator(`#news-${EP.both.id} [data-testid=platform-buttons] a`);
    const platforms = await buttons.evaluateAll((as) => as.map((a) => a.getAttribute('data-platform')));
    assert(platforms.join(',') === 'spotify,apple,youtube', `platform buttons: ${platforms.join(',')}`);
    const yt = page.locator(`#news-${EP.both.id} [data-platform=youtube]`);
    await yt.getByText('צפייה ביוטיוב').waitFor();
    assert((await yt.getAttribute('href')) === YT.episodeUrl, 'episode YouTube href');
    assert((await yt.getAttribute('target')) === '_blank', 'YouTube opens in a new tab');
    for (const b of await buttons.all()) {
      const box = await b.boundingBox();
      assert(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, 'button fits, 44px tall');
    }
    const opened = user.waitForEvent('page');
    await yt.click();
    const tab = await opened;
    await tab.waitForLoadState('domcontentloaded').catch(() => undefined);
    assert(tab.url() === YT.episodeUrl, `opened ${tab.url()}`);
    await tab.close();
    await noHorizontalScroll(page, 'episode with 3 platforms');
  });

  await step(
    'a YouTube Short is 9:16 and plays inline through the nocookie embed, one at a time',
    async () => {
      const card = page.locator(`#news-${YT.short.id}`);
      await card.scrollIntoViewIfNeeded();
      await card.getByText('YouTube').first().waitFor();
      const player = card.getByTestId('youtube-player');
      const box = await player.boundingBox();
      assert(
        box && Math.abs(box.width / box.height - 9 / 16) < 0.02,
        `short ratio ${box?.width}x${box?.height}`,
      );
      const title = card.getByTestId('youtube-title');
      const th = await title.evaluate((el) => {
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return { h: el.getBoundingClientRect().height, lh };
      });
      assert(th.h <= th.lh * 2 + 1, `short title clamped to 2 lines (${th.h} > 2×${th.lh})`);
      assert((await page.locator('iframe').count()) === 0, 'no iframe before the tap');
      const open = card.getByTestId('open-in-youtube');
      await open.getByText('פתיחה ביוטיוב').waitFor();
      assert((await open.getAttribute('href')) === YT.short.url, 'short Open in YouTube href');
      await player.click();
      const iframe = card.locator('iframe');
      await iframe.waitFor();
      const src = (await iframe.getAttribute('src')) ?? '';
      assert(
        src === `https://www.youtube-nocookie.com/embed/${YT.short.videoId}?autoplay=1&playsinline=1&rel=0`,
        `short embed src ${src}`,
      );
      const allow = (await iframe.getAttribute('allow')) ?? '';
      assert(
        /autoplay/.test(allow) && /encrypted-media/.test(allow) && /picture-in-picture/.test(allow),
        allow,
      );
      assert((await iframe.getAttribute('allowfullscreen')) !== null, 'allowfullscreen');
      const after = await card.getByTestId('youtube-player').boundingBox();
      assert(after && Math.abs(after.width / after.height - 9 / 16) < 0.02, 'player keeps 9:16');

      // The regular video is 16:9; starting it unloads the Short's iframe.
      const vcard = page.locator(`#news-${YT.video.id}`);
      await vcard.scrollIntoViewIfNeeded();
      const vplayer = vcard.getByTestId('youtube-player');
      const vbox = await vplayer.boundingBox();
      assert(
        vbox && Math.abs(vbox.width / vbox.height - 16 / 9) < 0.03,
        `video ratio ${vbox?.width}x${vbox?.height}`,
      );
      assert(
        (await vcard.getByTestId('open-in-youtube').getAttribute('href')) === YT.video.url,
        'video Open in YouTube href',
      );
      await vplayer.click();
      await vcard.locator('iframe').waitFor();
      assert(
        ((await vcard.locator('iframe').getAttribute('src')) ?? '').includes(`/embed/${YT.video.videoId}?`),
        'video embed src',
      );
      assert((await page.locator('iframe').count()) === 1, 'only one YouTube player at a time');
      assert((await card.locator('iframe').count()) === 0, 'the Short was unloaded');
      await noHorizontalScroll(page, 'news with YouTube');
    },
  );

  await step(
    'filter chips come from /v1/news/filters; Shorts shows only Shorts and survives a reload',
    async () => {
      const filters = await page.request.get(`${API}/v1/news/filters`).then((r) => r.json());
      const row = page.getByTestId('news-filters');
      await row.locator('[data-filter=shorts]').waitFor();
      const chips = await row.locator('button').evaluateAll((bs) => bs.map((b) => b.dataset.filter));
      // page.request bypasses the context routes: the API's own list, plus the two injected YouTube filters.
      const have = new Set([...filters.filters, 'shorts', 'videos']);
      const expected = [
        'all',
        ...['episodes', 'shorts', 'videos', 'instagram', 'x', 'updates'].filter((f) => have.has(f)),
      ];
      assert(
        chips.join(',') === expected.join(','),
        `chips: ${chips.join(',')} (expected ${expected.join(',')})`,
      );
      assert(chips[0] === 'all' && chips.includes('episodes'), `chips: ${chips.join(',')}`);
      assert(
        (await row.locator('[data-filter=all]').getAttribute('aria-pressed')) === 'true',
        'All is the default',
      );
      await row.locator('[data-filter=shorts]').getByText('שורטס').waitFor();
      for (const b of await row.locator('button').all()) {
        const box = await b.boundingBox();
        assert(box && box.height >= 44, 'chip is a 44px touch target');
      }
      // RTL: the row starts at the right edge.
      const first = await row.locator('[data-filter=all]').boundingBox();
      const second = await row.locator('button').nth(1).boundingBox();
      assert(first && second && first.x > second.x, 'RTL chip order runs right-to-left');

      const calls = [];
      const onReq = (r) => {
        const u = new URL(r.url());
        if (u.origin === API && u.pathname === '/v1/news') calls.push(u.searchParams.get('filter'));
      };
      page.on('request', onReq);
      await row.locator('[data-filter=shorts]').click();
      await page.locator(`#news-${YT.short.id}`).waitFor();
      assert(
        (await row.locator('[data-filter=shorts]').getAttribute('aria-pressed')) === 'true',
        'Shorts pressed',
      );
      const sources = await page
        .locator('[data-testid=news-feed] [data-testid=news-card]')
        .evaluateAll((cs) => cs.map((c) => c.getAttribute('data-source')));
      assert(
        sources.length > 0 && sources.every((s) => s === 'youtube_short'),
        `sources: ${sources.join(',')}`,
      );
      assert(calls.includes('shorts'), `/v1/news calls: ${calls.join(',')}`);
      const bg = await row
        .locator('[data-filter=shorts]')
        .evaluate((b) => getComputedStyle(b).backgroundColor);
      assert(bg !== 'rgba(0, 0, 0, 0)', 'selected chip is filled');
      await noHorizontalScroll(page, 'news filtered');

      await page.reload();
      await page.getByTestId('news-filters').locator('[data-filter=shorts][aria-pressed=true]').waitFor();
      await page.locator(`#news-${YT.short.id}`).waitFor();
      assert((await page.locator('[data-source=podcast]').count()) === 0, 'still filtered after reload');
      page.off('request', onReq);

      // Keyboard: arrow moves focus along the row, Enter selects.
      await page.getByTestId('news-filters').locator('[data-filter=all]').focus();
      await page.keyboard.press('ArrowLeft'); // RTL: forward
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-filter'));
      assert(focused === chips[1], `focus moved to ${focused}`);
      await page.getByTestId('news-filters').locator('[data-filter=all]').focus();
      await page.keyboard.press('Enter');
      await page.getByTestId('news-filters').locator('[data-filter=all][aria-pressed=true]').waitFor();
      await page.locator('[data-source=podcast]').first().waitFor();
    },
  );

  await step(
    'source badges have their own colours (YouTube red, podcast purple, dark-mode purple)',
    async () => {
      const bgOf = (sel) =>
        page
          .locator(sel)
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor);
      const yt = await bgOf(`#news-${YT.short.id} header [data-testid=source-badge]`);
      assert(yt === 'rgb(255, 0, 0)', `YouTube badge ${yt}`);
      const pod = await bgOf(`#news-${EP.both.id} header [data-testid=source-badge]`);
      assert(pod === 'rgb(61, 24, 91)', `podcast badge (light) ${pod}`);
      const glyph = await page
        .locator(`#news-${YT.short.id} header [data-testid=source-badge]`)
        .evaluate((el) => getComputedStyle(el).color);
      assert(glyph === 'rgb(255, 255, 255)', `badge glyph ${glyph}`);
      await page.evaluate(() => globalThis.localStorage.setItem('fant.theme', 'dark'));
      await page.reload();
      await page.locator(`#news-${EP.both.id} header [data-testid=source-badge]`).waitFor();
      const podDark = await bgOf(`#news-${EP.both.id} header [data-testid=source-badge]`);
      assert(podDark === 'rgb(139, 92, 246)', `podcast badge (dark) ${podDark}`);
      await page.evaluate(() => globalThis.localStorage.removeItem('fant.theme'));
      await page.reload();
      await page.locator('[data-source=podcast]').first().waitFor();
    },
  );

  await step('profile header shows the story ring; the viewer opens and marks the story seen', async () => {
    const avatar = page.getByTestId('profile-avatar');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=profile-avatar]')?.getAttribute('data-state') === 'unseen',
    );
    await avatar.click();
    await page.locator('dialog.story[open] [data-testid=story-stage]').waitFor();
    await page.getByRole('link', { name: 'פתיחה באינסטגרם' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.querySelector('[data-testid=profile-avatar]')?.getAttribute('data-state') === 'seen',
    );
  });

  await step('deep link /news/?item= opens the item highlighted at the top', async () => {
    await page.goto(`${WEB}/news/?item=${EP.apple.id}`);
    const hl = page.getByTestId('news-highlighted');
    await hl.getByRole('heading', { name: 'לגרוס את כולם' }).waitFor();
    assert(
      (await page.locator('#news-' + EP.apple.id).count()) === 1,
      'highlighted item must not repeat in the feed',
    );
    await page.goto(`${WEB}/news/?item=does-not-exist`);
    await page.getByText('הפוסט הזה כבר לא זמין.').waitFor();
  });

  await step('Profile → notifications: push state is shown and a preference toggle persists', async () => {
    await user.grantPermissions(['notifications'], { origin: WEB });
    await page.goto(`${WEB}/profile/`);
    const state = page.getByTestId('push-state');
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid=push-state]')?.getAttribute('data-state');
      return !!v && v !== 'loading';
    });
    const s0 = await state.getAttribute('data-state');
    assert(s0 === 'disabled' || s0 === 'enabled', `push state ${s0}`);
    if (s0 === 'disabled') {
      // Headless Chromium has no push service: enabling must fail gracefully (message, no crash) or succeed.
      await page.getByRole('button', { name: 'הפעלת התראות' }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid=push-state]')?.getAttribute('data-state') === 'enabled' ||
          !!document.querySelector('[role=alert]'),
      );
    }
    const toggle = page.getByRole('switch', { name: 'תגובות בקהילה' });
    assert((await toggle.getAttribute('aria-checked')) === 'true', 'defaults are all on');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/v1/me/notification-prefs') && r.request().method() === 'PUT',
    );
    await toggle.click();
    assert((await saved).ok(), 'PUT notification-prefs failed');
    await page.reload();
    await page.getByRole('switch', { name: 'תגובות בקהילה' }).waitFor();
    assert(
      (await page.getByRole('switch', { name: 'תגובות בקהילה' }).getAttribute('aria-checked')) === 'false',
      'community pref did not persist',
    );
    assert(
      (await page.getByRole('switch', { name: 'פרקים ופוסטים חדשים' }).getAttribute('aria-checked')) ===
        'true',
      'other prefs must stay on',
    );
  });

  await step('Profile → notifications: "My league" and "My captain" toggles persist via PUT', async () => {
    await page.goto(`${WEB}/profile/`);
    const prefs = page.getByTestId('notification-prefs');
    await prefs.waitFor();
    await prefs.getByText('מלך המחזור, עלייה למקום הראשון, קפיצות גדולות בטבלה').waitFor();
    await prefs.getByText('התראה כשהקפטן שלך כובש או מבשל').waitFor();
    for (const [name, key] of [
      ['הליגה שלי', 'league'],
      ['הקפטן שלי', 'captain'],
    ]) {
      const toggle = page.getByRole('switch', { name: new RegExp(`^${name}`) });
      assert((await toggle.getAttribute('aria-checked')) === 'true', `${key} defaults to on`);
      const put = page.waitForRequest(
        (r) => r.url().endsWith('/v1/me/notification-prefs') && r.method() === 'PUT',
      );
      const res = page.waitForResponse(
        (r) => r.url().endsWith('/v1/me/notification-prefs') && r.request().method() === 'PUT',
      );
      await toggle.click();
      const body = JSON.parse((await put).postData() ?? '{}');
      assert(body[key] === false, `PUT body ${key}=false: ${JSON.stringify(body)}`);
      assert(
        ['news', 'fpl', 'live', 'league', 'captain'].every((k) => k in body),
        'PUT sends every pref',
      );
      assert((await res).ok(), `PUT notification-prefs (${key}) failed`);
    }
    await page.reload();
    for (const name of ['הליגה שלי', 'הקפטן שלי']) {
      const toggle = page.getByRole('switch', { name: new RegExp(`^${name}`) });
      await toggle.waitFor();
      assert((await toggle.getAttribute('aria-checked')) === 'false', `${name} did not persist`);
    }
    await noHorizontalScroll(page, 'notification prefs');
  });

  await step('push self-heals: a dropped subscription is re-created and registered on resume', async () => {
    const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const { ctx, posted } = await pushContext(browser, token, { permission: 'granted' });
    const p = await ctx.newPage();
    watch(p, 'push');
    await p.goto(`${WEB}/news/`);
    await p.waitForFunction(() => globalThis.__push && globalThis.__push.subscribes === 1);
    await waitUntil(() => posted.length === 1, 'first registration POST');
    const first = await p.evaluate(() => globalThis.__push.sub.endpoint);
    assert(posted[0] === first, 'registered the current endpoint');
    // Resume with the subscription still there and registered moments ago: nothing to do.
    await sleep(1_200);
    await p.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await sleep(800);
    assert(posted.length === 1, `no re-POST within 12 h (got ${posted.length})`);
    // The browser dropped it (iOS does this): the next resume subscribes again and registers the new endpoint.
    await p.evaluate(() => {
      globalThis.__push.sub = null;
    });
    await sleep(1_200);
    await p.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await p.waitForFunction(() => globalThis.__push.subscribes === 2);
    await waitUntil(() => posted.length === 2, 're-registration POST');
    const second = await p.evaluate(() => globalThis.__push.sub.endpoint);
    assert(posted[1] === second && second !== first, 'registered the new endpoint');
    await ctx.close();
  });

  await step('Profile → "Send a test notification" explains every outcome', async () => {
    const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const { ctx } = await pushContext(browser, token, { permission: 'granted' });
    const p = await ctx.newPage();
    watch(p, 'push-test');
    const replies = [];
    let tests = 0;
    await ctx.route(`${API}/v1/push/test`, async (r) => {
      tests += 1;
      const next = replies.shift() ?? { body: { devices: 1, delivered: 1, gone: 0, failed: 0 } };
      if (next.delay) await sleep(next.delay);
      await r.fulfill(json(next.body, next.status ?? 200));
    });
    await p.goto(`${WEB}/profile/`);
    await p.locator('[data-testid=push-state][data-state=enabled]').waitFor();
    const button = p.getByRole('button', { name: 'שליחת התראת בדיקה' });
    const result = p.getByTestId('push-test-result');

    replies.push({ body: { devices: 1, delivered: 1, gone: 0, failed: 0 } });
    await button.click();
    await p
      .locator('[data-testid=push-test-result][data-result=sent]')
      .getByText('נשלחה למכשיר — אמורה להופיע עכשיו')
      .waitFor();

    replies.push({ body: { devices: 0, delivered: 0, gone: 0, failed: 0 } });
    await button.click();
    await p
      .locator('[data-testid=push-test-result][data-result=none]')
      .getByText('לא נמצא מכשיר רשום')
      .waitFor();
    await result.getByRole('button', { name: 'הפעלת התראות' }).waitFor();

    // Dead subscription: renewed (a fresh subscribe) and the test retried once.
    const before = await p.evaluate(() => globalThis.__push.subscribes);
    replies.push({ body: { devices: 1, delivered: 0, gone: 1, failed: 0 } });
    replies.push({ body: { devices: 1, delivered: 1, gone: 0, failed: 0 }, delay: 1_500 });
    const testsBefore = tests;
    await button.click();
    await p
      .locator('[data-testid=push-test-result][data-result=renewing]')
      .getByText('המנוי במכשיר הזה פג — מחדשים…')
      .waitFor();
    await p.locator('[data-testid=push-test-result][data-result=sent]').waitFor();
    assert(tests - testsBefore === 2, `test retried once (${tests - testsBefore} calls)`);
    assert((await p.evaluate(() => globalThis.__push.subscribes)) === before + 1, 'resubscribed once');

    // Rate-limited (a 4xx, so no retry loop): a plain error, never a crash.
    replies.push({ body: { error: { code: 'rate_limited', message: 'slow down' } }, status: 429 });
    await button.click();
    await p.locator('[data-testid=push-test-result][data-result=error]').waitFor();
    await noHorizontalScroll(p, 'push test');
    await ctx.close();
  });

  await step(
    'iOS Safari (not installed) gets the Add-to-Home-Screen guide; denied explains iOS Settings',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      {
        const { ctx } = await pushContext(
          browser,
          token,
          { permission: 'default', standalone: false },
          {
            userAgent: IPHONE_UA,
          },
        );
        const p = await ctx.newPage();
        watch(p, 'ios-safari');
        await p.goto(`${WEB}/profile/`);
        const card = p.locator('[data-testid=push-state][data-state=needs-install]');
        await card.waitFor();
        await p.getByText('באייפון ההתראות עובדות רק אחרי שמוסיפים את פנטזיונרים למסך הבית').waitFor();
        assert(
          (await p.getByRole('button', { name: 'הפעלת התראות', exact: true }).count()) === 0,
          'no toggle that cannot work',
        );
        await noHorizontalScroll(p, 'ios safari profile');
        await ctx.close();
      }
      {
        const { ctx } = await pushContext(
          browser,
          token,
          { permission: 'denied', standalone: true },
          {
            userAgent: IPHONE_UA,
          },
        );
        const p = await ctx.newPage();
        watch(p, 'ios-denied');
        await p.goto(`${WEB}/profile/`);
        await p.locator('[data-testid=push-state][data-state=denied]').waitFor();
        await p.getByText('הגדרות האייפון ← התראות ← פנטזיונרים').waitFor();
        await ctx.close();
      }
    },
  );

  await step('My Team shows the Triple Captain chip and the pitch', async () => {
    await page.goto(`${WEB}/my-team/`);
    await page.getByTestId('pitch-player').first().waitFor();
    assert((await page.getByTestId('pitch-player').count()) === 15, 'expected 15 players on pitch + bench');
    await page.locator('section').getByText('טריפל קפטן').first().waitFor();
    await page.getByText('פעיל עכשיו').first().waitFor();
    // Chip icons: the header, the GW selector and the chips-played row all mark the Triple Captain.
    const tc = page.locator('main [data-testid=chip-icon][data-chip="3xc"]');
    assert(
      (await tc.count()) >= 3,
      `expected TC chip icons in header, GW selector and chips row, got ${await tc.count()}`,
    );
    const gwChip = page.locator('main [role=img][data-chip="3xc"]').first();
    const label = (await gwChip.getAttribute('aria-label')) ?? '';
    assert(label.includes('טריפל קפטן'), `chip icon has a Hebrew accessible label: "${label}"`);
    assert((await gwChip.getAttribute('title')) === label, 'chip icon tooltip');
    await page.getByTestId('chips-used').waitFor();
    await noHorizontalScroll(page, 'my-team');
  });

  await step('My Team → Live shows live points and the players list', async () => {
    await page.getByRole('tab', { name: 'לייב' }).click();
    await page.waitForURL('**/my-team/?view=live');
    await page.getByText("נק' לייב").first().waitFor();
    await page.getByText('השחקנים').waitFor();
    await noHorizontalScroll(page, 'my-team live');
  });

  await step('Table without a league shows the empty state and never calls /v1/league', async () => {
    await page.goto(`${WEB}/table/`);
    await page.getByText('הליגה עוד לא הוגדרה').waitFor();
    await page.goto(`${WEB}/live/`);
    await page.getByText('הליגה עוד לא הוגדרה').waitFor();
    assert(leagueCalls.length === 0, `league endpoints were called: ${leagueCalls.join(', ')}`);
  });

  await step('non-admin is blocked from /admin', async () => {
    await page.goto(`${WEB}/admin/`);
    await page.waitForURL('**/admin/login/?denied=1');
    await page.getByText('העמוד הזה למנהלים בלבד').waitFor();
  });

  const adminCtx = await newContext(browser);
  const admin = await adminCtx.newPage();
  watch(admin, 'admin');
  await step('admin signs in, sets the league and the captain battle (default rows)', async () => {
    await admin.goto(`${WEB}/admin/`);
    await admin.waitForURL('**/admin/login/');
    await admin.getByLabel('שם משתמש').fill(ADMIN.username);
    await admin.getByLabel('סיסמה').fill(ADMIN.password);
    await admin.getByRole('button', { name: 'כניסה' }).click();
    await admin.waitForURL('**/admin/');
    // Cards start collapsed except the ones that need attention: here, the unset league and battle.
    for (const id of ['settings.socials', 'settings.reminders', 'settings.invites', 'settings.admins']) {
      const card = admin.locator(`[data-testid=admin-card][data-card="${id}"]`);
      await card.waitFor();
      assert((await card.getAttribute('data-open')) === 'false', `${id} starts collapsed`);
    }
    for (const id of ['settings.league', 'settings.battle']) {
      const card = admin.locator(`[data-testid=admin-card][data-card="${id}"]`);
      assert((await card.getAttribute('data-open')) === 'true', `${id} (not set) starts open`);
      await card.getByTestId('card-summary').getByText('לא מוגדר').waitFor();
    }
    await noHorizontalScroll(admin, 'admin settings');
    await openCard(admin, 'settings.league');
    await admin.getByLabel('League ID של הליגה הקלאסית').fill(DEMO.league);
    await admin.getByRole('button', { name: 'שמירת הליגה' }).click();
    await admin.getByText('Fantasyonerim League').first().waitFor();
    // Default rows: Dor (linked), Itay (linked), community (player).
    await openCard(admin, 'settings.battle');
    await admin.getByText('עדיין לא הוגדר קרב').waitFor();
    const teamIds = admin.getByLabel('Team ID של הקבוצה');
    assert((await teamIds.count()) === 2, 'expected two linked-team default rows');
    await teamIds.nth(0).fill(DEMO.normal);
    await teamIds.nth(1).fill(DEMO.vice);
    await admin.getByText('Fantasyonerim HQ').first().waitFor(); // preview of the linked team
    await admin.getByRole('button', { name: 'בחירת שחקן' }).click();
    await admin.getByLabel('חיפוש לפי שם שחקן').fill('a');
    await admin.locator('dialog[open] ul li button').first().click();
    await admin.getByRole('button', { name: 'שמירת קרב הקפטנים' }).click();
    await admin.getByText('נשמר', { exact: true }).first().waitFor();
    // Collapsing is remembered per card on this device, and survives a reload.
    const socials = admin.locator('[data-testid=admin-card][data-card="settings.socials"]');
    const toggle = socials.getByTestId('card-toggle');
    await toggle.focus();
    await admin.keyboard.press('Enter'); // keyboard operable
    await admin.locator('[data-testid=admin-card][data-card="settings.socials"][data-open=true]').waitFor();
    assert((await toggle.getAttribute('aria-expanded')) === 'true', 'aria-expanded follows the state');
    const panel = await toggle.getAttribute('aria-controls');
    assert(
      panel && (await admin.locator(`[id="${panel}"]`).count()) === 1,
      'aria-controls points at the panel',
    );
    const box = await toggle.boundingBox();
    assert(box && box.height >= 44, `card header is a 44 px touch target (${box?.height})`);
    await admin.reload();
    await admin.locator('[data-testid=admin-card][data-card="settings.socials"][data-open=true]').waitFor();
    await admin
      .locator('[data-testid=admin-card][data-card="settings.socials"]')
      .getByTestId('card-toggle')
      .click();
    await admin.locator('[data-testid=admin-card][data-card="settings.socials"][data-open=false]').waitFor();
    await admin
      .locator('[data-testid=admin-card][data-card="settings.league"]')
      .getByTestId('card-summary')
      .getByText('ליגה 314159')
      .waitFor();
  });

  await step('a collapsed card still shows its load error (GET → 500) with a retry', async () => {
    const token = await admin.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const ctx = await newContext(browser);
    await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
    const p = await ctx.newPage();
    // Not watch()ed: the forced 500s are expected console errors here; page errors still fail the step.
    const pageErrors = [];
    p.on('pageerror', (e) => pageErrors.push(e.message));
    let fail = true;
    await p.route(`${API}/v1/admin/admins`, (r) =>
      fail
        ? r.fulfill({
            status: 500,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': WEB },
            body: JSON.stringify({ error: { code: 'internal', message: 'forced by e2e' } }),
          })
        : r.continue(),
    );
    await p.goto(`${WEB}/admin/`);
    const card = p.locator('[data-testid=admin-card][data-card="settings.admins"]');
    await card.waitFor();
    if ((await card.getAttribute('data-open')) === 'true') await card.getByTestId('card-toggle').click();
    const err = card.getByTestId('card-error');
    await err.waitFor({ timeout: 70_000 }); // after the client's own (cold-start-patient) retries
    assert((await card.getAttribute('data-open')) === 'false', 'the card stays collapsed');
    assert(await err.isVisible(), 'the error is visible without opening the card');
    await card.getByTestId('card-summary').getByText('לא נטען').waitFor();
    fail = false;
    await err.getByRole('button', { name: 'נסו שוב' }).click();
    await err.waitFor({ state: 'detached' });
    await card.getByTestId('card-summary').getByText(/מנהל/).waitFor();
    await noHorizontalScroll(p, 'collapsed card error');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await ctx.close();
  });

  await step('admin Integrations lists all six sources with the X paid-feature note', async () => {
    await admin.goto(`${WEB}/admin/?view=integrations`);
    await admin.getByTestId('integration-card').first().waitFor();
    const ids = await admin
      .getByTestId('integration-card')
      .evaluateAll((cs) => cs.map((c) => c.getAttribute('data-integration')));
    assert(ids.join(',') === 'podcast_rss,apple,spotify,youtube,instagram,x', `cards: ${ids.join(',')}`);
    const yt = await openCard(admin, 'integrations.youtube');
    // Configured by default, so its settings form starts collapsed.
    const toggle = yt.getByRole('button', { name: 'הגדרות', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const channel = yt.getByLabel('ערוץ יוטיוב');
    await channel.waitFor();
    assert((await channel.getAttribute('placeholder')) === 'youtube.com/@channel', 'channel placeholder');
    await yt.getByTestId('sync-line').waitFor();
    await openCard(admin, 'integrations.x');
    await admin
      .locator('[data-integration=x] [data-testid=x-paid-note]')
      .getByText("פיצ'ר בתשלום — צרו קשר עם היוצר אם תרצו להפעיל אותו")
      .waitFor();
    await openCard(admin, 'integrations.instagram');
    await admin
      .locator('[data-integration=instagram]')
      .getByRole('button', { name: 'התחברות עם Facebook' })
      .waitFor();
    await noHorizontalScroll(admin, 'admin integrations');
  });

  await step('admin push card shows delivery health (devices by service, recent batches)', async () => {
    // Deterministic numbers: the real endpoint is exercised by the API tests.
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    await admin.route(`${API}/v1/admin/push/health`, (r) =>
      r.fulfill(
        json({
          users: 3,
          devices: [
            { service: 'apple', count: 2 },
            { service: 'google', count: 4 },
          ],
          recent: [
            { at, kind: 'news', devices: 6, delivered: 5, gone: 1, failed: 0, failureCodes: [] },
            { at, kind: 'test', devices: 1, delivered: 0, gone: 0, failed: 1, failureCodes: [403] },
          ],
        }),
      ),
    );
    await admin.goto(`${WEB}/admin/?view=integrations`);
    const card = await openCard(admin, 'integrations.push');
    const health = card.getByTestId('push-health');
    await health.getByText('מצב המשלוחים').waitFor();
    await health.getByTestId('push-health-devices').getByText('Apple 2').waitFor();
    await health.getByTestId('push-health-devices').getByText('Google 4').waitFor();
    const rows = health.getByTestId('push-health-recent').locator('li');
    assert((await rows.count()) === 2, 'two recent batches');
    await rows.nth(0).getByText('5/6 נמסרו').waitFor();
    await rows.nth(0).getByText('1 פגו').waitFor();
    await rows.nth(1).getByText('1 נכשלו').waitFor();
    await rows.nth(1).getByText('403').waitFor();
    await noHorizontalScroll(admin, 'admin push health');
    await admin.unroute(`${API}/v1/admin/push/health`);
  });

  await step('Instagram OAuth return (?instagram=error) shows a notice and cleans the URL', async () => {
    await admin.goto(`${WEB}/admin/?instagram=error&reason=access_denied`);
    await admin.getByText('החיבור לאינסטגרם נכשל: access_denied').waitFor();
    await admin.waitForURL('**/admin/?view=integrations');
  });

  await step('admin manual post appears in News; admin can hide it', async () => {
    await openCard(admin, 'integrations.manual');
    await admin.getByLabel('טקסט').fill('הודעת בדיקה e2e');
    await admin.getByRole('button', { name: 'פרסום בפיד' }).click();
    await admin.getByText('הפוסט פורסם').waitFor();
    await admin.goto(`${WEB}/news/`);
    const card = admin.locator('[data-testid=news-card][data-source=admin_update]', {
      hasText: 'הודעת בדיקה e2e',
    });
    await card.waitFor();
    await card.getByRole('button', { name: 'הסתרה מהפיד' }).click();
    await admin.getByRole('button', { name: 'כן, להסתיר' }).click();
    await card.waitFor({ state: 'detached' });
  });

  await step('Table shows the league; tapping a row opens that manager’s team', async () => {
    await page.goto(`${WEB}/table/`);
    await page.getByRole('heading', { name: 'Fantasyonerim League' }).waitFor();
    // Standings rows mark the chip played in the current GW (demo: TC / BB / FH / WC teams).
    const chip = page.locator('ol [data-testid=chip-icon][data-chip="3xc"]').first();
    await chip.waitFor();
    assert(((await chip.getAttribute('aria-label')) ?? '').includes('טריפל קפטן'), 'table chip label');
    await page.locator('ol li button').first().click();
    await page.locator('dialog[open] [data-testid="pitch-player"], dialog[open] .flex-col').first().waitFor();
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page, 'table');
  });

  await step('Live Action: managers who played a chip this GW carry its icon in the live table', async () => {
    await page.goto(`${WEB}/live/`);
    await page.locator('ol li button').first().waitFor();
    const icons = page.locator('ol [role=img][data-testid=chip-icon]');
    await icons.first().waitFor();
    const chips = new Set(await icons.evaluateAll((els) => els.map((e) => e.getAttribute('data-chip'))));
    assert(chips.has('3xc'), `live table chip icons: ${[...chips].join(',')}`);
    for (const c of chips) assert(['wildcard', 'freehit', 'bboost', '3xc'].includes(c), `unknown chip ${c}`);
    const label = (await icons.first().getAttribute('aria-label')) ?? '';
    assert(/הופעל במחזור/.test(label), `chip icon label: "${label}"`);
    await noHorizontalScroll(page, 'live table with chips');
  });

  // "Find my team": a 150-manager league (50 per page) with this fan on page 3 — official rank 114, live rank 112.
  await step(
    'find my team: Table and live table jump to the fan on page 3 (loaded, centred, pulsed, focused)',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const ctx = await newContext(browser);
      await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
      await bigLeague(ctx, { page: 3, rank: 114 });
      const p = await ctx.newPage();
      watch(p, 'find-my-team');
      for (const [path, rank] of [
        ['/table/', 114],
        ['/live/', 112],
      ]) {
        await p.goto(`${WEB}${path}`);
        await p.locator('main ol li button').first().waitFor();
        assert((await p.locator('main ol > li').count()) === 50, `${path}: only page 1 is loaded at first`);
        const btn = p.getByTestId('find-my-team');
        await btn.waitFor();
        assert((await btn.textContent())?.includes('הקבוצה שלי'), `${path}: button label`);
        await noHorizontalScroll(p, `${path} with the my-team button`);
        await btn.click();
        const row = p.locator(`main li[data-entry="${DEMO.tripleCaptain}"]`);
        await row.waitFor();
        await p.waitForFunction((sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          return !!r && r.top >= 0 && r.bottom <= globalThis.innerHeight;
        }, `main li[data-entry="${DEMO.tripleCaptain}"]`);
        assert((await p.locator('main ol > li').count()) === 150, `${path}: pages 2 and 3 were loaded`);
        assert(/\brow-pulse\b/.test((await row.getAttribute('class')) ?? ''), `${path}: the row pulses`);
        assert(
          await row.evaluate((el) => el.contains(document.activeElement)),
          `${path}: focus moved to the row`,
        );
        await p.getByTestId('find-my-team-status').getByText(`הקבוצה שלך במקום ${rank}`).waitFor();
        // The row is on screen → the button goes away; scrolled back to the top → it's back.
        await btn.waitFor({ state: 'detached' });
        await p.evaluate(() => globalThis.scrollTo(0, 0));
        await btn.waitFor();
      }
      await ctx.close();
    },
  );

  await step('find my team: no button when the fan is not in the league (both tables)', async () => {
    const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const ctx = await newContext(browser);
    await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
    await bigLeague(ctx, { page: null, rank: null });
    const p = await ctx.newPage();
    watch(p, 'find-my-team-out');
    for (const path of ['/table/', '/live/']) {
      let asked = false;
      p.on('request', (r) => {
        if (r.url().startsWith(`${API}/v1/league/position`)) asked = true;
      });
      await p.goto(`${WEB}${path}`);
      await p.locator('main ol li button').first().waitFor();
      await waitUntil(() => asked, `${path}: position requested`);
      await sleep(800);
      assert((await p.getByTestId('find-my-team').count()) === 0, `${path}: no button outside the league`);
    }
    await ctx.close();
  });

  // "Join our league": a signed-in fan whose team isn't in the league (member: false).
  await step(
    'join league: a non-member gets the bar on every tab and the join button; copy-code works',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const ctx = await newContext(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
      await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
      let member = false;
      await joinLeagueRoutes(ctx, () => ({
        entryId: Number(DEMO.tripleCaptain),
        page: null,
        rank: null,
        member,
      }));
      const p = await ctx.newPage();
      watch(p, 'join-league');
      for (const path of ['/news/', '/community/', '/my-team/', '/table/', '/live/', '/profile/']) {
        await p.goto(`${WEB}${path}`);
        const bar = p.getByTestId('join-bar');
        await bar.waitFor();
        await bar.getByText('הצטרפו לליגה שלנו — קוד:').waitFor();
        assert(
          (await bar.getByTestId('join-bar-link').getAttribute('href')) === LEAGUE_JOIN.url,
          `${path}: bar link`,
        );
        // Inside the sticky header: the page content starts below it, never under it.
        const { headerBottom, mainTop } = await p.evaluate(() => ({
          headerBottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? 0,
          mainTop: document.querySelector('main')?.getBoundingClientRect().top ?? 0,
        }));
        assert(mainTop >= headerBottom - 1, `${path}: content below the bar (${mainTop} < ${headerBottom})`);
        await noHorizontalScroll(p, `${path} with the join bar`);
        if (path === '/table/' || path === '/live/') {
          const join = p.getByTestId('join-league');
          await join.waitFor();
          assert(
            (await join.textContent())?.includes('הצטרפו לליגת פנטזיונרים עכשיו!'),
            `${path}: join label`,
          );
          assert((await join.getAttribute('href')) === LEAGUE_JOIN.url, `${path}: join href`);
          assert((await p.getByTestId('find-my-team').count()) === 0, `${path}: no find button`);
          if (path === '/table/') {
            // The "copied" toast sits above the floating join button, never on it.
            await p.getByTestId('join-copy').click();
            const toast = p.getByText('הקוד הועתק');
            await toast.waitFor();
            const [tb, jb] = [await toast.boundingBox(), await join.boundingBox()];
            assert(
              tb && jb && tb.y + tb.height <= jb.y,
              `toast ${JSON.stringify(tb)} over button ${JSON.stringify(jb)}`,
            );
          }
        }
      }
      await p.getByTestId('join-copy').click();
      await p.getByText('הקוד הועתק').waitFor();
      assert((await p.evaluate(() => navigator.clipboard.readText())) === LEAGUE_JOIN.code, 'code copied');

      // Joined in the FPL app, back to ours: the resume re-check hides the bar.
      member = true;
      await resume(p);
      await p.getByTestId('join-bar').waitFor({ state: 'detached' });
      await ctx.close();
    },
  );

  await step('join league: a member and an admin see no bar; the member keeps the find button', async () => {
    const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const ctx = await newContext(browser);
    await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
    await bigLeague(ctx, { page: 3, rank: 114 });
    await joinLeagueRoutes(ctx);
    const p = await ctx.newPage();
    watch(p, 'join-member');
    await p.goto(`${WEB}/table/`);
    await p.getByTestId('find-my-team').waitFor();
    assert((await p.getByTestId('join-bar').count()) === 0, 'member: no bar');
    assert((await p.getByTestId('join-league').count()) === 0, 'member: no join button');
    await ctx.close();

    const adminToken = await admin.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const actx = await newContext(browser);
    await actx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), adminToken);
    await joinLeagueRoutes(actx, () => ({ entryId: null, page: null, rank: null, member: false }));
    const ap = await actx.newPage();
    watch(ap, 'join-admin');
    await ap.goto(`${WEB}/table/`);
    await ap.locator('main ol li button').first().waitFor();
    await sleep(800);
    assert((await ap.getByTestId('join-bar').count()) === 0, 'admin: no bar');
    assert((await ap.getByTestId('join-league').count()) === 0, 'admin: no join button');
    await actx.close();
  });

  // ---------- app open under a spike: warm start, CDN JSON, jitter ----------
  await step(
    'warm start: content renders from the device copy before /v1/me answers (delayed 5 s)',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const ctx = await newContext(browser);
      await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
      const first = await ctx.newPage();
      watch(first, 'warm-1');
      await first.goto(`${WEB}/news/`);
      await first.locator('[data-testid=news-card]').first().waitFor();
      await first.waitForFunction(() => {
        const raw = globalThis.localStorage.getItem('fant.queryCache');
        return !!raw && raw.includes('"queryKey":["me"]');
      });
      await first.close();
      // Reopen with a slow session lookup.
      const meCalls = [];
      await ctx.route(`${API}/v1/me`, async (r) => {
        meCalls.push(Date.now());
        await sleep(5_000);
        await r.continue().catch(() => {});
      });
      const p = await ctx.newPage();
      watch(p, 'warm-2');
      const t0 = Date.now();
      await p.goto(`${WEB}/news/`);
      await p.locator('[data-testid=news-card]').first().waitFor({ timeout: 4_000 });
      const shownAt = Date.now() - t0;
      assert(shownAt < 4_000, `content after ${shownAt} ms`);
      // /v1/me is still revalidated — later, in the background (not by the head script, not on mount).
      await waitUntil(() => meCalls.length > 0, 'the background /v1/me revalidation', 8_000);
      assert(meCalls[0] - t0 >= 1_000, `/v1/me asked ${meCalls[0] - t0} ms after opening (expected ≥ 1 s)`);
      await ctx.close();
    },
  );

  await step(
    'production-like build: config and bootstrap come from same-origin /cdn/, never with Authorization',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const ctx = await newContext(browser);
      await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
      const direct = [];
      ctx.on('request', (r) => {
        const u = new URL(r.url());
        if (u.origin === API && (u.pathname === '/v1/config' || u.pathname === '/v1/fpl/bootstrap'))
          direct.push(r.url());
      });
      const browserCdn = [];
      ctx.on('request', (r) => {
        if (r.url().startsWith(`${WEB_CDN}/cdn/`))
          browserCdn.push({ url: r.url(), auth: r.headers().authorization });
      });
      const before = cdnHits.length;
      const p = await ctx.newPage();
      watch(p, 'cdn');
      await p.goto(`${WEB_CDN}/live/`);
      await p.locator('main ol li button').first().waitFor();
      const paths = new Set(browserCdn.map((c) => new URL(c.url).pathname));
      assert(
        paths.has('/cdn/v1/config/') && paths.has('/cdn/v1/fpl/bootstrap/'),
        `cdn paths: ${[...paths].join(', ')}`,
      );
      assert(
        browserCdn.every((c) => !c.auth),
        'no Authorization header on /cdn/ requests',
      );
      assert(
        cdnHits.slice(before).every((h) => h.authorization === null),
        'the CDN never received a token',
      );
      assert(direct.length === 0, `config/bootstrap still went to the API: ${direct.join(', ')}`);
      await ctx.close();
    },
  );

  await step('jitter: the live table polls ~30 s ± 15 %, and consecutive intervals differ', async () => {
    const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const ctx = await newContext(browser);
    await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
    let polls = 0;
    ctx.on('request', (r) => {
      if (r.url().startsWith(`${API}/v1/league/live`)) polls++;
    });
    const p = await ctx.newPage();
    watch(p, 'jitter');
    await p.clock.install();
    await p.goto(`${WEB}/live/`);
    await p.locator('main ol li button').first().waitFor();
    await sleep(1_000);
    // Fast-forward the page's clock in 250 ms steps and note when each poll goes out.
    const at = [];
    let t = 0;
    let seen = polls;
    while (at.length < 4 && t < 160_000) {
      await p.clock.runFor(250);
      t += 250;
      await sleep(5);
      if (polls > seen) {
        seen = polls;
        at.push(t);
      }
    }
    assert(at.length >= 3, `polls seen at ${at.join(', ')}`);
    const gaps = at.slice(1).map((x, i) => x - (at[i] ?? 0));
    for (const g of gaps)
      assert(g >= 25_500 - 500 && g <= 34_500 + 500, `poll gap ${g} ms outside 30 s ± 15 %`);
    assert(new Set(gaps).size > 1, `poll gaps all equal: ${gaps.join(', ')}`);
    await ctx.close();
  });

  await step('Captain Battle lists the configured rows plus "my captain"', async () => {
    await page.goto(`${WEB}/live/?view=captains`);
    await page.getByText('הקפטן שלי').first().waitFor();
    await page.getByText('הקפטן של דור').first().waitFor();
    await page.getByText('קפטן הקהילה').first().waitFor();
    await noHorizontalScroll(page, 'captain battle');
  });

  await step(
    'Captain Battle: a hand-picked row not re-picked for this GW says "not picked yet"; admins get "Pick"',
    async () => {
      let event = null;
      // The API's new-GW state: the community row (source "player") comes back without a player, sorted last.
      const unpicked = async (r) => {
        if (r.request().method() === 'OPTIONS') return r.continue();
        const res = await r.fetch();
        const body = await res.json();
        event = body.event;
        const rows = body.rows.map((row) =>
          row.source === 'player' ? { ...row, playerId: null, live: null, captainPoints: 0 } : row,
        );
        rows.sort((a, b) => Number(a.playerId === null) - Number(b.playerId === null));
        await r.fulfill(json({ ...body, rows }));
      };
      const label = () => `עוד לא נבחר למחזור ${event}`;

      await page.route(`${API}/v1/captain-battle`, unpicked);
      await page.goto(`${WEB}/live/?view=captains`);
      const fan = page.getByTestId('battle-not-picked');
      await fan.waitFor();
      assert((await fan.textContent())?.includes(label()), `fan sees "${await fan.textContent()}"`);
      assert((await fan.getByRole('link').count()) === 0, 'no "Pick" link for a fan');
      // Entry rows keep their own state (never "not picked yet").
      assert((await page.getByTestId('battle-not-picked').count()) === 1, 'only the hand-picked row');
      const last = page.locator('ol > li').last();
      assert((await last.getByTestId('battle-not-picked').count()) === 1, 'the unpicked row is sorted last');
      await noHorizontalScroll(page, 'captain battle (not picked)');
      await page.unroute(`${API}/v1/captain-battle`, unpicked);

      // Admin: collapse the battle card, then "Pick" opens it from the battle screen.
      await admin.goto(`${WEB}/admin/`);
      const card = admin.locator('[data-testid=admin-card][data-card="settings.battle"]');
      await card.waitFor();
      if ((await card.getAttribute('data-open')) === 'true')
        await card.getByTestId('card-toggle').first().click();
      await admin.locator('[data-card="settings.battle"][data-open=false]').waitFor();
      await admin.route(`${API}/v1/captain-battle`, unpicked);
      await admin.goto(`${WEB}/live/?view=captains`);
      const row = admin.getByTestId('battle-not-picked');
      await row.waitFor();
      assert((await row.textContent())?.includes(label()), 'admin sees the not-picked text');
      const pick = row.getByRole('link', { name: 'לבחירה' });
      const box = await pick.boundingBox();
      assert(box && box.height >= 44, `"Pick" touch target ${box?.height}`);
      await pick.click();
      await admin.waitForURL('**/admin/?card=battle');
      await admin.locator('[data-testid=admin-card][data-card="settings.battle"][data-open=true]').waitFor();
      await admin.unroute(`${API}/v1/captain-battle`, unpicked);
    },
  );

  // ---------- refresh + FPL match sheet ----------
  await step(
    'Live Action: the header refresh button refetches now (spins, then "Updated just now")',
    async () => {
      await page.goto(`${WEB}/live/`);
      await page.locator('ol li button').first().waitFor();
      const before = leagueCalls.length;
      // A slow answer keeps the spinner observable.
      await page.route(`${API}/v1/league/live**`, async (r) => {
        await sleep(1_200);
        await r.continue().catch(() => {});
      });
      const button = page.getByRole('button', { name: 'רענון' });
      await button.click();
      await page.locator('[data-testid=refresh-button][data-state=refreshing]').waitFor({ timeout: 1_000 });
      await waitUntil(() => leagueCalls.length > before, 'a new /v1/league/live request');
      const done = page.getByTestId('refresh-done');
      await done.waitFor();
      assert((await done.getAttribute('data-state')) === 'done', 'refresh confirmation state');
      assert((await done.textContent())?.includes('עודכן עכשיו'), 'refresh confirmation text');
      await page.locator('[data-testid=refresh-button][data-state=idle]').waitFor();
      await page.unroute(`${API}/v1/league/live**`);
      // 44px touch target
      const box = await button.boundingBox();
      assert(box && box.width >= 44 && box.height >= 44, `refresh button ${box?.width}×${box?.height}`);
    },
  );

  await step(
    'pull-to-refresh: a touch drag down from the top refetches; a sideways swipe does not',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const ctx = await newContext(browser, { hasTouch: true, isMobile: true });
      await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
      const p = await ctx.newPage();
      watch(p, 'touch');
      const calls = [];
      p.on('request', (r) => {
        if (r.url().startsWith(`${API}/v1/league/standings`)) calls.push(r.url());
      });
      await p.goto(`${WEB}/table/`);
      await p.getByRole('heading', { name: 'Fantasyonerim League' }).waitFor();
      await sleep(300);
      const cdp = await ctx.newCDPSession(p);
      const drag = async (from, to, steps = 12) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
        for (let i = 1; i <= steps; i++) {
          const x = from.x + ((to.x - from.x) * i) / steps;
          const y = from.y + ((to.y - from.y) * i) / steps;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
          await sleep(16);
        }
      };
      const release = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

      // Sideways: ignored.
      let n = calls.length;
      await drag({ x: 330, y: 300 }, { x: 60, y: 330 });
      await release();
      await sleep(400);
      assert(calls.length === n, 'a horizontal swipe must not refresh');

      // Down from the top: the indicator arms, release refreshes.
      n = calls.length;
      await drag({ x: 195, y: 200 }, { x: 195, y: 420 });
      const state = await p.getByTestId('pull-indicator').getAttribute('data-state');
      assert(state === 'armed', `pull indicator while dragging: ${state}`);
      await release();
      await waitUntil(() => calls.length > n, 'a refetch after the pull');
      await p.getByTestId('refresh-done').waitFor();
      await noHorizontalScroll(p, 'table after pull');
      await ctx.close();
    },
  );

  await step(
    'Live Action: a fixture card opens the FPL match sheet (both tabs, home side in RTL, not started)',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const get = async (path) => {
        const r = await globalThis.fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
        assert(r.ok, `${path} → ${r.status}`);
        return r.json();
      };
      const boot = await get('/v1/fpl/bootstrap');
      const event = boot.currentEvent;
      const fixtures = await get(`/v1/fpl/fixtures?event=${event}`);
      const picks = await get(`/v1/fpl/entries/${DEMO.tripleCaptain}/picks?event=${event}`);
      const playerById = new Map(boot.players.map((pl) => [pl.id, pl]));
      const captainId = picks.picks.find((pk) => pk.isCaptain).playerId;
      const captainTeam = playerById.get(captainId).teamId;
      const fx = fixtures.find((x) => x.teamH === captainTeam || x.teamA === captainTeam) ?? fixtures[0];
      const other = fixtures.find((x) => x.id !== fx.id);
      assert(other, 'demo GW has at least two fixtures');
      const squad = (teamId) => boot.players.filter((pl) => pl.teamId === teamId);
      const homeP = squad(fx.teamH).filter((pl) => pl.id !== captainId);
      const awayP = squad(fx.teamA).filter((pl) => pl.id !== captainId);
      const captainHome = captainTeam === fx.teamH;
      // Realistic sheet: home won 2–1, the home brace (2) shows its count, single goals/assists don't.
      const brace = captainHome ? captainId : homeP[0].id;
      const homeKeeper =
        boot.players.find((pl) => pl.teamId === fx.teamH && pl.position === 'GKP') ?? homeP[1];
      const detail = {
        fixture: { ...fx, status: 'finished', teamHScore: 2, teamAScore: 1, minutes: 90 },
        stats: [
          {
            id: 'goals_scored',
            home: [{ playerId: brace, value: 2 }],
            away: [{ playerId: awayP[0].id, value: 1 }],
          },
          {
            id: 'assists',
            home: [{ playerId: homeP[2].id, value: 1 }],
            away: [{ playerId: awayP[1].id, value: 1 }],
          },
          { id: 'saves', home: [{ playerId: homeKeeper.id, value: 3 }], away: [] },
          {
            id: 'bps',
            home: [
              { playerId: brace, value: 41 },
              { playerId: homeP[2].id, value: 27 },
            ],
            away: [{ playerId: awayP[0].id, value: 24 }],
          },
        ],
        players: [
          { playerId: brace, teamId: fx.teamH, minutes: 90, points: 13 },
          { playerId: awayP[0].id, teamId: fx.teamA, minutes: 88, points: 7 },
          { playerId: homeP[2].id, teamId: fx.teamH, minutes: 90, points: 6 },
          { playerId: homeKeeper.id, teamId: fx.teamH, minutes: 90, points: 3 },
          ...(captainHome ? [] : [{ playerId: captainId, teamId: captainTeam, minutes: 75, points: 2 }]),
          { playerId: awayP[1].id, teamId: fx.teamA, minutes: 12, points: 1 },
        ],
        updatedAt: new Date().toISOString(),
      };
      const kickoff = new Date(Date.now() + 26 * 3_600_000).toISOString();
      const notStarted = {
        fixture: {
          ...other,
          status: 'not_started',
          teamHScore: null,
          teamAScore: null,
          minutes: 0,
          kickoffTime: kickoff,
        },
        stats: [],
        players: [],
        updatedAt: new Date().toISOString(),
      };
      const detailCalls = [];
      await page.route(`${API}/v1/fpl/fixtures/*`, async (r) => {
        if (r.request().method() === 'OPTIONS') return r.continue();
        const id = Number(new URL(r.request().url()).pathname.split('/').pop());
        detailCalls.push(id);
        if (id === fx.id) return r.fulfill(json(detail));
        if (id === other.id) return r.fulfill(json(notStarted));
        return r.fulfill(json({ error: { code: 'not_found', message: 'no such fixture' } }, 404));
      });

      await page.goto(`${WEB}/live/`);
      const card = page.locator(`[data-fixture="${fx.id}"] button`);
      await card.waitFor();
      await card.click();
      const sheet = page.locator('dialog[open] [data-testid=fixture-sheet]');
      await sheet.waitFor();
      assert(new URL(page.url()).searchParams.get('fixture') === String(fx.id), 'sheet is in the URL');
      await sheet.locator('[data-testid=fixture-details]').waitFor();

      // RTL: home is on the right in the header, in the card and in every stat block.
      const x = async (loc) => (await loc.boundingBox()).x;
      const header = sheet.getByTestId('fixture-header');
      assert(
        (await x(header.locator('[data-side=home]'))) > (await x(header.locator('[data-side=away]'))),
        'header: home on the right in Hebrew',
      );
      for (const id of ['goals_scored', 'assists', 'bps']) {
        const block = sheet.locator(`[data-testid=fixture-stat][data-stat=${id}]`);
        assert(
          (await x(block.locator('[data-side=home]'))) > (await x(block.locator('[data-side=away]'))),
          `${id}: home column on the right`,
        );
      }
      const titles = await sheet.locator('[data-testid=fixture-stat] h3').allTextContents();
      assert(
        titles.join('|') === 'שערים|בישולים|הצלות|BPS',
        `block titles in API order: ${titles.join('|')}`,
      );
      const goals = sheet.locator('[data-testid=fixture-stat][data-stat=goals_scored]');
      const homeGoals = (await goals.locator('[data-side=home]').textContent()) ?? '';
      const awayGoals = (await goals.locator('[data-side=away]').textContent()) ?? '';
      assert(
        homeGoals.includes(playerById.get(brace).webName) && homeGoals.includes('(2)'),
        `home goals "${homeGoals}"`,
      );
      assert(awayGoals.includes(awayP[0].webName) && !awayGoals.includes('('), `away goals "${awayGoals}"`);
      const assists = (await sheet.locator('[data-stat=assists] [data-side=home]').textContent()) ?? '';
      assert(!assists.includes('('), `single assist shows no count: "${assists}"`);
      const saves = (await sheet.locator('[data-stat=saves] [data-side=home]').textContent()) ?? '';
      assert(saves.includes('(3)'), `saves always show the value: "${saves}"`);
      const scores = await header.locator('[data-score]').allTextContents();
      assert(scores.join('-') === '2-1', `header score ${scores.join('-')}`);
      await noHorizontalScroll(page, 'fixture sheet');

      // Player stats: by points, my players highlighted, my captain with the C badge.
      await sheet.getByRole('tab', { name: 'נתוני שחקנים' }).click();
      const rows = sheet.locator('[data-testid=fixture-player]');
      await rows.first().waitFor();
      const ids = await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-player'))));
      const expected = [...detail.players].sort((a, b) => b.points - a.points).map((pl) => pl.playerId);
      assert(ids.join() === expected.join(), `players by points: ${ids.join()} vs ${expected.join()}`);
      const cap = sheet.locator(`[data-testid=fixture-player][data-player="${captainId}"]`);
      assert((await cap.getAttribute('data-captain')) === 'true', 'captain row flagged');
      assert((await cap.getAttribute('data-mine')) === 'true', 'captain row is mine');
      assert((await cap.textContent())?.includes('C'), 'C badge');
      const mineCount = await sheet.locator('[data-testid=fixture-player][data-mine]').count();
      const myIds = new Set(picks.picks.map((pk) => pk.playerId));
      assert(
        mineCount === detail.players.filter((pl) => myIds.has(pl.playerId)).length,
        'my players highlighted',
      );
      await noHorizontalScroll(page, 'fixture sheet players');

      // The sheet's own refresh refetches the detail.
      const n = detailCalls.length;
      await sheet.page().getByTestId('fixture-refresh').click();
      await waitUntil(() => detailCalls.length > n, 'fixture detail refetch');

      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
      assert(!new URL(page.url()).searchParams.has('fixture'), 'closing clears ?fixture');

      // Not started: the message and the kick-off time, no tabs.
      await page.locator(`[data-fixture="${other.id}"] button`).click();
      const ns = page.locator('dialog[open] [data-testid=fixture-not-started]');
      await ns.waitFor();
      assert((await ns.textContent())?.includes('המשחק עוד לא התחיל'), 'not started text');
      assert((await ns.textContent())?.includes('שריקת פתיחה'), 'kick-off time');
      assert((await page.locator('dialog[open] [role=tab]').count()) === 0, 'no tabs before kick-off');
      await page.keyboard.press('Escape');
      await page.unroute(`${API}/v1/fpl/fixtures/*`);
    },
  );

  await step(
    "Live Action: a LIVE fixture sheet (62') shows the live badge and updates on the next poll",
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const get = async (path) => {
        const r = await globalThis.fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
        assert(r.ok, `${path} → ${r.status}`);
        return r.json();
      };
      const boot = await get('/v1/fpl/bootstrap');
      const fixtures = await get(`/v1/fpl/fixtures?event=${boot.currentEvent}`);
      // Demo: fixture 87 is live at 62'.
      const fx =
        fixtures.find((x) => x.status === 'live') ?? fixtures.find((x) => x.id === 87) ?? fixtures[0];
      const of = (teamId) => boot.players.filter((pl) => pl.teamId === teamId);
      const [h1, h2] = of(fx.teamH);
      const [a1] = of(fx.teamA);
      let polls = 0;
      const live = () => {
        polls += 1;
        const second = polls > 1;
        return {
          fixture: { ...fx, status: 'live', minutes: second ? 63 : 62, teamHScore: 1, teamAScore: 0 },
          // Bonus is settled after the match; BPS is there live and moves between polls.
          stats: [
            { id: 'goals_scored', home: [{ playerId: h1.id, value: 1 }], away: [] },
            {
              id: 'bps',
              home: [
                { playerId: h1.id, value: second ? 34 : 29 },
                { playerId: h2.id, value: 18 },
              ],
              away: [{ playerId: a1.id, value: 12 }],
            },
          ],
          players: [
            { playerId: h1.id, teamId: fx.teamH, minutes: second ? 63 : 62, points: 8 },
            { playerId: h2.id, teamId: fx.teamH, minutes: second ? 63 : 62, points: 2 },
            { playerId: a1.id, teamId: fx.teamA, minutes: second ? 63 : 62, points: 2 },
          ],
          updatedAt: new Date().toISOString(),
        };
      };
      const p = await user.newPage();
      watch(p, 'live-sheet');
      await p.clock.install();
      await p.route(`${API}/v1/fpl/fixtures/*`, async (r) => {
        if (r.request().method() === 'OPTIONS') return r.continue();
        const id = Number(new URL(r.request().url()).pathname.split('/').pop());
        if (id !== fx.id) return r.fulfill(json({ error: { code: 'not_found', message: 'x' } }, 404));
        return r.fulfill(json(live()));
      });
      await p.goto(`${WEB}/live/?fixture=${fx.id}`);
      const sheet = p.locator('dialog[open] [data-testid=fixture-sheet]');
      await sheet.locator('[data-testid=fixture-details]').waitFor();
      await sheet.getByTestId('fixture-live').waitFor();
      assert((await sheet.getByTestId('fixture-live').textContent())?.includes('חי'), 'LIVE badge');
      assert((await sheet.getByTestId('fixture-status').textContent())?.includes('62'), 'minute 62');
      const bps = sheet.locator('[data-stat=bps] [data-side=home]');
      assert((await bps.textContent())?.includes('(29)'), `bps before: ${await bps.textContent()}`);
      assert((await sheet.locator('[data-stat=bonus]').count()) === 0, 'no bonus block while live');
      await sheet.getByRole('tab', { name: 'נתוני שחקנים' }).click();
      assert((await sheet.locator('[data-testid=fixture-player]').count()) === 3, 'live players render');
      await sheet.getByRole('tab', { name: 'פרטי משחק' }).click();
      // The next poll (30 s while live) brings the new BPS and minute without any tap.
      const before = polls;
      await p.clock.fastForward('00:31');
      await waitUntil(() => polls > before, 'a second live poll');
      await p.waitForFunction(() =>
        document
          .querySelector('dialog[open] [data-stat=bps] [data-side=home]')
          ?.textContent?.includes('(34)'),
      );
      assert((await sheet.getByTestId('fixture-status').textContent())?.includes('63'), 'minute 63');
      await noHorizontalScroll(p, 'live fixture sheet');
      await p.close();
    },
  );

  // ---------- Phase 3: Community ----------
  const POST_TEXT = 'פוסט בדיקה e2e — את מי לקפטן? https://example.com/e2e';
  const feedCard = (p, text) => p.locator('[data-testid=post-card]', { hasText: text });
  const openComposer = async (p) => {
    await p.getByTestId('composer-open').click();
    await p.locator('dialog[open] [data-testid=composer]').waitFor();
  };

  await step('Community: empty state, then a text post appears on top with its link', async () => {
    await page.goto(`${WEB}/community/`);
    await page.getByText('עוד אין פוסטים — תהיו הראשונים!').waitFor();
    await page.getByTestId('composer-open').getByText('מה דעתך על המחזור?').waitFor();
    await openComposer(page);
    const submit = page.getByTestId('composer-submit');
    assert(await submit.isDisabled(), 'post button must be disabled while empty');
    await page.getByLabel('הטקסט של הפוסט').fill(POST_TEXT);
    await page.getByText(`${POST_TEXT.length}/1000`).waitFor();
    await submit.click();
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    const card = feedCard(page, 'פוסט בדיקה e2e');
    await card.waitFor();
    assert(
      (await card.locator('a[href="https://example.com/e2e"]').count()) === 1,
      'URL in the post must be linkified',
    );
    await card.getByTestId('author-name').getByText('E2E Tester').waitFor();
    await noHorizontalScroll(page, 'community feed');
  });

  await step(
    'Community: a post with an uploaded photo (progress → preview → full-screen viewer)',
    async () => {
      await openComposer(page);
      await page.getByTestId('composer-file').setInputFiles({
        name: 'e2e.png',
        mimeType: 'image/png',
        buffer: makePng(320, 200),
      });
      const preview = page.locator('[data-testid=composer-photo] img');
      await page.waitForFunction(
        (api) =>
          document.querySelector('[data-testid=composer-photo] img')?.getAttribute('src')?.startsWith(api),
        API,
      );
      assert((await preview.count()) === 1, 'uploaded image preview');
      await page.getByLabel('הטקסט של הפוסט').fill('צילום מסך של ההעברות e2e');
      await page.getByTestId('composer-submit').click();
      const card = feedCard(page, 'צילום מסך של ההעברות e2e');
      await card.getByTestId('post-image').waitFor();
      await card.getByTestId('post-image').click();
      await page.locator('dialog.story[open] [data-testid=image-viewer] img').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('dialog.story[open]').waitFor({ state: 'detached' });
    },
  );

  await step(
    'Community: share my team (current started GW by default) → compact pitch → full sheet',
    async () => {
      await openComposer(page);
      await page.getByRole('switch', { name: /שיתוף הקבוצה שלי/ }).click();
      const gw = page.getByTestId('composer-gw');
      await gw.waitFor();
      assert((await gw.inputValue()) === '9', `default GW ${await gw.inputValue()}`);
      await page
        .getByText('FPL מציגה קבוצות רק אחרי הדדליין — לקבוצה של המחזור הבא צרפו צילום מסך')
        .waitFor();
      await page.locator('dialog[open] [data-testid=team-preview]').waitFor();
      await page.getByTestId('composer-submit').click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      const card = page.locator('[data-testid=post-card]').first();
      const preview = card.getByTestId('team-preview');
      await preview.waitFor();
      const tc = preview.locator('[data-testid=chip-icon][data-chip="3xc"]');
      await tc.waitFor();
      assert(((await tc.getAttribute('aria-label')) ?? '').includes('טריפל קפטן'), 'snapshot chip label');
      await preview.getByText('מחזור 9').waitFor();
      await preview.click();
      await page.locator('dialog[open] [data-testid=snapshot-sheet]').waitFor();
      await page.keyboard.press('Escape');
      await noHorizontalScroll(page, 'community team post');
    },
  );

  await step('Community: like / unlike (optimistic, persisted)', async () => {
    const like = feedCard(page, 'פוסט בדיקה e2e').getByTestId('like-button');
    assert((await like.getAttribute('aria-pressed')) === 'false', 'not liked yet');
    const put = page.waitForResponse((r) => r.url().endsWith('/like') && r.request().method() === 'PUT');
    await like.click();
    // Optimistic: pressed before the server answers (the PUT is still in flight or just landed).
    await feedCard(page, 'פוסט בדיקה e2e')
      .locator('[data-testid=like-button][aria-pressed=true]')
      .waitFor({ timeout: 1500 });
    assert((await put).ok(), 'PUT like failed');
    await page.reload();
    const again = feedCard(page, 'פוסט בדיקה e2e').getByTestId('like-button');
    await again.waitFor();
    assert((await again.getAttribute('aria-pressed')) === 'true', 'like did not persist');
    assert((await again.innerText()).includes('1'), 'like count 1');
    const del = page.waitForResponse((r) => r.url().endsWith('/like') && r.request().method() === 'DELETE');
    await again.click();
    assert((await del).ok(), 'DELETE like failed');
    await feedCard(page, 'פוסט בדיקה e2e').locator('[data-testid=like-button][aria-pressed=false]').waitFor();
  });

  let threadUrl = '';
  await step('Community thread: comment, then delete own comment', async () => {
    await feedCard(page, 'פוסט בדיקה e2e').getByTestId('comments-link').click();
    await page.waitForURL('**/community/?post=*');
    threadUrl = page.url();
    await page.getByText('עוד אין תגובות — מה דעתכם?').waitFor();
    await page.getByTestId('comment-input').fill('תגובה ראשונה e2e');
    await page.getByTestId('comment-send').click();
    const comment = page.locator('[data-testid=comment]', { hasText: 'תגובה ראשונה e2e' });
    await comment.waitFor();
    await page.getByTestId('comment-input').fill('תגובה שנשארת e2e');
    await page.getByTestId('comment-send').click();
    await page.locator('[data-testid=comment]', { hasText: 'תגובה שנשארת e2e' }).waitFor();
    await comment.getByTestId('content-menu').click();
    await page.locator('dialog[open]').getByRole('button', { name: 'מחיקה' }).click();
    await page.getByRole('button', { name: 'כן, למחוק' }).click();
    await comment.waitFor({ state: 'detached' });
    await page.reload();
    await page.locator('[data-testid=comment]', { hasText: 'תגובה שנשארת e2e' }).waitFor();
    assert(
      (await page.locator('[data-testid=comment]', { hasText: 'תגובה ראשונה e2e' }).count()) === 0,
      'deleted comment came back',
    );
    await noHorizontalScroll(page, 'community thread');
  });

  await step('Profile → My posts lists the posts and opens a thread', async () => {
    await page.goto(`${WEB}/profile/`);
    await page.getByRole('heading', { name: 'הפוסטים שלי' }).waitFor();
    const rows = page.getByTestId('my-post');
    await rows.first().waitFor();
    assert((await rows.count()) === 3, `my posts: ${await rows.count()}`);
    await rows.filter({ hasText: 'פוסט בדיקה e2e' }).click();
    await page.waitForURL('**/community/?post=*');
    await page.getByTestId('thread').waitFor();
  });

  const fan2Ctx = await newContext(browser);
  const fan2 = await fan2Ctx.newPage();
  watch(fan2, 'fan2');
  await step('a second fan reports the first fan’s post (reason + note)', async () => {
    await fan2.goto(`${WEB}/onboarding/`);
    await fan2.getByRole('button', { name: 'בואו נתחיל' }).click();
    await fan2.getByLabel('איך לקרוא לכם?').fill('E2E Second');
    await fan2.getByLabel('Team ID של FPL').fill(DEMO.vice);
    await fan2.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
    await fan2.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click();
    await fan2.getByRole('button', { name: 'שמרתי, יאללה' }).click();
    await fan2.waitForURL('**/news/');
    await fan2.goto(threadUrl);
    await fan2.locator('[data-testid=comment]', { hasText: 'תגובה שנשארת e2e' }).waitFor();
    const card = fan2.locator('[data-testid=thread] [data-testid=post-card]');
    await card.getByTestId('content-menu').click();
    const sheet = fan2.locator('dialog[open]');
    assert((await sheet.getByRole('button', { name: 'מחיקה' }).count()) === 0, 'no delete on others’ posts');
    await sheet.getByRole('button', { name: 'דיווח' }).click();
    await sheet.getByLabel('ספאם או פרסומת').check();
    await sheet.getByLabel(/פרטים נוספים/).fill('נראה כמו ספאם');
    await sheet.getByRole('button', { name: 'שליחת הדיווח' }).click();
    await fan2.getByText('תודה! הדיווח הועבר לצוות.').waitFor();
  });

  const modCtx = await newContext(browser);
  const mod = await modCtx.newPage();
  watch(mod, 'moderator');
  await step('admin removes the reported post from the reports queue', async () => {
    await mod.goto(`${WEB}/admin/login/`);
    await mod.getByLabel('שם משתמש').fill(ADMIN.username);
    await mod.getByLabel('סיסמה').fill(ADMIN.password);
    await mod.getByRole('button', { name: 'כניסה' }).click();
    await mod.waitForURL('**/admin/');
    await mod.getByRole('tablist', { name: 'אזורי ניהול' }).getByRole('tab', { name: 'קהילה' }).click();
    await mod.waitForURL('**/admin/?view=community');
    // An open report needs attention: the reports card opens by itself.
    await mod.locator('[data-testid=admin-card][data-card="community.reports"][data-open=true]').waitFor();
    const group = mod.locator('[data-testid=reports] li', { hasText: 'פוסט בדיקה e2e' });
    await group.waitFor();
    await group.getByText('ספאם או פרסומת').waitFor();
    await group.getByText('נראה כמו ספאם').waitFor();
    await group.getByRole('button', { name: 'הסרה' }).click();
    await mod.getByTestId('resolve-confirm').click();
    await group.waitFor({ state: 'detached' });
    await mod.getByText('אין דיווחים פתוחים').waitFor();
    await noHorizontalScroll(mod, 'admin community');
    await page.goto(`${WEB}/community/`);
    await feedCard(page, 'צילום מסך של ההעברות e2e').waitFor();
    // The device cache may show it for a moment; the background revalidation must take it out.
    await feedCard(page, 'פוסט בדיקה e2e').waitFor({ state: 'detached', timeout: 15_000 });
  });

  await step('admin bans the second fan → their composer is blocked with the notice', async () => {
    await openCard(mod, 'community.users');
    await mod.getByTestId('users-search').fill('E2E Second');
    const row = mod.locator('[data-testid=user-row]', { hasText: 'E2E Second' });
    await row.waitFor();
    await row.getByRole('button', { name: 'השעיה', exact: true }).click();
    const sheet = mod.locator('dialog[open]');
    await sheet.getByTestId('ban-confirm').click();
    await sheet.getByText('צריך לכתוב סיבה').waitFor(); // reason is required
    await sheet.getByLabel('סיבת ההשעיה').fill('בדיקת e2e');
    await sheet.getByTestId('ban-confirm').click();
    await row.getByText('מושעה').waitFor();

    await fan2.goto(`${WEB}/community/`);
    await fan2.getByTestId('banned-notice').getByText('החשבון שלך מושעה מפרסום כרגע').waitFor();
    assert(await fan2.getByTestId('composer-open').isDisabled(), 'composer must be blocked while banned');
    await feedCard(fan2, 'צילום מסך של ההעברות e2e').getByTestId('comments-link').click();
    await fan2.waitForURL('**/community/?post=*');
    await fan2.getByTestId('banned-notice').waitFor();
    await fan2.getByTestId('comment-input').waitFor();
    assert(
      await fan2.getByTestId('comment-input').isDisabled(),
      'comment input must be blocked while banned',
    );
    assert(
      await fan2.locator('[data-testid=thread] [data-testid=like-button]').isDisabled(),
      'like must be blocked while banned',
    );
  });

  await step('admin lifts the ban → the second fan can post again and the notice goes away', async () => {
    const row = mod.locator('[data-testid=user-row]', { hasText: 'E2E Second' });
    await row.getByRole('button', { name: 'ביטול השעיה' }).click();
    await mod.getByTestId('ban-confirm').click();
    await row.getByRole('button', { name: 'השעיה', exact: true }).waitFor();
    await fan2.goto(`${WEB}/community/`);
    await openComposer(fan2);
    await fan2.getByLabel('הטקסט של הפוסט').fill('חזרתי לפרסם e2e');
    await fan2.getByTestId('composer-submit').click();
    await feedCard(fan2, 'חזרתי לפרסם e2e').waitFor();
    await fan2.getByTestId('banned-notice').waitFor({ state: 'detached' });
  });

  await step('admin hides a News item, then restores it from Admin → Community', async () => {
    await mod.goto(`${WEB}/news/`);
    const card = mod.locator('#news-' + EP.apple.id);
    await card.getByRole('button', { name: 'הסתרה מהפיד' }).click();
    await mod.getByRole('button', { name: 'כן, להסתיר' }).click();
    await card.waitFor({ state: 'detached' });
    await mod.goto(`${WEB}/admin/?view=community`);
    await openCard(mod, 'community.hidden');
    const hidden = mod.locator('[data-testid=hidden-item]', { hasText: 'פרק 61' });
    await hidden.waitFor();
    await hidden.getByRole('button', { name: 'שחזור' }).click();
    await hidden.waitFor({ state: 'detached' });
    await mod.goto(`${WEB}/news/`);
    await mod.locator('#news-' + EP.apple.id).waitFor();
  });
  await modCtx.close();
  await fan2Ctx.close();

  // ---------- Phase 4: live updates (broadcast), admin password, terms ----------
  const BROADCAST_TEXT = 'עדכון חי e2e — סלאח כובש!';
  const target = (p, tg) => p.locator(`[data-testid=broadcast-target][data-target=${tg}]`);

  await step('admin home leads with the live-update card; it opens the composer', async () => {
    await admin.goto(`${WEB}/admin/`);
    const card = admin.getByTestId('live-update-card');
    await card.waitFor();
    await openCard(admin, 'settings.league');
    const league = admin.getByLabel('League ID של הליגה הקלאסית');
    await league.waitFor();
    const cardBox = await card.boundingBox();
    const leagueBox = await league.boundingBox();
    assert(cardBox && leagueBox && cardBox.y < leagueBox.y, 'the live-update card must come before settings');
    await card.click();
    await admin.waitForURL('**/admin/?view=broadcast');
    await admin.getByRole('heading', { name: 'עדכון חי' }).waitFor();
    await noHorizontalScroll(admin, 'broadcast composer');
  });

  await step('composer: X disabled with the paid note; a template chip inserts editable text', async () => {
    const x = target(admin, 'x');
    await x.waitFor();
    assert((await x.getAttribute('data-available')) === 'false', 'X must be unavailable in e2e');
    assert(await x.getByRole('switch').isDisabled(), 'X switch must be disabled');
    await x
      .getByTestId('broadcast-x-paid')
      .getByText("פיצ'ר בתשלום — צרו קשר עם היוצר אם תרצו להפעיל אותו")
      .waitFor();
    for (const tg of ['news', 'push']) {
      const on = await target(admin, tg).getByRole('switch').getAttribute('aria-checked');
      assert(on === 'true', `${tg} is on by default`);
    }
    assert((await admin.getByTestId('x-counter').count()) === 0, 'no X counter while X is off');
    await admin.getByRole('button', { name: '⚽ גול!' }).click();
    const text = admin.getByTestId('broadcast-text');
    assert(
      (await text.inputValue()).startsWith('⚽ גול! [שחקן]'),
      `template text: ${await text.inputValue()}`,
    );
    const selected = await text.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
    assert(selected === '[שחקן]', `the first placeholder is selected, got "${selected}"`);
    await admin.keyboard.type('סלאח');
    assert((await text.inputValue()).startsWith('⚽ גול! סלאח כובש'), 'typing replaces the placeholder');
  });

  await step('composer: the X counter is shown and enforced only when X is selected', async () => {
    // X needs the paid API keys, so e2e simulates "X connected" by answering the targets call on the client.
    await admin.route(`${API}/v1/admin/broadcast/targets`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': WEB },
        body: JSON.stringify({
          targets: [
            { target: 'news', available: true, reason: null, reasonCode: null, paidFeature: false },
            { target: 'push', available: true, reason: null, reasonCode: null, paidFeature: false },
            { target: 'x', available: true, reason: null, reasonCode: null, paidFeature: true },
          ],
        }),
      }),
    );
    await admin.reload();
    const x = target(admin, 'x');
    await admin.locator('[data-testid=broadcast-target][data-target=x][data-available=true]').waitFor();
    assert((await admin.getByTestId('x-counter').count()) === 0, 'X available but off → no counter');
    await x.getByRole('switch').click();
    const counter = admin.getByTestId('x-counter');
    const text = admin.getByTestId('broadcast-text');
    await text.fill('⚽ https://example.com/a/really/long/link/that/x/shortens/to/23');
    await counter.getByText('26/280').waitFor(); // emoji 2 + space 1 + any URL 23
    await text.fill('א'.repeat(281));
    await counter.getByText('281/280').waitFor();
    assert((await counter.getAttribute('data-over')) === 'true', 'counter turns red over 280');
    await admin.getByTestId('broadcast-review').click();
    await admin.getByText('ארוך מדי ל־X').first().waitFor();
    assert((await admin.locator('dialog[open]').count()) === 0, 'no confirm step while too long for X');
    await x.getByRole('switch').click(); // X off → the same text is fine for News / push
    assert((await admin.getByTestId('x-counter').count()) === 0, 'counter hidden once X is off');
    await admin.getByTestId('broadcast-review').click();
    await admin.locator('dialog[open] [data-testid=broadcast-confirm]').waitFor();
    await admin.keyboard.press('Escape');
    await admin.locator('dialog[open]').waitFor({ state: 'detached' });
    await admin.unroute(`${API}/v1/admin/broadcast/targets`);
  });

  let broadcastNewsUrl = '';
  await step(
    'admin sends a live update (News + Push, with a photo) and sees per-target results',
    async () => {
      await admin.goto(`${WEB}/admin/?view=broadcast`);
      await target(admin, 'news').waitFor();
      await admin.getByTestId('broadcast-text').fill(BROADCAST_TEXT);
      await admin.getByLabel('כותרת (לא חובה)').fill('גול e2e');
      await admin.getByTestId('broadcast-file').setInputFiles({
        name: 'goal.png',
        mimeType: 'image/png',
        buffer: makePng(320, 200),
      });
      await admin.waitForFunction(
        (api) =>
          document.querySelector('[data-testid=broadcast-photo] img')?.getAttribute('src')?.startsWith(api),
        API,
      );
      await admin.getByTestId('broadcast-review').click();
      const confirm = admin.locator('dialog[open] [data-testid=broadcast-confirm]');
      await confirm.waitFor();
      await confirm.getByText(BROADCAST_TEXT).waitFor();
      await confirm.getByText('פיד החדשות').waitFor();
      await confirm.getByText('התראה', { exact: true }).waitFor();
      assert((await confirm.getByText('X', { exact: true }).count()) === 0, 'X is not a destination');
      await admin.getByTestId('broadcast-send').click();
      const results = admin.getByTestId('broadcast-results');
      await results.waitFor();
      const news = results.locator('[data-testid=broadcast-result][data-target=news]');
      assert((await news.getAttribute('data-status')) === 'ok', 'news target ok');
      const push = results.locator('[data-testid=broadcast-result][data-target=push]');
      const pushStatus = await push.getAttribute('data-status');
      assert(pushStatus === 'ok' || pushStatus === 'skipped', `push target: ${pushStatus}`);
      // Outcomes are localized from the API's codes (the English `detail` is for logs).
      await news
        .getByTestId('broadcast-result-text')
        .getByText('פורסם בפיד החדשות', { exact: true })
        .waitFor();
      const pushText = (await push.getByTestId('broadcast-result-text').textContent()) ?? '';
      assert(
        pushText === 'עוד אף אחד לא הפעיל התראות חיות' || /^נשלח ל־\d+ מתוך \d+ מכשירים$/.test(pushText),
        `localized push outcome: "${pushText}"`,
      );
      assert(
        (await results.locator('[data-testid=broadcast-result][data-target=x]').count()) === 0,
        'no X result',
      );
      const saved = await admin.evaluate(() =>
        globalThis.localStorage.getItem('fant.admin.broadcastTargets'),
      );
      assert(saved === '["news","push"]', `remembered targets: ${saved}`);
      await noHorizontalScroll(admin, 'broadcast results');
      await news.getByTestId('broadcast-result-link').click();
      await admin.waitForURL('**/news/?item=*');
      broadcastNewsUrl = admin.url();
      await admin.locator('[data-testid=news-card]', { hasText: BROADCAST_TEXT }).first().waitFor();
    },
  );

  await step('the live update is in the fan’s News feed; history lists it; the composer resets', async () => {
    await page.goto(`${WEB}/news/`);
    const card = page.locator('[data-testid=news-card]', { hasText: BROADCAST_TEXT });
    await card.waitFor();
    await card.getByText('גול e2e').waitFor();
    await admin.goto(`${WEB}/admin/?view=broadcast`);
    await openCard(admin, 'broadcast.history');
    const item = admin.locator('[data-testid=broadcast-history-item]', { hasText: BROADCAST_TEXT });
    await item.waitFor();
    await item.getByText('גול e2e').waitFor();
    await item.locator('summary').click();
    await item.locator('[data-testid=broadcast-result][data-target=news][data-status=ok]').waitFor();
    assert((await admin.getByTestId('broadcast-text').inputValue()) === '', 'fresh composer');
    // The next update starts from the remembered targets.
    const on = await target(admin, 'push').getByRole('switch').getAttribute('aria-checked');
    assert(on === 'true', 'push remembered');
    assert(broadcastNewsUrl.includes('/news/?item='), 'news deep link');
  });

  await step(
    'a live update with a photo shows it on its News card; the cold-start preload is that very image, fetched once',
    async () => {
      const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      const ctx = await newContext(browser);
      await ctx.addInitScript((tok) => globalThis.localStorage.setItem('fant.token', tok), token);
      const p = await ctx.newPage();
      watch(p, 'live-update-photo');
      const mediaLoads = [];
      p.on('request', (r) => {
        if (r.resourceType() === 'image' && new URL(r.url()).pathname.startsWith('/media/'))
          mediaLoads.push(r.url());
      });
      await p.goto(`${WEB}/news/`);
      const card = p.locator('[data-testid=news-card]', { hasText: BROADCAST_TEXT }).first();
      await card.waitFor();
      // It is the newest item: the first card of the feed, so its photo is the screen's LCP.
      assert(
        (await p.locator('[data-testid=news-card]').first().textContent())?.includes(BROADCAST_TEXT),
        'the live update is the first card',
      );
      const img = card.locator('img[src*="/media/"]').first();
      await img.waitFor();
      await p.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle());
      const { currentSrc, priority } = await img.evaluate((el) => ({
        currentSrc: el.currentSrc,
        priority: el.getAttribute('fetchpriority'),
      }));
      assert(priority === 'high', `first card photo fetchpriority: ${priority}`);
      const preloads = await p.evaluate(() =>
        [...document.querySelectorAll('link[rel=preload][as=image]')]
          // Next's own preload of the header logo is static; the feed preload is the one for API media.
          .filter((l) => new URL(l.href).pathname.startsWith('/media/'))
          .map((l) => ({ href: l.href, srcset: l.getAttribute('imagesrcset') ?? '' })),
      );
      assert(preloads.length === 1, `one media preload (got ${preloads.length})`);
      const candidates = [
        preloads[0].href,
        ...preloads[0].srcset.split(',').map((c) => c.trim().split(' ')[0]),
      ];
      assert(
        candidates.includes(currentSrc),
        `preloaded ${JSON.stringify(preloads[0])}, shown ${currentSrc}`,
      );
      await sleep(500);
      assert(mediaLoads.length === 1, `the photo is downloaded once (got ${mediaLoads.join(', ')})`);
      assert(mediaLoads[0] === currentSrc, `downloaded ${mediaLoads[0]}, shown ${currentSrc}`);
      await noHorizontalScroll(p, 'news with a live-update photo');
      await ctx.close();
    },
  );

  await step(
    'sign-up with an unknown Team ID offers: try again, create an FPL team, continue as guest',
    async () => {
      const ctx = await newContext(browser);
      await joinLeagueRoutes(ctx);
      // FPL has no such team: the API's "not found" (what FPL's 404 becomes).
      await ctx.route(
        (u) => u.origin === API && u.pathname === '/v1/fpl/entries/99999999',
        (r) => r.fulfill(json({ error: { code: 'not_found', message: 'no such team' } }, 404)),
      );
      const p = await ctx.newPage();
      watch(p, 'guest');
      const authed = [];
      p.on('request', (r) => {
        if (r.url().startsWith(API) && r.headers().authorization) authed.push(r.url());
      });
      await p.goto(`${WEB}/onboarding/`);
      await p.getByRole('button', { name: 'בואו נתחיל' }).click();
      await p.getByLabel('איך לקרוא לכם?').fill('Guest Tester');
      const field = p.getByLabel('Team ID של FPL');
      await field.fill('99999999');
      await p.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
      const options = p.getByTestId('team-not-found');
      await options.waitFor();
      await noHorizontalScroll(p, 'team not found options');
      // 1. Try again: back in the field, the value selected for retyping.
      await options.getByTestId('team-retry').click();
      const sel = await p.evaluate(() => {
        const el = document.activeElement;
        return el?.tagName === 'INPUT' ? { v: el.value, s: el.selectionStart, e: el.selectionEnd } : null;
      });
      assert(
        sel && sel.v === '99999999' && sel.s === 0 && sel.e === 8,
        `focused + selected: ${JSON.stringify(sel)}`,
      );
      await p.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
      await options.waitFor();
      // 2. Create a team: FPL's own site, opened outside the app, with the come-back hint.
      const create = options.getByTestId('team-create');
      assert(
        (await create.getAttribute('href')) === 'https://fantasy.premierleague.com/',
        'create-team link',
      );
      await options.getByText('אחרי שיצרתם קבוצה, חזרו והזינו את ה־Team ID').waitFor();
      const [popup] = await Promise.all([p.waitForEvent('popup'), create.click()]);
      await popup.close();
      // 3. Continue as guest: into the app, remembered on the device.
      await options.getByTestId('team-guest').click();
      await p.waitForURL('**/news/');
      await p.locator('[data-testid=news-card]').first().waitFor();
      assert(
        (await p.evaluate(() => globalThis.localStorage.getItem('fant.guest'))) === '1',
        'guest remembered',
      );
      await p.getByTestId('join-bar').waitFor(); // guests are invited to the league too

      // Guests browse the public tabs…
      await p.goto(`${WEB}/table/`);
      await p.locator('main ol li button').first().waitFor();
      await p.goto(`${WEB}/live/`);
      await p.locator('main ol li button').first().waitFor();
      await p.locator('[data-fixture] button').first().click();
      await p.locator('dialog[open] [data-testid=fixture-sheet]').waitFor();
      await p.keyboard.press('Escape');
      await p.goto(`${WEB}/live/?view=captains`);
      await p.getByText('הקפטן של דור').first().waitFor();
      assert((await p.getByText('הקפטן שלי').count()) === 0, 'no "my captain" row for a guest');
      // …read Community, and every account-only action asks them to sign up.
      await p.goto(`${WEB}/community/`);
      await p.locator('[data-testid=post-card]').first().waitFor();
      await p.getByTestId('signup-prompt').first().waitFor();
      assert((await p.getByTestId('composer-open').count()) === 0, 'no composer for a guest');
      await p.locator('[data-testid=post-card] [data-testid=like-button]').first().click();
      await p.locator('dialog[open] [data-testid=signup-prompt]').waitFor();
      await p.keyboard.press('Escape');
      await p.locator('[data-testid=post-card] [data-testid=content-menu]').first().click();
      await p.locator('dialog[open] [data-testid=signup-prompt]').waitFor();
      await p.keyboard.press('Escape');
      await p.locator('[data-testid=post-card] [data-testid=comments-link]').first().click();
      await p.waitForURL('**/community/?post=*');
      await p.getByTestId('signup-prompt').waitFor();
      await p.goto(`${WEB}/my-team/`);
      await p.getByTestId('signup-prompt').waitFor();
      await p.goto(`${WEB}/news/`);
      await p.locator('[data-testid=news-card]').first().waitFor();
      assert((await p.getByTestId('push-prompt').count()) === 0, 'no notifications prompt for a guest');
      // Reopening skips onboarding.
      await p.reload();
      await p.locator('[data-testid=news-card]').first().waitFor();
      assert(p.url().endsWith('/news/'), `guest reopen: ${p.url()}`);
      // Profile → Sign up: back to the form, prefilled with what they typed.
      await p.goto(`${WEB}/profile/`);
      await p.getByTestId('join-bar').waitFor();
      await p.getByTestId('signup-link').click();
      await p.waitForURL('**/onboarding/?signup=1');
      await p.getByLabel('Team ID של FPL').waitFor();
      assert((await p.getByLabel('Team ID של FPL').inputValue()) === '99999999', 'Team ID prefilled');
      assert((await p.getByLabel('איך לקרוא לכם?').inputValue()) === 'Guest Tester', 'name prefilled');
      assert(authed.length === 0, `guest requests carried an auth header: ${authed.join(', ')}`);
      const kept = await persistedKeys(p);
      assert(
        !kept.some((k) => /^(me|fpl,(entry|picks|live)|league,position)/.test(k)),
        `per-user data persisted for a guest: ${kept.join(' · ')}`,
      );

      // The guest signs up for real: the prefill (name + Team ID) is wiped — on a shared phone the next person
      // must start blank — and stays gone after signing out.
      const draft = () => p.evaluate(() => globalThis.localStorage.getItem('fant.guest.draft'));
      assert((await draft()) !== null, 'the prefill was kept while a guest');
      await p.getByLabel('Team ID של FPL').fill('1000009');
      await p.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
      await p.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click();
      await p.getByRole('button', { name: 'שמרתי, יאללה' }).click();
      await p.waitForURL('**/news/');
      assert((await draft()) === null, 'sign-up prefill cleared after registering');
      assert(
        (await p.evaluate(() => globalThis.localStorage.getItem('fant.guest'))) === null,
        'no longer a guest',
      );
      await p.goto(`${WEB}/profile/`);
      await p.getByRole('button', { name: 'התנתקות' }).click();
      await p.getByRole('button', { name: 'התנתקות' }).first().click();
      await p.waitForURL('**/onboarding/');
      assert((await draft()) === null, 'sign-up prefill still gone after signing out');
      await ctx.close();
    },
  );

  const NEW_PASSWORD = 'e2e-new-admin-password';
  await step('admin password: validation, wrong current password, then a successful change', async () => {
    await admin.goto(`${WEB}/admin/?view=account`);
    await admin.getByRole('heading', { name: 'שינוי סיסמה' }).waitFor();
    const current = admin.getByLabel('הסיסמה הנוכחית');
    const next = admin.getByLabel('סיסמה חדשה', { exact: true });
    const confirm = admin.getByLabel('אימות הסיסמה החדשה');
    await current.fill('not-the-password');
    await next.fill('short');
    await admin.getByTestId('password-submit').click();
    await admin.getByText('הסיסמה החדשה צריכה לפחות 10 תווים').waitFor();
    await next.fill(NEW_PASSWORD);
    await confirm.fill(NEW_PASSWORD + 'x');
    await admin.getByTestId('password-submit').click();
    await admin.getByText('הסיסמאות לא תואמות').waitFor();
    // Show-password toggle
    assert((await next.getAttribute('type')) === 'password', 'hidden by default');
    await admin.getByRole('button', { name: 'הצגת הסיסמה' }).nth(1).click();
    assert((await next.getAttribute('type')) === 'text', 'shown after the toggle');
    await confirm.fill(NEW_PASSWORD);
    await admin.getByTestId('password-submit').click();
    await admin.getByText('הסיסמה הנוכחית שגויה').waitFor();
    assert(admin.url().endsWith('/admin/?view=account'), 'a wrong current password must not sign out');
    await current.fill(ADMIN.password);
    await admin.getByTestId('password-submit').click();
    await admin.getByText('הסיסמה שונתה. המכשירים האחרים נותקו.').waitFor();
    assert((await current.inputValue()) === '', 'form cleared');
  });

  await step('the new admin password signs in (the old one does not), then it is changed back', async () => {
    const ctx = await newContext(browser);
    const p2 = await ctx.newPage();
    watch(p2, 'admin-2');
    await p2.goto(`${WEB}/admin/login/`);
    await p2.getByLabel('שם משתמש').fill(ADMIN.username);
    await p2.getByLabel('סיסמה').fill(ADMIN.password);
    await p2.getByRole('button', { name: 'כניסה' }).click();
    await p2.getByText('שם משתמש או סיסמה שגויים').waitFor();
    await p2.getByLabel('סיסמה').fill(NEW_PASSWORD);
    await p2.getByRole('button', { name: 'כניסה' }).click();
    await p2.waitForURL('**/admin/');
    await p2.getByTestId('live-update-card').waitFor();
    await ctx.close();
    // Back to the original so the later journeys (and reruns) keep working. This device stayed signed in.
    await admin.getByLabel('הסיסמה הנוכחית').fill(NEW_PASSWORD);
    await admin.getByLabel('סיסמה חדשה', { exact: true }).fill(ADMIN.password);
    await admin.getByLabel('אימות הסיסמה החדשה').fill(ADMIN.password);
    await admin.getByTestId('password-submit').click();
    await admin.getByText('הסיסמה שונתה. המכשירים האחרים נותקו.').waitFor();
    await noHorizontalScroll(admin, 'admin account');
  });

  await step('block: fan A blocks fan B → B’s post disappears for A only; unblock restores it', async () => {
    const B_POST = 'חזרתי לפרסם e2e'; // fan2 ("E2E Second") posted it in Phase 3
    await page.goto(`${WEB}/community/`);
    const bCard = feedCard(page, B_POST);
    await bCard.waitFor();
    // Not offered on your own content.
    const own = feedCard(page, 'צילום מסך של ההעברות e2e');
    await own.getByTestId('content-menu').click();
    assert(
      (await page.locator('dialog[open] [data-testid=block-user]').count()) === 0,
      'no block on own post',
    );
    await page.keyboard.press('Escape');
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    await bCard.getByTestId('content-menu').click();
    await page.locator('dialog[open]').getByTestId('block-user').click();
    const sheet = page.locator('dialog[open] [data-testid=block-sheet]');
    await sheet.getByText('הם לא יקבלו הודעה על החסימה').waitFor();
    await page.getByRole('dialog', { name: 'לחסום את E2E Second?' }).waitFor();
    await sheet.getByTestId('block-confirm').click();
    await page.getByText('חסמתם את E2E Second').waitFor();
    await bCard.waitFor({ state: 'detached' });
    await page.reload();
    await feedCard(page, 'צילום מסך של ההעברות e2e').waitFor();
    assert((await feedCard(page, B_POST).count()) === 0, 'blocked author stays hidden after reload');
    // Others still see it.
    await admin.goto(`${WEB}/community/`);
    await feedCard(admin, B_POST).waitFor();
    // Profile → Blocked users → unblock.
    await page.goto(`${WEB}/profile/`);
    const row = page.locator('[data-testid=blocked-user]', { hasText: 'E2E Second' });
    await row.waitFor();
    await noHorizontalScroll(page, 'profile blocked users');
    await row.getByRole('button', { name: 'ביטול חסימה' }).click();
    await page.getByTestId('blocked-empty').waitFor();
    await page.goto(`${WEB}/community/`);
    await feedCard(page, B_POST).waitFor();
  });

  await step(
    'delete account: a fresh fan deletes it, the token dies, and the Team ID can register again',
    async () => {
      const ctx = await newContext(browser);
      const fan = await ctx.newPage();
      watch(fan, 'deleter');
      const register = async (name) => {
        await fan.goto(`${WEB}/onboarding/`);
        await fan.getByRole('button', { name: 'בואו נתחיל' }).click();
        await fan.getByLabel('איך לקרוא לכם?').fill(name);
        await fan.getByLabel('Team ID של FPL').fill(DEMO.normal);
        await fan.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
        await fan.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click();
        await fan.getByRole('button', { name: 'שמרתי, יאללה' }).click();
        await fan.waitForURL('**/news/');
      };
      await register('E2E Leaver');
      const token = await fan.evaluate(() => globalThis.localStorage.getItem('fant.token'));
      assert(token, 'signed in');
      await fan.goto(`${WEB}/profile/`);
      await fan.getByTestId('delete-account-open').click();
      const sheet = fan.locator('dialog[open] [data-testid=delete-account-sheet]');
      await sheet.getByText('קבוצת ה־FPL שלכם לא נפגעת', { exact: false }).waitFor();
      const submit = sheet.getByTestId('delete-account-submit');
      assert(await submit.isDisabled(), 'disabled until the word is typed');
      await sheet.getByTestId('delete-account-confirm-input').fill('מחקקק');
      assert(await submit.isDisabled(), 'a wrong word keeps it disabled');
      await sheet.getByTestId('delete-account-confirm-input').fill('מחק');
      await noHorizontalScroll(fan, 'delete account sheet');
      await submit.click();
      await fan.waitForURL('**/onboarding/');
      await fan.getByText('החשבון נמחק. תודה שהייתם איתנו!').waitFor();
      assert(
        (await fan.evaluate(() => globalThis.localStorage.getItem('fant.token'))) === null,
        'token cleared',
      );
      const left = (await persistedKeys(fan)).filter((k) => PRIVATE_KEY.test(k));
      assert(left.length === 0, `persisted after account deletion: ${left.join(' | ')}`);
      const me = await globalThis.fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
      assert(me.status === 401, `the old token must be dead, got ${me.status}`);
      // The same Team ID registers again as a brand-new account (no "already registered").
      await register('E2E Returner');
      await fan.goto(`${WEB}/profile/`);
      await fan.getByText('E2E Returner').first().waitFor();
      await ctx.close();
    },
  );

  // ---------- admin invites (one-time links → the hosts' own accounts become admins) ----------
  /** Registers a fan from the onboarding screen (whatever banner is showing) and confirms the recovery code. */
  const signUp = async (p, name, teamId) => {
    await p.getByRole('button', { name: 'בואו נתחיל' }).click();
    await p.getByLabel('איך לקרוא לכם?').fill(name);
    await p.getByLabel('Team ID של FPL').fill(teamId);
    await p.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
    await p.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click();
    await p.getByRole('button', { name: 'שמרתי, יאללה' }).click();
  };
  /** Creates an invite in the admin console and returns its link (shown once). */
  const createInvite = async (label) => {
    await admin.goto(`${WEB}/admin/`);
    await openCard(admin, 'settings.invites');
    const form = admin.getByTestId('invite-form');
    await form.getByLabel('למי ההזמנה?').fill(label);
    await form.getByTestId('invite-create').click();
    const sheet = admin.locator('dialog[open] [data-testid=invite-created]');
    await sheet.waitFor();
    const url = ((await sheet.getByTestId('invite-url').textContent()) ?? '').trim();
    assert(/^.+\/onboarding\/[?#]invite=.{20,}$/.test(url), `invite url: ${url}`);
    return { sheet, url };
  };
  /** The same link in the other form: `#invite=` (current) ↔ `?invite=` (links sent before the switch). */
  const otherForm = (url) =>
    url.includes('#invite=') ? url.replace('#invite=', '?invite=') : url.replace('?invite=', '#invite=');
  const inviteRow = (label) => admin.locator(`[data-testid=invite-row][data-label="${label}"]`);
  let hostInvite = '';

  await step('admin creates an invite: the link is shown once with copy and the 7-day note', async () => {
    const { sheet, url } = await createInvite('דור e2e');
    hostInvite = url;
    await sheet.getByText('הקישור עובד פעם אחת ותקף ל־7 ימים').waitFor();
    await sheet.getByTestId('invite-copy').waitFor();
    await noHorizontalScroll(admin, 'invite created sheet');
    await sheet.getByRole('button', { name: 'סיום' }).click();
    await admin.locator('dialog[open]').waitFor({ state: 'detached' });
    await inviteRow('דור e2e').getByText('ממתין').waitFor();
    assert((await admin.getByText(url).count()) === 0, 'the link is not shown again after closing');
  });

  await step(
    'a fresh visitor opens the invite, registers and lands in the admin console as an admin',
    async () => {
      const ctx = await newContext(browser);
      const host = await ctx.newPage();
      watch(host, 'host');
      const token = hostInvite.split('invite=')[1];
      const previewUrls = [];
      host.on('request', (r) => {
        if (r.url().startsWith(API) && r.url().includes('admin-invites')) previewUrls.push(r.url());
      });
      await host.goto(hostInvite);
      const banner = host.getByTestId('invite-banner');
      await banner.getByText('הוזמנת להיות מנהל/ת בפנטזיונרים 🎙️').waitFor();
      await banner.getByText('דור e2e', { exact: false }).waitFor();
      assert(!host.url().includes('invite='), `the token must leave the address bar: ${host.url()}`);
      assert(!previewUrls.some((u) => u.includes(token)), 'the token never travels in a URL');
      assert(
        previewUrls.some((u) => u.endsWith('/v1/admin-invites/preview')),
        'preview via POST',
      );
      await noHorizontalScroll(host, 'onboarding with invite');
      await signUp(host, 'E2E Host', DEMO.host);
      await host.waitForURL('**/admin/');
      await host.getByText('ברוכים הבאים לניהול, E2E Host!', { exact: false }).waitFor();
      await host.getByTestId('live-update-card').waitFor();
      await host.goto(`${WEB}/admin/?view=account`);
      await host
        .getByTestId('no-password')
        .getByText('את/ה מחובר/ת עם חשבון האפליקציה — אין סיסמה')
        .waitFor();
      await host.goto(`${WEB}/profile/`);
      await host.getByRole('link', { name: 'קונסולת ניהול' }).waitFor();
      await ctx.close();
      await admin.goto(`${WEB}/admin/`);
      await openCard(admin, 'settings.invites');
      await inviteRow('דור e2e').getByText('נוצל ע״י E2E Host').waitFor();
    },
  );

  const reuserCtx = await newContext(browser);
  const reuser = await reuserCtx.newPage();
  watch(reuser, 'reuser');
  await step('reusing a used invite link: "no longer valid", then a normal fan sign-up', async () => {
    await reuser.goto(otherForm(hostInvite)); // both link forms are read
    await reuser.getByTestId('invite-invalid').getByText('הקישור כבר לא בתוקף — בקשו קישור חדש').waitFor();
    assert(!reuser.url().includes('invite='), `stripped from the address bar: ${reuser.url()}`);
    assert((await reuser.getByTestId('invite-banner').count()) === 0, 'no admin banner');
    await signUp(reuser, 'E2E Reuser', DEMO.reuser);
    await reuser.waitForURL('**/news/');
    await reuser.goto(`${WEB}/profile/`);
    await reuser.getByText('E2E Reuser').first().waitFor();
    assert((await reuser.getByRole('link', { name: 'קונסולת ניהול' }).count()) === 0, 'stays a fan');
  });

  await step('revoking a pending invite makes its link invalid', async () => {
    const { sheet, url } = await createInvite('לביטול e2e');
    await sheet.getByRole('button', { name: 'סיום' }).click();
    const row = inviteRow('לביטול e2e');
    await row.getByTestId('invite-revoke').click();
    await row.getByTestId('invite-revoke-confirm').click();
    await row.getByText('בוטל').waitFor();
    const ctx = await newContext(browser);
    const p = await ctx.newPage();
    watch(p, 'revoked-visitor');
    await p.goto(otherForm(url));
    await p.getByTestId('invite-invalid').waitFor();
    await ctx.close();
  });

  await step(
    'an invite revoked mid-signup: only the clear "no longer valid" banner, then a fan sign-up',
    async () => {
      const { sheet, url } = await createInvite('באמצע e2e');
      await sheet.getByRole('button', { name: 'סיום' }).click();
      const ctx = await newContext(browser);
      const p = await ctx.newPage();
      watch(p, 'late-invitee');
      await p.goto(url);
      await p.getByTestId('invite-banner').waitFor();
      await p.getByRole('button', { name: 'בואו נתחיל' }).click();
      await p.getByLabel('איך לקרוא לכם?').fill('E2E Late');
      await p.getByLabel('Team ID של FPL').fill(DEMO.lateInvitee);
      await p.getByRole('button', { name: 'מצאו את הקבוצה שלי' }).click();
      await p.getByText('זו הקבוצה שלכם?').waitFor();
      // The admin revokes it while the visitor is on the confirm step.
      const row = inviteRow('באמצע e2e');
      await row.getByTestId('invite-revoke').click();
      await row.getByTestId('invite-revoke-confirm').click();
      await admin.locator('[data-testid=invite-row][data-label="באמצע e2e"][data-status=revoked]').waitFor();
      await p.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click();
      await p.getByTestId('invite-invalid').getByText('הקישור כבר לא בתוקף — בקשו קישור חדש').waitFor();
      assert(
        (await p.locator('main [role=alert]').count()) === 1,
        'only the invite notice — no generic error',
      );
      await p.getByRole('button', { name: 'כן, זו הקבוצה שלי' }).click(); // now as a normal fan
      await p.getByRole('button', { name: 'שמרתי, יאללה' }).click();
      await p.waitForURL('**/news/');
      await ctx.close();
    },
  );

  await step(
    'an existing signed-in fan opens an invite and upgrades their own account to admin',
    async () => {
      const { sheet, url } = await createInvite('איתי e2e');
      await sheet.getByRole('button', { name: 'סיום' }).click();
      await reuser.goto(url);
      const redeem = reuser.getByTestId('invite-redeem');
      await redeem.getByText('להפוך את החשבון שלך למנהל?').waitFor();
      await redeem.getByText('E2E Reuser', { exact: false }).waitFor();
      await redeem.getByTestId('invite-redeem-confirm').click();
      await reuser.waitForURL('**/admin/');
      await reuser.getByTestId('live-update-card').waitFor();
      await admin.goto(`${WEB}/admin/`);
      await openCard(admin, 'settings.invites');
      await inviteRow('איתי e2e').getByText('נוצל ע״י E2E Reuser').waitFor();
    },
  );
  await reuserCtx.close();

  await step('/terms/ renders and is linked from Profile and onboarding', async () => {
    await page.goto(`${WEB}/profile/`);
    await page.getByTestId('profile-terms').click();
    await page.waitForURL('**/terms/');
    await page.getByRole('heading', { name: 'כללי הקהילה ופרטיות', level: 1 }).waitFor();
    await page.getByText('ashalim.fantasy@gmail.com').waitFor();
    await page.getByText('דיווח ואכיפה').waitFor();
    await page.getByTestId('terms-block').getByText('חסימת משתמש', { exact: false }).waitFor();
    await page.getByText('פרופיל ← "מחיקת חשבון"', { exact: false }).waitFor();
    await noHorizontalScroll(page, 'terms');
    await page.getByRole('button', { name: 'חזרה' }).click();
    await page.waitForURL('**/profile/');

    const ctx = await newContext(browser);
    const guest = await ctx.newPage();
    watch(guest, 'guest');
    await guest.goto(`${WEB}/onboarding/`);
    await guest
      .getByTestId('terms-line')
      .getByRole('link', { name: 'כללי הקהילה ולמדיניות הפרטיות' })
      .waitFor();
    await guest.getByRole('button', { name: 'בואו נתחיל' }).click();
    const line = guest.getByTestId('terms-line');
    await line.waitFor();
    await line.getByRole('link').click();
    await guest.waitForURL('**/terms/');
    await guest.getByRole('heading', { name: 'כללי הקהילה ופרטיות', level: 1 }).waitFor();
    assert(guest.url().endsWith('/terms/'), 'a signed-out visitor stays on /terms/');
    await ctx.close();
  });

  await step(
    'reopening with a slow API: cached content shows instantly with "Updating…", no skeletons',
    async () => {
      await page.goto(`${WEB}/news/`);
      await page.locator('[data-testid=news-card]').first().waitFor();
      await page.waitForFunction(() =>
        (globalThis.localStorage.getItem('fant.queryCache') ?? '').includes('"feed"'),
      );
      const kept = await persistedKeys(page);
      assert(kept.includes('news,feed') && kept.includes('me'), `persisted: ${kept.join(' | ')}`);
      assert(
        !kept.some((k) => k.startsWith('admin') || k.includes('recovery')),
        `never persisted: ${kept.join(' | ')}`,
      );
      await slowApi(page, 10_000);
      await page.reload({ waitUntil: 'commit' });
      const t0 = Date.now();
      await page.locator('[data-testid=news-card]').first().waitFor({ timeout: 1_000 });
      const ms = Date.now() - t0;
      log(`  cached News visible ${ms} ms after reload (API answering 10 s late)`);
      assert((await page.locator('main .skeleton').count()) === 0, 'no skeletons over cached content');
      await page.getByTestId('updating-indicator').getByText('מתעדכן…').waitFor({ timeout: 3_000 });
      assert(
        (await page.getByTestId('waking-notice').count()) === 0,
        'not "waking up" when content is shown',
      );
      await page.unroute(`${API}/**`);
      await page.getByTestId('updating-indicator').waitFor({ state: 'detached', timeout: 30_000 });
      await noHorizontalScroll(page, 'updating indicator');
    },
  );

  await step('first visit with a slow API: "waking up the server" after ~4 s, then the content', async () => {
    const token = await page.evaluate(() => globalThis.localStorage.getItem('fant.token'));
    const ctx = await newContext(browser);
    await ctx.addInitScript((tok) => {
      if (!globalThis.sessionStorage.getItem('e2e-init')) {
        globalThis.localStorage.setItem('fant.token', tok); // signed in, but nothing cached on this device
        globalThis.sessionStorage.setItem('e2e-init', '1');
      }
    }, token);
    const p = await ctx.newPage();
    watch(p, 'cold');
    await slowApi(p, 7_000);
    await p.goto(`${WEB}/news/`, { waitUntil: 'commit' });
    const t0 = Date.now();
    await sleep(3_000);
    assert((await p.getByTestId('waking-notice').count()) === 0, 'no "waking up" notice before ~4 s');
    await p.getByTestId('waking-notice').getByText('השרת מתעורר, עוד רגע…').waitFor({ timeout: 4_000 });
    log(`  "waking up" shown after ${Date.now() - t0} ms`);
    await noHorizontalScroll(p, 'waking notice');
    await p.locator('[data-testid=news-card]').first().waitFor({ timeout: 60_000 });
    await p.unroute(`${API}/**`);
    await p.getByTestId('waking-notice').waitFor({ state: 'detached', timeout: 30_000 });
    await ctx.close();
  });

  await step('sign out, then recover the account with the recovery code', async () => {
    await page.goto(`${WEB}/profile/`);
    await page.getByRole('button', { name: 'התנתקות' }).click();
    await page.getByRole('button', { name: 'התנתקות' }).first().click();
    await page.waitForURL('**/onboarding/');
    // Logout forgets the device cache: nothing of the old session survives (now, or after the next save).
    for (const wait of [0, 1_500]) {
      await sleep(wait);
      const left = (await persistedKeys(page)).filter((k) => PRIVATE_KEY.test(k));
      assert(left.length === 0, `persisted after logout: ${left.join(' | ')}`);
    }
    await page.getByRole('button', { name: /התחברו עם קוד שחזור/ }).click();
    await page.getByLabel('Team ID של FPL').fill(DEMO.tripleCaptain);
    await page.getByLabel('קוד שחזור').fill(recoveryCode);
    await page.getByRole('button', { name: 'התחברות', exact: true }).click();
    await page.waitForURL('**/news/');
  });

  await step(
    'admin sign-in on a fan device keeps the fan session and restores it on admin sign-out',
    async () => {
      await page.goto(`${WEB}/admin/login/`);
      await page.getByText('יישמר בצד').waitFor();
      await page.getByLabel('שם משתמש').fill(ADMIN.username);
      await page.getByLabel('סיסמה').fill(ADMIN.password);
      await page.getByRole('button', { name: 'כניסה' }).click();
      await page.waitForURL('**/admin/');
      await page.getByRole('button', { name: 'יציאה מהניהול' }).click();
      await page.waitForURL('**/news/');
      await page.goto(`${WEB}/profile/`);
      await page.getByText('E2E Tester').first().waitFor();
    },
  );

  await updateJourneys(user);

  await adminCtx.close();
  await user.close();
}

// ---------- updates reaching installed apps (src/lib/updates.ts) ----------

/** Pretend the page went to the background / came back (headless pages are always "visible"). */
async function setVisibility(p, state) {
  await p.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function resume(p) {
  await setVisibility(p, 'hidden');
  await setVisibility(p, 'visible');
}

const buildOf = (p) => p.evaluate(() => document.documentElement.dataset.build ?? null);

/** Polls across reloads (an evaluate in a page that is navigating just throws). */
async function waitForBuild(p, id, ms = 20_000) {
  const until = Date.now() + ms;
  let seen = null;
  while (Date.now() < until) {
    try {
      seen = await buildOf(p);
      if (seen === id && (await p.evaluate(() => document.readyState)) === 'complete') return;
    } catch {
      // navigating
    }
    await sleep(200);
  }
  throw new Error(`expected build ${id}, still on ${seen}`);
}

/** Counts document loads of a page (`framenavigated` would also count Next's same-document replaceState). */
function countLoads(p) {
  const c = { n: 0 };
  p.on('load', () => c.n++);
  return c;
}

/** Timestamps of a page's document loads and update checks (`/version.json` fetches). */
function trackChecks(p) {
  const t = { load: Date.now(), check: 0 };
  p.on('load', () => (t.load = Date.now()));
  p.on('request', (r) => {
    if (r.url() === `${WEB}/version.json`) t.check = Date.now();
  });
  return t;
}

/** The watcher checks once ~3 s after boot and throttles resume checks to one per 5 s: let that settle. */
async function bootCheckDone(t) {
  const until = Date.now() + 15_000;
  while (t.check <= t.load && Date.now() < until) await sleep(100);
  assert(t.check > t.load, 'the app checks /version.json after boot');
  await sleep(Math.max(0, t.check + 5_500 - Date.now()));
}

async function updateJourneys(ctx) {
  const up = await ctx.newPage();
  watch(up, 'updates');
  const loads = countLoads(up);
  const checks = trackChecks(up);
  deploy.from = null;
  deploy.to = null;

  let A = '';
  let B = '';
  let C = '';
  await step(
    'a deploy reaches an open app on resume: version.json differs → reload into the new build',
    async () => {
      await up.goto(`${WEB}/news/`);
      await up.locator('[data-testid=news-card]').first().waitFor();
      await up.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      A = (await buildOf(up)) ?? '';
      assert(A, 'the HTML carries its build id');
      const v = await (await globalThis.fetch(`${WEB}/version.json`)).json();
      assert(v.buildId === A, `version.json ${v.buildId} ≠ html ${A}`);
      const sw = await (await globalThis.fetch(`${WEB}/sw.js`)).text();
      assert(sw.includes(`const BUILD_ID = '${A}'`), 'sw.js is stamped with the build id');
      assert(sw.includes("url.pathname.startsWith('/media/')) return;"), 'sw.js never intercepts /media/*');
      await bootCheckDone(checks);
      assert((await buildOf(up)) === A, 'no reload while nothing changed');

      B = `e2eb-${A}`;
      deploy.from = A;
      deploy.to = B;
      const before = loads.n;
      await resume(up);
      await waitForBuild(up, B);
      await up.locator('[data-testid=news-card]').first().waitFor();
      assert(loads.n === before + 1, `exactly one reload (got ${loads.n - before})`);
      // The new worker took over and purged the previous deploy's caches.
      let keys = [];
      for (const until = Date.now() + 15_000; Date.now() < until; await sleep(300)) {
        keys = await up.evaluate(() => caches.keys());
        if (keys.includes(`fant-${B}-shell`) && !keys.some((k) => k.startsWith(`fant-${A}-`))) break;
      }
      assert(
        keys.includes(`fant-${B}-shell`) && !keys.some((k) => k.startsWith(`fant-${A}-`)),
        `caches after the update: ${keys.join(', ')}`,
      );
      const settled = await up.evaluate(() =>
        navigator.serviceWorker.getRegistration().then((r) => !!r?.active && !r.waiting && !r.installing),
      );
      assert(settled, 'the new worker is active, none left waiting');
      await bootCheckDone(checks);
      assert(loads.n === before + 1, 'no second reload once on the new build');
    },
  );

  const DRAFT = 'טיוטה שלא נשלחה e2e — draft';
  await step(
    'a deploy while a post is being typed: toast instead of reload, the draft survives',
    async () => {
      await up.goto(`${WEB}/community/`);
      await up.getByTestId('composer-open').click();
      const box = up.locator('dialog[open] [data-testid=composer] textarea');
      await box.fill(DRAFT);
      await bootCheckDone(checks);
      C = `e2ec-${A}`;
      deploy.to = C;
      const before = loads.n;
      await resume(up);
      await up.getByTestId('update-toast').waitFor();
      await up.getByTestId('update-toast').getByText('גרסה חדשה זמינה — רענון').waitFor();
      await sleep(6_000); // well past the settle delay: still typing → still no reload
      assert(loads.n === before, 'must not reload over a draft');
      assert((await box.inputValue()) === DRAFT, 'the typed text is untouched');
      assert((await buildOf(up)) === B, 'still on the old build');
      // Done with it (sheet closed, nothing left on screen): the app updates by itself a moment later…
      await up.keyboard.press('Escape');
      await waitForBuild(up, C);
      assert(loads.n === before + 1, `one reload after the draft was put away (got ${loads.n - before})`);
      // …and the draft is still there when the composer is reopened.
      await up.getByTestId('composer-open').click();
      const again = up.locator('dialog[open] [data-testid=composer] textarea');
      await again.waitFor();
      assert(
        (await again.inputValue()) === DRAFT,
        `draft restored after the reload: "${await again.inputValue()}"`,
      );
      await again.fill('');
      await up.keyboard.press('Escape');
    },
  );

  await step(
    'a chunk of a vanished build fails to load → one reload to the same URL, never a loop',
    async () => {
      await up.goto(`${WEB}/table/`);
      await bootCheckDone(checks);
      const url = up.url();
      const before = loads.n;
      const missing = () =>
        up.evaluate(() => {
          const s = document.createElement('script');
          s.src = `/_next/static/chunks/e2e-gone-${Date.now()}.js`;
          document.head.appendChild(s);
        });
      await missing();
      const until = Date.now() + 10_000;
      while (loads.n === before && Date.now() < until) await sleep(100);
      assert(loads.n === before + 1, 'one reload after the chunk 404');
      await waitForBuild(up, C);
      assert(up.url() === url, `same URL after the reload (${up.url()})`);
      // Still failing after that reload (a real outage): no more reloads — neither for a script tag…
      await missing();
      // …nor for a webpack-style ChunkLoadError surfacing as an unhandled rejection.
      await up.evaluate(() => {
        const err = Object.assign(new Error('Loading chunk 999 failed.'), { name: 'ChunkLoadError' });
        const promise = Promise.reject(err);
        promise.catch(() => undefined);
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: err }));
      });
      await sleep(3_000);
      assert(loads.n === before + 1, `no reload loop (got ${loads.n - before} reloads)`);
    },
  );

  await step('reopening the app refetches News (focus wiring covers iOS resume)', async () => {
    const p = await ctx.newPage();
    watch(p, 'resume');
    await p.clock.install();
    const feedCalls = [];
    p.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin === API && u.pathname === '/v1/news' && u.searchParams.get('limit') === '15') {
        feedCalls.push(Date.now());
      }
    });
    await p.goto(`${WEB}/news/`);
    await p.locator('[data-testid=news-card]').first().waitFor();
    const initial = feedCalls.length;
    assert(initial >= 1, 'feed loaded');
    await setVisibility(p, 'hidden');
    await p.clock.fastForward('03:00'); // away for a few minutes: the cached feed is stale now
    await sleep(500);
    assert(feedCalls.length === initial, 'no refetch while hidden');
    await setVisibility(p, 'visible');
    const until = Date.now() + 5_000;
    while (feedCalls.length === initial && Date.now() < until) await sleep(100);
    assert(feedCalls.length > initial, 'News refetched within seconds of reopening');
    await p.close();
  });

  deploy.from = null;
  deploy.to = null;
  await up.close();
}

// ---------- main ----------
let api = null;
let web = null;
let webCdn = null;
let browser = null;
let failed = false;
try {
  resetDatabase();
  if (!process.env.E2E_SKIP_DB_RESET) seedNews();
  buildWeb();
  buildWeb(CDN_DIST, { FANT_CDN_JSON: '1' });
  api = startApi();
  web = await startStatic();
  webCdn = await startStatic(CDN_DIST, WEB_CDN_PORT, true);
  await waitFor(`${API}/health`, 60_000);
  browser = await chromium.launch({ headless: !process.env.E2E_HEADED });
  globalThis.__browser = browser;
  await journeys(browser);
} catch (e) {
  failed = true;
  if (!results.some((r) => !r.ok)) log('setup failed:', e instanceof Error ? e.message : e);
} finally {
  await browser?.close();
  web?.close();
  webCdn?.close();
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  if (api?.pid) {
    try {
      process.kill(-api.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

if (consoleErrors.length) {
  failed = true;
  log('unexpected console errors:\n  ' + consoleErrors.join('\n  '));
}
const passed = results.filter((r) => r.ok).length;
log(`${passed}/${results.length} journeys passed${failed ? ' — FAILED' : ''}`);
process.exit(failed ? 1 : 0);
