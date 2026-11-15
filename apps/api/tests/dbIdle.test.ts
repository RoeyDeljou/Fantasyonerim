import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecrets } from '../src/integrations/store.js';
import { devSecretsKey } from '../src/secrets.js';
import {
  FakePushProvider,
  MemoryMediaStore,
  episode,
  fakeIntegrations,
  fakeMediaFetch,
  igPost,
  igStory,
  result,
  subscribe,
} from './fakes.js';
import { makeBootstrap, makeEvents, makeFixture, makePicks, type FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  TEST_DATABASE_URL,
  type TestClock,
} from './helpers.js';

/**
 * "Keeping Neon asleep": simulates whole days of the production schedule (in-process scheduler every 30 s, the
 * external cron tick + /health ping every 5 min) with the fake clock and counts every SQL statement the app
 * sends. Neon suspends its compute ~5 minutes after the last query, so "awake minutes" = the union of
 * [query, query + 5 min) windows.
 *
 * Measured on this simulation (Nov 2026):
 * - before (keep-alive SELECT 1 on /health, lease read on every 30 s tick, every due job writing its lease):
 *   24 h idle = 15,668 queries / ~1,195 awake minutes (~20 h); busy evening = 3,322 queries (24.8 per app open).
 * - after: see the asserted bounds below (≈ 110 queries / ~15 awake minutes per idle day; ≈ 7.5 queries per open).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AWAKE_AFTER_QUERY_MS = 5 * MINUTE;
const CRON = 'cron-secret-0123456789abcdef';
const setupPrisma = createTestPrisma();

interface QueryLog {
  times: number[];
  start(): void;
  stop(): { queries: number; awakeMinutes: number };
}

/** Counts the app's queries (its own PrismaClient) at the simulated time they were sent. */
function countingPrisma(clock: () => number): { prisma: PrismaClient; log: QueryLog } {
  const prisma = new PrismaClient({
    datasourceUrl: TEST_DATABASE_URL,
    log: [{ emit: 'event', level: 'query' }],
  });
  let on = false;
  const log: QueryLog = {
    times: [],
    start() {
      log.times = [];
      on = true;
    },
    stop() {
      on = false;
      return { queries: log.times.length, awakeMinutes: awakeMinutes(log.times) };
    },
  };
  prisma.$on('query', (e) => {
    // Transaction bookkeeping (BEGIN/COMMIT) rides on the statements around it.
    if (!on || /^(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)/i.test(e.query.trim())) return;
    log.times.push(clock());
  });
  return { prisma, log };
}

export function awakeMinutes(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let total = 0;
  let until = -Infinity;
  for (const t of sorted) {
    const end = t + AWAKE_AFTER_QUERY_MS;
    total += end - Math.max(t, until) > 0 ? end - Math.max(t, until) : 0;
    until = Math.max(until, end);
  }
  return Math.round(total / MINUTE);
}

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let counting: { prisma: PrismaClient; log: QueryLog };
let fakes: ReturnType<typeof fakeIntegrations>;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(setupPrisma);
});
afterEach(async () => {
  await app.close();
  await counting.prisma.$disconnect();
});
afterAll(async () => {
  await setupPrisma.$disconnect();
});

async function boot(start: string): Promise<void> {
  fakes = fakeIntegrations();
  const files = new Map<string, { contentType: string }>([
    ['https://cdn.ig.test/p.jpg', { contentType: 'image/jpeg' }],
    ['https://cdn.ig.test/s.jpg', { contentType: 'image/jpeg' }],
  ]);
  const holder: { clock: TestClock | null } = { clock: null };
  counting = countingPrisma(() => holder.clock?.now().getTime() ?? 0);
  ({ app, fpl, clock } = await buildTestApp(counting.prisma, {
    integrations: fakes.factories,
    push: new FakePushProvider(),
    media: new MemoryMediaStore(),
    fetch: fakeMediaFetch(files).fetch,
    config: { cronSecret: CRON, keepAlive: { quietHours: [2, 7] } },
  }));
  holder.clock = clock;
  clock.advance(Date.parse(start) - clock.now().getTime());

  // Between deadlines: GW11 finished + official, GW12's deadline 2026-10-31 10:00Z, nothing live.
  fpl.bootstrap = { ...makeBootstrap(11, 12), events: makeEvents(11, 11) };
  fpl.fixtures = [makeFixture(100, 11, 'finished')];
  fpl.leagues.set(314, { id: 314, name: 'Fantasyonerim League' });
  const token = await adminToken(app, setupPrisma);
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/admin/settings',
    headers: bearer(token),
    payload: {
      leagueId: 314,
      deadlineReminderMinutes: [1440, 120],
      socials: { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null },
    },
  });
  expect(res.statusCode).toBe(200);
  const ig = {
    enabled: true,
    settings: { igUserId: '1784', username: 'fantasyonerimfpl', pageId: '99' },
    secretsEnc: encryptSecrets(devSecretsKey(), { accessToken: 'page-token' }),
  };
  await setupPrisma.integrationConfig.upsert({
    where: { id: 'instagram' },
    update: ig,
    create: { id: 'instagram', ...ig },
  });
  const x = {
    enabled: true,
    settings: { username: 'fantasyonerim', userId: '4242' },
    secretsEnc: encryptSecrets(devSecretsKey(), { bearerToken: 'bt' }),
  };
  await setupPrisma.integrationConfig.upsert({ where: { id: 'x' }, update: x, create: { id: 'x', ...x } });

  const now = clock.now().getTime();
  // First polls see content; afterwards the upstream never changes (RSS / YouTube answer 304, Instagram and X
  // return the same items every time — they have no conditional GET).
  fakes.podcast.next = result(
    [episode(1, new Date(now - 72 * HOUR)), episode(2, new Date(now - 30 * HOUR))],
    {
      cursor: 'etag-1',
    },
  );
  fakes.youtube.next = result([], { cursor: 'yt-etag', notModified: false });
  fakes.igPosts.next = result([igPost('p', new Date(now - 20 * HOUR), ['https://cdn.ig.test/p.jpg'])]);
  fakes.igStories.next = result([igStory('s', new Date(now - 2 * HOUR), 'https://cdn.ig.test/s.jpg')]);
  fakes.x.next = result([], { cursor: '1000' });
}

/** The production schedule for `ms`: scheduler every 30 s, cron tick + /health every 5 min, `extra` per step. */
async function simulate(ms: number, extra?: (at: number) => Promise<void>): Promise<void> {
  const end = clock.now().getTime() + ms;
  let step = 0;
  while (clock.now().getTime() < end) {
    clock.advance(30_000);
    step += 1;
    await app.jobs.runDue();
    if (step % 10 === 0) {
      await app.inject({ method: 'GET', url: '/health' });
      await app.inject({ method: 'POST', url: '/internal/jobs/tick', headers: { 'x-cron-secret': CRON } });
    }
    if (extra) await extra(clock.now().getTime());
  }
  // Fire-and-forget statements (old keep-alive) land on the query log asynchronously.
  await new Promise((r) => setTimeout(r, 50));
}

function steadyUpstream(): void {
  fakes.podcast.next = result([], { cursor: 'etag-1', notModified: true });
  fakes.youtube.next = result([], { cursor: 'yt-etag', notModified: true });
}

describe('keeping Neon asleep', () => {
  it('24 h of an idle app (no users, no upstream changes) barely touches the database', async () => {
    // 2026-10-26 00:00Z = 02:00 in Israel.
    await boot('2026-10-26T00:00:00.000Z');
    for (const n of [1, 2]) {
      fpl.picks.set(`${600 + n}:11`, makePicks(600 + n, 11, 1));
      const user = await registerUser(app, fpl, 600 + n);
      await subscribe(app, user.token, `https://push.test/${n}`);
    }
    // Warm-up: first syncs, roundup build, GW summary push, first fingerprints.
    await simulate(2 * HOUR);
    steadyUpstream();
    await simulate(HOUR);

    counting.log.start();
    await simulate(24 * HOUR);
    const idle = counting.log.stop();
    console.warn(`[db-idle] 24 h idle: ${idle.queries} queries, ~${idle.awakeMinutes} awake minutes`);
    // Before: 15,668 queries, ~1,195 awake minutes.
    expect(idle.queries).toBeLessThan(250);
    expect(idle.awakeMinutes).toBeLessThanOrEqual(30);
    // The app's own tracker sees the same activity (it is what the hourly log line reports).
    expect(app.db.snapshot().queries).toBeGreaterThan(0);
  }, 600_000);

  it('a busy evening: 100 users opening the app over 2 h', async () => {
    // 2026-10-26 17:00Z = 19:00 in Israel.
    await boot('2026-10-26T15:00:00.000Z');
    const users: { token: string }[] = [];
    for (let n = 0; n < 100; n += 1) users.push(await registerUser(app, fpl, 700 + n));
    await simulate(2 * HOUR);
    steadyUpstream();
    await simulate(HOUR);
    // A new process: no warm session cache (users open the app after a deploy / restart worst case is similar).
    const opens = users.flatMap((u, i) => [
      { at: clock.now().getTime() + i * 72_000, token: u.token },
      ...(i % 3 === 0 ? [{ at: clock.now().getTime() + i * 72_000 + 40 * MINUTE, token: u.token }] : []),
    ]);
    opens.sort((a, b) => a.at - b.at);
    let next = 0;
    counting.log.start();
    await simulate(2 * HOUR, async (now) => {
      while (next < opens.length && (opens[next]?.at ?? Infinity) <= now) {
        const open = opens[next];
        next += 1;
        if (open === undefined) continue;
        for (const url of [
          '/v1/config',
          '/v1/me',
          '/v1/news',
          '/v1/news/stories',
          '/v1/fpl/bootstrap',
          '/v1/league/standings',
          '/v1/captain-battle',
          '/v1/community/posts',
        ]) {
          await app.inject({ method: 'GET', url, headers: bearer(open.token) });
        }
      }
    });
    const busy = counting.log.stop();
    console.warn(
      `[db-idle] busy evening (100 users, ${opens.length} app opens, 2 h): ${busy.queries} queries ` +
        `(${(busy.queries / opens.length).toFixed(1)} per open), ~${busy.awakeMinutes} awake minutes`,
    );
    // Before: 24.8 queries per app open.
    expect(busy.queries / opens.length).toBeLessThan(10);
  }, 600_000);
});
