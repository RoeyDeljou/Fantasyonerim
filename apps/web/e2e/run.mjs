/* global document */
// End-to-end suite for the web app: real apps/api (FPL_MODE=demo) + the static export, driven by Playwright.
//
//   npm run e2e -w @fant/web
//
// What it does (see apps/web/README.md):
//   1. recreates a dedicated Postgres database (fantasyonerim_e2e) and runs `prisma migrate deploy`
//   2. builds the static export into apps/web/out/.e2e with NEXT_PUBLIC_API_URL pointing at the e2e API
//   3. boots apps/api on :4100 in demo mode (offline, deterministic FPL data) and serves the export on :5100
//   4. runs the user journeys below at a 390×844 phone viewport and fails on any unexpected console error
//
// Env overrides: E2E_DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT, E2E_SKIP_BUILD=1, E2E_SKIP_DB_RESET=1, E2E_HEADED=1.
import { spawn, spawnSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
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
const DB_NAME = 'fantasyonerim_e2e';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `postgresql://fant:fant@localhost:5432/${DB_NAME}`;
const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password' };
const DEMO = { tripleCaptain: '1000003', normal: '1000001', vice: '1000002', league: '314159' };

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
function buildWeb() {
  if (process.env.E2E_SKIP_BUILD && existsSync(path.join(WEB_DIR, DIST, 'index.html'))) return;
  log('building static export for e2e');
  const envFile = path.join(WEB_DIR, 'next-env.d.ts');
  const envBackup = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
  try {
    run('npx', ['next', 'build'], {
      cwd: WEB_DIR,
      env: { ...process.env, NEXT_PUBLIC_API_URL: API, FANT_E2E_DIST: DIST, NEXT_TELEMETRY_DISABLED: '1' },
    });
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
      CORS_ORIGINS: WEB,
      ADMIN_BOOTSTRAP_USERNAME: ADMIN.username,
      ADMIN_BOOTSTRAP_PASSWORD: ADMIN.password,
      SECRETS_KEY: randomBytes(32).toString('base64'),
      JOBS_ENABLED: 'false', // no network in e2e: News is seeded (seedNews)
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPID_PRIVATE_KEY: VAPID.privateKey,
      VAPID_SUBJECT: 'mailto:e2e@example.com',
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
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
};

function startStatic() {
  const root = path.join(WEB_DIR, DIST);
  const server = createServer(async (req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url ?? '/', WEB).pathname));
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // fall through to 404
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(await readFile(path.join(root, '404.html')).catch(() => 'not found'));
    }
  });
  return new Promise((resolve) => server.listen(WEB_PORT, '127.0.0.1', () => resolve(server)));
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
    throw e;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' });
  // Image CDNs are irrelevant to behaviour and may be unreachable in CI.
  await ctx.route(/premierleague\.com/, (r) => r.abort());
  // Listening happens on Spotify / Apple: their pages are never loaded in e2e, only the navigation is checked.
  await ctx.route(/open\.spotify\.com|podcasts\.apple\.com|instagram\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<title>external</title>' }),
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

async function journeys(browser) {
  let recoveryCode = '';
  const user = await newContext(browser);
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
        hrefs.length === 2 && hrefs[0] === EP.both.spotify && hrefs[1] === EP.both.apple,
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

  await step('My Team shows the Triple Captain chip and the pitch', async () => {
    await page.goto(`${WEB}/my-team/`);
    await page.getByTestId('pitch-player').first().waitFor();
    assert((await page.getByTestId('pitch-player').count()) === 15, 'expected 15 players on pitch + bench');
    await page.locator('section').getByText('טריפל קפטן').first().waitFor();
    await page.getByText('פעיל עכשיו').first().waitFor();
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
    await admin.getByLabel('League ID של הליגה הקלאסית').fill(DEMO.league);
    await admin.getByRole('button', { name: 'שמירת הליגה' }).click();
    await admin.getByText('Fantasyonerim League').first().waitFor();
    // Default rows: Dor (linked), Itay (linked), community (player).
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
  });

  await step('admin Integrations lists all five sources with the X paid-feature note', async () => {
    await admin.goto(`${WEB}/admin/?view=integrations`);
    await admin.getByTestId('integration-card').first().waitFor();
    const ids = await admin
      .getByTestId('integration-card')
      .evaluateAll((cs) => cs.map((c) => c.getAttribute('data-integration')));
    assert(ids.join(',') === 'podcast_rss,apple,spotify,instagram,x', `cards: ${ids.join(',')}`);
    await admin
      .locator('[data-integration=x] [data-testid=x-paid-note]')
      .getByText("פיצ'ר בתשלום — צרו קשר עם היוצר אם תרצו להפעיל אותו")
      .waitFor();
    await admin
      .locator('[data-integration=instagram]')
      .getByRole('button', { name: 'התחברות עם Facebook' })
      .waitFor();
    await noHorizontalScroll(admin, 'admin integrations');
  });

  await step('Instagram OAuth return (?instagram=error) shows a notice and cleans the URL', async () => {
    await admin.goto(`${WEB}/admin/?instagram=error&reason=access_denied`);
    await admin.getByText('החיבור לאינסטגרם נכשל: access_denied').waitFor();
    await admin.waitForURL('**/admin/?view=integrations');
  });

  await step('admin manual post appears in News; admin can hide it', async () => {
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
    await page.locator('ol li button').first().click();
    await page.locator('dialog[open] [data-testid="pitch-player"], dialog[open] .flex-col').first().waitFor();
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page, 'table');
  });

  await step('Captain Battle lists the configured rows plus "my captain"', async () => {
    await page.goto(`${WEB}/live/?view=captains`);
    await page.getByText('הקפטן שלי').first().waitFor();
    await page.getByText('הקפטן של דור').first().waitFor();
    await page.getByText('קפטן הקהילה').first().waitFor();
    await noHorizontalScroll(page, 'captain battle');
  });

  await step('sign out, then recover the account with the recovery code', async () => {
    await page.goto(`${WEB}/profile/`);
    await page.getByRole('button', { name: 'התנתקות' }).click();
    await page.getByRole('button', { name: 'התנתקות' }).first().click();
    await page.waitForURL('**/onboarding/');
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

  await adminCtx.close();
  await user.close();
}

// ---------- main ----------
let api = null;
let web = null;
let browser = null;
let failed = false;
try {
  resetDatabase();
  if (!process.env.E2E_SKIP_DB_RESET) seedNews();
  buildWeb();
  api = startApi();
  web = await startStatic();
  await waitFor(`${API}/health`, 60_000);
  browser = await chromium.launch({ headless: !process.env.E2E_HEADED });
  await journeys(browser);
} catch (e) {
  failed = true;
  if (!results.some((r) => !r.ok)) log('setup failed:', e instanceof Error ? e.message : e);
} finally {
  await browser?.close();
  web?.close();
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
