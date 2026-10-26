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
import { randomBytes } from 'node:crypto';
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
    consoleErrors.push(`${tag}: ${text}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${tag}: ${e.message}`));
}

async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' });
  // Image CDNs are irrelevant to behaviour and may be unreachable in CI.
  await ctx.route(/premierleague\.com/, (r) => r.abort());
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
