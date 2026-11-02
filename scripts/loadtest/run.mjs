#!/usr/bin/env node
// Fantasyonerim API load test. See docs/PERFORMANCE.md for what it simulates and how to read the output.
//
//   node scripts/loadtest/run.mjs [--cpu 0.1] [--duration 240] [--users 150] [--label after]
//                                 [--phases profile,mix] [--memory 512] [--port 4100]
//
// 1. Resets + migrates LT_DATABASE_URL (default: local fantasyonerim_loadtest) and seeds it (lib/seed.mjs).
// 2. profile: boots the API (jobs off) and drives each endpoint alone with autocannon → CPU-ms per request
//    (the process's own CPU time ÷ requests), latency, bytes.
// 3. mix: boots the API with jobs on, CPU-limited (cgroup cpu.cfs_quota_us, like a container's CPU limit),
//    and runs `users` virtual users through a live-Saturday session for `duration` seconds: polling the Live
//    tab / My Team / match sheet every 30 s, opening News / Community, resuming the app — each with its own
//    bearer token and a browser-like HTTP cache (ETag / max-age). Reports per-endpoint p50/p95/p99, errors,
//    RSS, CPU and event-loop delay measured inside the API process.
/* global Buffer, performance, setTimeout, clearTimeout, setInterval, clearInterval -- Node.js globals (eslint's .mjs config lists only a few) */
import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import autocannon from 'autocannon';
import webpush from 'web-push';
import { buildScaledDataset } from './lib/fpl.mjs';
import { seed } from './lib/seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const API_DIR = resolve(ROOT, 'apps/api');

const { values: args } = parseArgs({
  options: {
    cpu: { type: 'string', default: '0.1' },
    memory: { type: 'string', default: '512' },
    duration: { type: 'string', default: '240' },
    users: { type: 'string', default: '150' },
    label: { type: 'string', default: 'run' },
    phases: { type: 'string', default: 'profile,mix' },
    port: { type: 'string', default: '4100' },
    'no-build': { type: 'boolean', default: false },
    'no-seed': { type: 'boolean', default: false },
  },
});

const CPU = Number(args.cpu);
const MEMORY_MB = Number(args.memory);
const DURATION_S = Number(args.duration);
const USERS = Number(args.users);
const PORT = Number(args.port);
const PHASES = new Set(args.phases.split(','));
const DB_URL = process.env.LT_DATABASE_URL ?? 'postgresql://fant:fant@localhost:5432/fantasyonerim_loadtest';
const OUT_DIR = resolve(HERE, 'results');
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_FIXTURE = 87;
const EVENT = 9;

const log = (...m) => console.warn(`[loadtest ${new Date().toISOString().slice(11, 19)}]`, ...m);

// ---------------------------------------------------------------- setup

function build() {
  if (args['no-build']) return;
  log('building apps/api (tsc -p)…');
  // -p (not -b): compiles apps/api against the packages' current dist without rebuilding them.
  execFileSync(
    process.execPath,
    [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'apps/api/tsconfig.json'],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );
}

/**
 * Migrates the load-test DB (`migrate deploy`, additive) and empties its tables, like the API test suite does.
 * Refuses anything but a local database whose name contains "loadtest": this wipes it.
 */
function assertLoadTestDb(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (!local || !u.pathname.includes('loadtest')) {
    throw new Error(
      `LT_DATABASE_URL must be a local database named *loadtest* (got ${u.hostname}${u.pathname})`,
    );
  }
}

async function resetDb() {
  assertLoadTestDb(DB_URL);
  log('migrating + truncating', DB_URL.replace(/\/\/[^@]*@/, '//***@'));
  execFileSync(process.execPath, [resolve(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: DB_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasourceUrl: DB_URL });
  try {
    const tables = await prisma.$queryRaw`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    if (list) await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}

const vapid = webpush.generateVAPIDKeys();
const CRON_SECRET = 'loadtest-cron-secret-0123456789';

function serverEnv(jobs) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    DATABASE_URL: DB_URL,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: process.env.LT_LOG_LEVEL ?? 'info',
    TRUST_PROXY: 'true',
    CORS_ORIGINS: 'https://fantasyonerim.vercel.app',
    FPL_MODE: 'demo',
    SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    CRON_SECRET,
    API_PUBLIC_URL: 'https://fantasyonerim-api.onrender.com',
    WEB_APP_URL: 'https://fantasyonerim.vercel.app',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:loadtest@example.com',
    MEDIA_STORE: 's3',
    S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
    S3_REGION: 'eu-central-003',
    S3_BUCKET: 'loadtest',
    S3_ACCESS_KEY_ID: 'loadtest',
    S3_SECRET_ACCESS_KEY: 'loadtest',
    S3_PUBLIC_BASE_URL: 'https://f003.backblazeb2.com/file/fantasyonerim-media',
    MEDIA_PUBLIC_BASE_URL: 'https://fantasyonerim.vercel.app/media',
    JOBS_ENABLED: jobs ? 'true' : 'false',
    PREWARM_ENABLED: jobs ? 'true' : 'false',
    LT_MANAGERS: String(USERS),
    // Knobs under test: LT_ENV_FOO=bar → FOO=bar in the API process.
    ...Object.fromEntries(
      Object.entries(process.env)
        .filter(([k]) => k.startsWith('LT_ENV_'))
        .map(([k, v]) => [k.slice('LT_ENV_'.length), v]),
    ),
  };
}

/** Puts `pid` under a CPU quota (cgroup v1 cfs or v2 cpu.max) and a memory limit. Returns what was applied. */
function limitProcess(pid, cpu, memoryMb) {
  const applied = [];
  const name = `fant-loadtest-${process.pid}`;
  const cleanups = [];
  if (cpu > 0) {
    const v1 = `/sys/fs/cgroup/cpu/${name}`;
    const v2 = `/sys/fs/cgroup/${name}`;
    try {
      if (existsSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')) {
        mkdirSync(v1, { recursive: true });
        writeFileSync(`${v1}/cpu.cfs_period_us`, '100000');
        writeFileSync(`${v1}/cpu.cfs_quota_us`, String(Math.round(cpu * 100000)));
        writeFileSync(`${v1}/cgroup.procs`, String(pid));
        applied.push(`cgroup v1 cpu.cfs_quota_us=${Math.round(cpu * 100000)}/100000 (${cpu} CPU)`);
        cleanups.push(() => rmdirSync(v1));
      } else if (existsSync('/sys/fs/cgroup/cgroup.controllers')) {
        mkdirSync(v2, { recursive: true });
        writeFileSync(`${v2}/cpu.max`, `${Math.round(cpu * 100000)} 100000`);
        writeFileSync(`${v2}/cgroup.procs`, String(pid));
        applied.push(`cgroup v2 cpu.max=${Math.round(cpu * 100000)} 100000 (${cpu} CPU)`);
        cleanups.push(() => rmdirSync(v2));
      }
    } catch (err) {
      log('CPU limit failed:', err.message);
    }
    if (applied.length === 0)
      log(`WARNING: no cgroup CPU controller — running UNLIMITED (asked for ${cpu} CPU)`);
  }
  if (memoryMb > 0) {
    const m = `/sys/fs/cgroup/memory/${name}`;
    try {
      if (existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
        mkdirSync(m, { recursive: true });
        writeFileSync(`${m}/memory.limit_in_bytes`, String(memoryMb * 1048576));
        writeFileSync(`${m}/cgroup.procs`, String(pid));
        applied.push(`cgroup v1 memory.limit_in_bytes=${memoryMb} MB`);
        cleanups.push(() => rmdirSync(m));
      }
    } catch (err) {
      log('memory limit failed:', err.message);
    }
  }
  return {
    applied,
    cleanup: () => {
      for (const c of cleanups) {
        try {
          c();
        } catch {
          // the cgroup is removed once its last process has exited
        }
      }
    },
  };
}

class ApiProcess {
  constructor({ jobs, cpu, memoryMb }) {
    this.samples = [];
    this.waiters = new Map();
    this.child = fork(resolve(HERE, 'server.mjs'), [], {
      env: serverEnv(jobs),
      // LT_CPU_PROF=<dir>: V8 CPU profile of the API process (open in Chrome DevTools / speedscope).
      execArgv: [
        '--expose-gc',
        ...(process.env.LT_CPU_PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.LT_CPU_PROF}`] : []),
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.limits = limitProcess(this.child.pid, cpu, memoryMb);
    this.logLines = 0;
    this.errorLines = [];
    const onLine = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue;
        this.logLines += 1;
        if (/"level":(50|60)/.test(line) || /Error/.test(line.slice(0, 200))) {
          if (this.errorLines.length < 20) this.errorLines.push(line.slice(0, 400));
        }
      }
    };
    this.child.stdout.on('data', onLine);
    this.child.stderr.on('data', onLine);
    this.child.on('message', (msg) => {
      if (msg.type === 'sample') this.samples.push(msg);
      const w = this.waiters.get(msg.type);
      if (w) {
        this.waiters.delete(msg.type);
        w(msg);
      }
    });
    this.exited = new Promise((r) => this.child.on('exit', (code) => r(code)));
  }
  wait(type, timeoutMs = 120_000) {
    return new Promise((resolveWait, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.set(type, (m) => {
        clearTimeout(t);
        resolveWait(m);
      });
    });
  }
  async ask(type, reply) {
    const p = this.wait(reply);
    this.child.send({ type });
    return p;
  }
  async stop() {
    this.child.send({ type: 'stop' });
    const code = await Promise.race([
      this.exited,
      new Promise((r) => setTimeout(() => r('timeout'), 15_000)),
    ]);
    if (code === 'timeout') this.child.kill('SIGKILL');
    this.limits.cleanup();
  }
}

// ---------------------------------------------------------------- http client (one keep-alive pool per VU)

function decode(res, body) {
  const enc = res.headers['content-encoding'];
  if (enc === 'gzip') return gunzipSync(body);
  if (enc === 'br') return brotliDecompressSync(body);
  return body;
}

function request(agent, { method = 'GET', path, headers = {}, body = null, timeoutMs = 30_000 }) {
  return new Promise((resolveReq) => {
    const started = performance.now();
    const req = http.request(
      BASE + path,
      {
        method,
        agent,
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate, br',
          ...(body !== null ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolveReq({ status: res.statusCode ?? 0, ms: performance.now() - started, res, raw });
        });
        res.on('error', () =>
          resolveReq({ status: 0, ms: performance.now() - started, res: null, raw: null }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) =>
      resolveReq({ status: 0, ms: performance.now() - started, res: null, raw: null, error: err.message }),
    );
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------- stats

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
const r1 = (n) => Math.round(n * 10) / 10;

class Recorder {
  constructor() {
    this.byLabel = new Map();
    this.browserHits = 0;
  }
  add(label, result) {
    let s = this.byLabel.get(label);
    if (!s) {
      s = { lat: [], errors: 0, statuses: {}, notModified: 0, bytes: 0, count: 0 };
      this.byLabel.set(label, s);
    }
    s.count += 1;
    s.lat.push(result.ms);
    s.statuses[result.status] = (s.statuses[result.status] ?? 0) + 1;
    if (result.status === 304) s.notModified += 1;
    if (result.status === 0 || result.status >= 400) s.errors += 1;
    s.bytes += result.raw?.length ?? 0;
  }
  summary() {
    const rows = [];
    for (const [label, s] of [...this.byLabel].sort((a, b) => b[1].count - a[1].count)) {
      const sorted = [...s.lat].sort((a, b) => a - b);
      rows.push({
        endpoint: label,
        requests: s.count,
        errors: s.errors,
        statuses: s.statuses,
        notModifiedPct: r1((s.notModified / s.count) * 100),
        p50: r1(pct(sorted, 50)),
        p95: r1(pct(sorted, 95)),
        p99: r1(pct(sorted, 99)),
        max: r1(sorted[sorted.length - 1] ?? 0),
        avgKb: r1(s.bytes / s.count / 1024),
      });
    }
    return rows;
  }
}

// ---------------------------------------------------------------- profile phase (autocannon, one endpoint at a time)

function profileTargets(users, postIds) {
  const pick = (i) => users[i % users.length];
  const auth = (u) => ({ authorization: `Bearer ${u.token}` });
  return [
    { name: 'GET /health', path: () => '/health' },
    { name: 'GET /v1/config', path: () => '/v1/config' },
    { name: 'GET /v1/me', path: () => '/v1/me', auth: true },
    { name: 'GET /v1/fpl/bootstrap', path: () => '/v1/fpl/bootstrap', amount: 60 },
    { name: 'GET /v1/fpl/fixtures?event', path: () => `/v1/fpl/fixtures?event=${EVENT}` },
    { name: 'GET /v1/fpl/fixtures/:id', path: () => `/v1/fpl/fixtures/${LIVE_FIXTURE}` },
    {
      name: 'GET /v1/fpl/entries/:id/live',
      path: (i) => `/v1/fpl/entries/${pick(i).entryId}/live?event=${EVENT}`,
      auth: true,
    },
    {
      name: 'GET /v1/fpl/entries/:id/picks',
      path: (i) => `/v1/fpl/entries/${pick(i).entryId}/picks?event=${EVENT}`,
      auth: true,
    },
    { name: 'GET /v1/fpl/entries/:id', path: (i) => `/v1/fpl/entries/${pick(i).entryId}`, auth: true },
    { name: 'GET /v1/league/live', path: (i) => `/v1/league/live?page=${(i % 3) + 1}`, auth: true },
    { name: 'GET /v1/league/standings', path: () => '/v1/league/standings?page=1', auth: true },
    { name: 'GET /v1/captain-battle', path: () => '/v1/captain-battle', auth: true },
    { name: 'GET /v1/news', path: () => '/v1/news?limit=15', auth: true },
    { name: 'GET /v1/news/stories', path: () => '/v1/news/stories', auth: true },
    { name: 'GET /v1/news/filters', path: () => '/v1/news/filters', auth: true },
    { name: 'GET /v1/community/posts', path: () => '/v1/community/posts?limit=20', auth: true },
    {
      name: 'GET /v1/community/posts/:id/comments',
      path: (i) => `/v1/community/posts/${postIds[i % postIds.length]}/comments`,
      auth: true,
    },
  ].map((t) => ({
    ...t,
    headersFor: (i) => ({
      ...(t.auth ? auth(pick(i)) : {}),
      'x-forwarded-for': `10.1.${i % 200}.${(i * 7) % 250}`,
    }),
  }));
}

async function runProfile(api, users, postIds) {
  const out = [];
  for (const target of profileTargets(users, postIds)) {
    const amount = target.amount ?? 300;
    // warm: the first request pays for cold caches; we report it separately.
    const cold = await request(undefined, { path: target.path(0), headers: target.headersFor(0) });
    await new Promise((r) => setTimeout(r, 200));
    const before = await api.ask('reset', 'reset-ok');
    let i = 0;
    const result = await autocannon({
      url: BASE,
      connections: 4,
      amount,
      timeout: 60,
      requests: [
        {
          setupRequest: (req) => {
            const n = i++;
            return {
              ...req,
              method: 'GET',
              path: target.path(n),
              headers: { accept: 'application/json', 'accept-encoding': 'gzip, br', ...target.headersFor(n) },
            };
          },
        },
      ],
    });
    const after = await api.ask('report', 'report');
    const done = result.requests.total || amount;
    const row = {
      endpoint: target.name,
      requests: done,
      non2xx: result.non2xx,
      errors: result.errors + result.timeouts,
      cpuMsPerReq: Math.round(((after.cpuMs - before.cpuMs) / done) * 100) / 100,
      coldMs: r1(cold.ms),
      coldStatus: cold.status,
      p50: result.latency.p50,
      p99: result.latency.p99,
      avgKb: r1(result.throughput.average / Math.max(1, result.requests.average) / 1024),
      rps: r1(result.requests.average),
      maxRpsAt0_1Cpu: 0,
    };
    row.maxRpsAt0_1Cpu = row.cpuMsPerReq > 0 ? r1(100 / row.cpuMsPerReq) : null;
    log(
      `${row.endpoint}: ${row.cpuMsPerReq} CPU-ms/req, p50 ${row.p50} ms, ${row.avgKb} KB, non2xx ${row.non2xx}`,
    );
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- mix phase (virtual users)

const jitter = (ms, frac = 0.1) => ms * (1 - frac + Math.random() * 2 * frac);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Label for the per-endpoint table: route pattern, no ids/query values. */
function labelOf(method, path) {
  const p = path
    .split('?')[0]
    .replace(/\/entries\/\d+/, '/entries/:id')
    .replace(/\/fixtures\/\d+/, '/fixtures/:id')
    .replace(/\/posts\/[^/]+\/like/, '/posts/:id/like');
  const q = path.includes('?event=') && p === '/v1/fpl/fixtures' ? '?event' : '';
  return `${method} ${p}${q}`;
}

class VirtualUser {
  constructor(index, user, ip, rec, postIds, endAt) {
    this.i = index;
    this.user = user;
    this.ip = ip;
    this.rec = rec;
    this.postIds = postIds;
    this.endAt = endAt;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
    this.cache = new Map(); // path → { etag, freshUntil }
    this.lastFetch = new Map(); // react-query staleness, per path
    // Screen at peak: 45% Live tab (league), 15% Live tab (captain battle), 40% My Team.
    const r = (index * 0.6180339887) % 1;
    this.screen = r < 0.45 ? 'league' : r < 0.6 ? 'battle' : 'myteam';
    this.leaguePages = this.screen === 'league' && index % 3 === 0 ? 3 : 1;
    this.matchSheet = index % 5 === 0;
  }

  alive() {
    return Date.now() < this.endAt;
  }

  async get(path, { staleMs = 0 } = {}) {
    const now = Date.now();
    const last = this.lastFetch.get(path);
    if (staleMs > 0 && last !== undefined && now - last < staleMs) return null; // react-query: still fresh
    this.lastFetch.set(path, now);
    const cached = this.cache.get(path);
    if (cached && cached.freshUntil > now) {
      this.rec.browserHits += 1; // browser HTTP cache: no request at all
      return cached.body;
    }
    const headers = { authorization: `Bearer ${this.user.token}`, 'x-forwarded-for': this.ip };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    const result = await request(this.agent, { path, headers });
    this.rec.add(labelOf('GET', path), result);
    if (result.status === 304 && cached) {
      cached.freshUntil = now + maxAge(result.res) * 1000;
      return cached.body;
    }
    if (result.status === 200 && result.res) {
      const etag = result.res.headers.etag;
      const age = maxAge(result.res);
      const body = { raw: result.raw, res: result.res };
      if (etag || age > 0) this.cache.set(path, { etag, freshUntil: now + age * 1000, body });
      return body;
    }
    return null;
  }

  async write(method, path, body) {
    const headers = { authorization: `Bearer ${this.user.token}`, 'x-forwarded-for': this.ip };
    const result = await request(this.agent, { method, path, headers, body });
    this.rec.add(labelOf(method, path), result);
  }

  /** App opened / resumed: React Query refetches stale queries on focus. */
  async resume() {
    await Promise.all([
      this.get('/v1/config', { staleMs: 5 * 60_000 }),
      this.get('/v1/me', { staleMs: 60_000 }),
      this.get('/v1/fpl/bootstrap', { staleMs: 10 * 60_000 }),
    ]);
    await this.poll();
    if (this.screen === 'myteam') {
      await Promise.all([
        this.get(`/v1/fpl/entries/${this.user.entryId}`, { staleMs: 60_000 }),
        this.get(`/v1/fpl/entries/${this.user.entryId}/picks?event=${EVENT}`, { staleMs: 60_000 }),
      ]);
    }
  }

  /** One 30-second polling round of the visible screen. */
  async poll() {
    const jobs = [this.get(`/v1/fpl/fixtures?event=${EVENT}`)];
    if (this.screen === 'league') {
      jobs.push(
        (async () => {
          for (let p = 1; p <= this.leaguePages; p += 1) await this.get(`/v1/league/live?page=${p}`);
        })(),
      );
    } else if (this.screen === 'battle') {
      jobs.push(this.get('/v1/captain-battle'));
    } else {
      jobs.push(this.get(`/v1/fpl/entries/${this.user.entryId}/live?event=${EVENT}`));
    }
    if (this.matchSheet) jobs.push(this.get(`/v1/fpl/fixtures/${LIVE_FIXTURE}`));
    await Promise.all(jobs);
  }

  async openNews() {
    const [page] = await Promise.all([
      this.get('/v1/news?limit=15'),
      this.get('/v1/news/filters', { staleMs: 5 * 60_000 }),
      this.get('/v1/news/stories', { staleMs: 60_000 }),
    ]);
    if (page && Math.random() < 0.25) {
      try {
        const json = JSON.parse(decode(page.res, page.raw).toString('utf8'));
        if (json.nextCursor)
          await this.get(`/v1/news?cursor=${encodeURIComponent(json.nextCursor)}&limit=15`);
      } catch {
        // a 304'd body without cache — skip the scroll
      }
    }
  }

  async openCommunity() {
    await this.get('/v1/community/posts?limit=20');
    if (Math.random() < 0.2) {
      const post = this.postIds[(this.i * 13 + Date.now()) % this.postIds.length];
      await this.write('PUT', `/v1/community/posts/${post}/like`, null);
    }
  }

  async run(startDelayMs) {
    await sleep(startDelayMs);
    await this.resume();
    let nextPoll = Date.now() + jitter(30_000);
    let nextResume = Date.now() + jitter(4 * 60_000, 0.5);
    let nextNews = Date.now() + jitter(3 * 60_000, 0.6);
    while (this.alive()) {
      const now = Date.now();
      const next = Math.min(nextPoll, nextResume, nextNews);
      if (next > now) await sleep(Math.min(next - now, this.endAt - now));
      if (!this.alive()) break;
      const t = Date.now();
      if (t >= nextResume) {
        nextResume = t + jitter(4 * 60_000, 0.5);
        nextPoll = t + jitter(30_000);
        await this.resume();
      } else if (t >= nextNews) {
        nextNews = t + jitter(4 * 60_000, 0.5);
        await this.openNews();
        if (Math.random() < 0.3) await this.openCommunity();
      } else if (t >= nextPoll) {
        nextPoll = t + jitter(30_000, 0.05);
        await this.poll();
      }
    }
    this.agent.destroy();
  }
}

function maxAge(res) {
  const cc = res?.headers['cache-control'] ?? '';
  if (/no-store|no-cache/.test(cc)) return 0;
  const m = /max-age=(\d+)/.exec(cc);
  return m ? Number(m[1]) : 0;
}

async function runMix(api, users, postIds) {
  const rec = new Recorder();
  const rampMs = 30_000;
  const endAt = Date.now() + DURATION_S * 1000;
  // IPs: a third of the users share 3 carrier CGNAT addresses (+ one pub Wi-Fi), the rest are distinct.
  const ipOf = (i) =>
    i % 3 === 0 ? `100.64.0.${(i % 4) + 1}` : `10.2.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  const before = await api.ask('reset', 'reset-ok');
  const samplesFrom = api.samples.length;
  const vus = users.map((u, i) => new VirtualUser(i, u, ipOf(i), rec, postIds, endAt));
  log(`mix: ${vus.length} users, ${DURATION_S}s (ramp ${rampMs / 1000}s)`);
  const progress = setInterval(() => {
    const total = [...rec.byLabel.values()].reduce((a, s) => a + s.count, 0);
    const last = api.samples[api.samples.length - 1];
    log(`  ${total} requests, RSS ${last?.rssMb} MB, lag p99 ${last?.lag?.p99} ms`);
  }, 30_000);
  await Promise.all(vus.map((vu, i) => vu.run((i / vus.length) * rampMs)));
  clearInterval(progress);
  const after = await api.ask('report', 'report');
  const samples = api.samples.slice(samplesFrom);
  const rows = rec.summary();
  const total = rows.reduce((a, r) => a + r.requests, 0);
  const errors = rows.reduce((a, r) => a + r.errors, 0);
  const cpuMs = after.cpuMs - before.cpuMs;
  const wallMs = after.t - before.t;
  // CPU % per second (of one core) from consecutive samples.
  const cpuPerSec = samples
    .slice(1)
    .map((s, i) => (s.cpuMs - samples[i].cpuMs) / ((s.t - samples[i].t) / 1000) / 10);
  return {
    users: vus.length,
    durationS: DURATION_S,
    requests: total,
    rps: r1(total / (wallMs / 1000)),
    browserCacheHits: rec.browserHits,
    errors,
    cpuMsTotal: Math.round(cpuMs),
    cpuMsPerRequest: Math.round((cpuMs / Math.max(1, total)) * 100) / 100,
    avgCpuPctOfCore: r1((cpuMs / wallMs) * 100),
    peakCpuPctOfCore: r1(Math.max(0, ...cpuPerSec)),
    rssMbMax: Math.max(...samples.map((s) => s.rssMb)),
    rssMbEnd: after.rssMb,
    heapMbMax: Math.max(...samples.map((s) => s.heapMb)),
    eventLoop: after.lag,
    eventLoopWorstSecondP99: Math.max(...samples.map((s) => s.lag.p99)),
    fplUpstreamCalls: after.upstream - before.upstream,
    endpoints: rows,
    timeline: samples.map((s) => ({
      t: s.t,
      rssMb: s.rssMb,
      heapMb: s.heapMb,
      cpuMs: s.cpuMs,
      lagP99: s.lag.p99,
      lagMax: s.lag.max,
    })),
  };
}

// ---------------------------------------------------------------- report

function table(rows, cols) {
  const head = `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |`;
  return [
    head,
    ...rows.map(
      (r) => `| ${cols.map((c) => (typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(' | ')} |`,
    ),
  ].join('\n');
}

async function main() {
  build();
  const dataset = buildScaledDataset({ managers: USERS });
  const captain = dataset.picks
    .get(`${dataset.entryIds[0]}:${EVENT}`)
    .picks.find((p) => p.is_captain).element;
  let seeded = null;
  const ensureSeed = async () => {
    if (args['no-seed'] && seeded) return seeded;
    await resetDb();
    seeded = await seed(DB_URL, { users: USERS, leagueId: dataset.leagueId, captainPlayerId: captain });
    log(
      `seeded ${seeded.users.length} users, ${seeded.newsIds.length} news items, ${seeded.postIds.length} posts`,
    );
    return seeded;
  };

  const result = {
    label: args.label,
    at: new Date().toISOString(),
    node: process.version,
    cpuLimit: CPU,
    memoryLimitMb: MEMORY_MB,
  };
  mkdirSync(OUT_DIR, { recursive: true });

  if (PHASES.has('profile')) {
    const { users, postIds } = await ensureSeed();
    log('profile: booting API (jobs off, no CPU limit)…');
    const api = new ApiProcess({ jobs: false, cpu: 0, memoryMb: 0 });
    const ready = await api.wait('ready');
    result.bootRssMb = ready.rssMb;
    result.profile = await runProfile(api, users, postIds);
    await api.stop();
  }

  if (PHASES.has('mix')) {
    const { users, postIds } = await ensureSeed();
    log(`mix: booting API (jobs on, ${CPU > 0 ? `${CPU} CPU` : 'no CPU limit'}, ${MEMORY_MB} MB)…`);
    const api = new ApiProcess({ jobs: true, cpu: CPU, memoryMb: MEMORY_MB });
    const ready = await api.wait('ready', 300_000);
    result.limits = api.limits.applied;
    result.bootRssMbLimited = ready.rssMb;
    // Production has already ingested the feeds: one cron tick first, so the mix measures steady-state jobs
    // (no-op dedupe polls, live alerts) instead of a fresh install importing every episode.
    const tick = await request(undefined, {
      method: 'POST',
      path: '/internal/jobs/tick',
      headers: { 'x-cron-secret': CRON_SECRET },
      timeoutMs: 300_000,
    });
    log(
      `pre-mix cron tick: ${tick.status} in ${Math.round(tick.ms)} ms ${tick.raw?.toString().slice(0, 200) ?? ''}`,
    );
    await sleep(5_000);
    result.mix = await runMix(api, users, postIds);
    result.mix.serverErrorLog = api.errorLines;
    await api.stop();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = resolve(OUT_DIR, `${args.label}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  const md = [
    `# Load test: ${args.label} (${result.at})`,
    '',
    `Limits: ${(result.limits ?? []).join('; ') || 'none'}`,
    '',
  ];
  if (result.profile) {
    md.push('## Profile (one endpoint at a time, unthrottled; CPU-ms = API process CPU ÷ requests)', '');
    md.push(
      table(result.profile, [
        'endpoint',
        'cpuMsPerReq',
        'maxRpsAt0_1Cpu',
        'coldMs',
        'p50',
        'p99',
        'avgKb',
        'non2xx',
      ]),
      '',
    );
  }
  if (result.mix) {
    const m = result.mix;
    md.push(`## Peak mix: ${m.users} users, ${m.durationS}s`, '');
    md.push(
      `requests ${m.requests} (${m.rps}/s), browser-cache hits ${m.browserCacheHits}, errors ${m.errors}, CPU ${m.cpuMsPerRequest} ms/req, ` +
        `avg CPU ${m.avgCpuPctOfCore}% of a core (peak second ${m.peakCpuPctOfCore}%), RSS max ${m.rssMbMax} MB (end ${m.rssMbEnd}), ` +
        `heap max ${m.heapMbMax} MB, event-loop p50 ${m.eventLoop.p50} / p99 ${m.eventLoop.p99} / max ${m.eventLoop.max} ms, FPL upstream calls ${m.fplUpstreamCalls}`,
      '',
    );
    md.push(
      table(m.endpoints, [
        'endpoint',
        'requests',
        'errors',
        'notModifiedPct',
        'p50',
        'p95',
        'p99',
        'max',
        'avgKb',
        'statuses',
      ]),
      '',
    );
  }
  writeFileSync(`${base}.md`, md.join('\n'));
  process.stdout.write(`${md.join('\n')}\n`);
  log(`wrote ${base}.json / .md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
