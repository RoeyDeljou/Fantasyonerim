import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationListSchema } from '@fant/shared';
import { encryptSecrets } from '../src/integrations/store.js';
import { JobScheduler, TICK_ERROR_LOG_EVERY_MS } from '../src/jobs/runner.js';
import { devSecretsKey } from '../src/secrets.js';
import {
  FakePushProvider,
  MemoryMediaStore,
  episode,
  fakeIntegrations,
  fakeMediaFetch,
  igPost,
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
  type TestClock,
} from './helpers.js';

/**
 * Keeping Neon asleep: job ticks with nothing to do send no query; content jobs touch the database only when the
 * upstream changed; time-driven jobs only around their action times. `app.db` counts the app's own queries.
 */

const prisma = createTestPrisma();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CRON = 'cron-secret-0123456789abcdef';
// makeEvents: GW n's deadline is 2026-08-15T10:00Z + (n-1) weeks. GW12 = Oct 31 10:00Z.
const GW12_DEADLINE = Date.parse('2026-10-31T10:00:00.000Z');

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;
let fakes: ReturnType<typeof fakeIntegrations>;
const files = new Map<string, { contentType: string }>([
  ['https://cdn.ig.test/p.jpg', { contentType: 'image/jpeg' }],
  ['https://cdn.ig.test/q.jpg', { contentType: 'image/jpeg' }],
]);

async function boot() {
  fakes = fakeIntegrations();
  push = new FakePushProvider();
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    integrations: fakes.factories,
    push,
    media: new MemoryMediaStore(),
    fetch: fakeMediaFetch(files).fetch,
    config: { cronSecret: CRON, vapidPublicKey: 'BKEY' },
  }));
  // Oct 28 12:00Z: GW11 finished + official, GW12 next; nothing live.
  setNow(Date.parse('2026-10-28T12:00:00.000Z'));
  fpl.bootstrap = { ...makeBootstrap(11, 12), events: makeEvents(11, 11) };
  fpl.fixtures = [makeFixture(100, 11, 'finished')];
  fakes.podcast.next = result([episode(1, new Date(clock.now().getTime() - 30 * HOUR))], {
    cursor: 'etag-1',
  });
}

function setNow(ms: number) {
  clock.advance(ms - clock.now().getTime());
}

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  await boot();
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const queries = () => app.db.snapshot().queries;

/** A registered fan with a push device and GW11 picks (so the GW summary job has nothing to retry). */
async function fan(entryId: number) {
  fpl.picks.set(`${entryId}:11`, makePicks(entryId, 11, 1));
  const user = await registerUser(app, fpl, entryId);
  await subscribe(app, user.token, `https://push.test/${entryId}`);
  return user;
}

/** Scheduler ticks every 30 s for `ms`; returns how many queries the app sent meanwhile. */
async function ticks(ms: number, each?: () => Promise<void>): Promise<number> {
  const before = queries();
  const end = clock.now().getTime() + ms;
  while (clock.now().getTime() < end) {
    clock.advance(30_000);
    await app.jobs.runDue();
    if (each) await each();
  }
  return queries() - before;
}

async function connectInstagram() {
  const data = {
    enabled: true,
    settings: { igUserId: '1784', username: 'fantasyonerimfpl', pageId: '99' },
    secretsEnc: encryptSecrets(devSecretsKey(), { accessToken: 'page-token' }),
  };
  await prisma.integrationConfig.upsert({
    where: { id: 'instagram' },
    update: data,
    create: { id: 'instagram', ...data },
  });
}

describe('job runner: zero-query idle ticks', () => {
  it('after the first load, a tick where nothing is due (or nothing changed) sends no query', async () => {
    await app.jobs.runDue(); // boot: loads the leases, first syncs
    await ticks(10 * MINUTE); // first DB-free checks seed their fingerprints
    fakes.podcast.next = result([], { cursor: 'etag-1', notModified: true });
    expect(await app.jobs.runDue()).toEqual([]); // nothing due right after a tick
    expect(await ticks(2 * HOUR)).toBe(0);
    // Upstream was polled all along (DB-free): podcast every 5 min, YouTube every 10.
    expect(fakes.podcast.cursors.length).toBeGreaterThan(24);
  });

  it('the cron tick endpoint takes the same path: no query when nothing changed', async () => {
    const tick = () =>
      app.inject({ method: 'POST', url: '/internal/jobs/tick', headers: { 'x-cron-secret': CRON } });
    expect((await tick()).statusCode).toBe(200);
    await ticks(10 * MINUTE);
    fakes.podcast.next = result([], { cursor: 'etag-1', notModified: true });
    const before = queries();
    for (let i = 0; i < 12; i += 1) {
      clock.advance(5 * MINUTE);
      const res = await tick();
      expect(res.statusCode).toBe(200);
      // DB-free checks still count as runs.
      if (i % 2 === 1) expect(res.json().ran).toContain('podcast');
    }
    expect(queries() - before).toBe(0);
  });

  it('reset() makes a job due at once (memory too); "sync now" always runs for real', async () => {
    await app.jobs.runDue();
    await ticks(10 * MINUTE);
    const polls = fakes.podcast.cursors.length;
    await app.jobs.reset('podcast');
    expect(await app.jobs.runDue()).toEqual(['podcast']);
    expect(fakes.podcast.cursors.length).toBe(polls + 1);
    const before = queries();
    expect(await app.jobs.run('podcast', { force: true })).toBe('ok');
    expect(queries()).toBeGreaterThan(before);
  });

  it('a run that finds the lease taken by another instance adopts its lastRunAt and state', async () => {
    await app.jobs.run('podcast', { force: true }); // our first sync
    const other = await buildTestApp(prisma, { integrations: fakes.factories, clock, fpl });
    try {
      // A new episode, imported by the other instance first: our plan sees "new" content, but the lease row says
      // it just ran → not due, and we adopt its state.
      fakes.podcast.next = result(
        [episode(1, new Date(clock.now().getTime() - 30 * HOUR)), episode(2, clock.now())],
        { cursor: 'etag-2' },
      );
      clock.advance(5 * MINUTE);
      await other.app.jobs.run('podcast', { force: true });
      expect(await app.jobs.run('podcast')).toBe('not_due');
      // …and now knows the saved fingerprint: the next unchanged poll is DB-free.
      clock.advance(5 * MINUTE);
      const before = queries();
      expect(await app.jobs.run('podcast')).toBe('ok');
      expect(queries()).toBe(before);
    } finally {
      await other.app.close();
    }
  });
});

describe('content jobs write only when the upstream changed', () => {
  it('podcast: 304s and identical feeds cost no query; a new episode is imported (and pushed) on the next poll', async () => {
    await fan(501);
    await app.jobs.run('podcast', { force: true }); // silent backfill
    await ticks(10 * MINUTE);

    // A host without conditional GET: the same feed every time.
    expect(await ticks(HOUR)).toBe(0);
    fakes.podcast.next = result([], { cursor: 'etag-1', notModified: true });
    expect(await ticks(HOUR)).toBe(0);

    fakes.podcast.next = result(
      [episode(1, new Date(clock.now().getTime() - 30 * HOUR)), episode(2, clock.now())],
      { cursor: 'etag-2' },
    );
    expect(await ticks(5 * MINUTE)).toBeGreaterThan(0);
    expect(await prisma.newsItem.count({ where: { source: 'podcast' } })).toBe(2);
    expect(push.sent.filter((s) => s.payload.tag !== 'gw-summary-11')).toHaveLength(1);
    expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'podcast_rss' } })).cursor).toBe(
      'etag-2',
    );
    // The feed fetch was not repeated by the run: one poll per 5 minutes.
    const polls = fakes.podcast.cursors.length;
    fakes.podcast.next = result([], { cursor: 'etag-2', notModified: true });
    expect(await ticks(HOUR)).toBe(0);
    expect(fakes.podcast.cursors.length - polls).toBe(12);
    expect(fakes.podcast.cursors.at(-1)).toBe('etag-2');
  });

  it('podcast: a feed failure is recorded once, not on every poll; recovery is recorded', async () => {
    await app.jobs.run('podcast', { force: true });
    await ticks(10 * MINUTE);
    fakes.podcast.error = new Error('boom');
    expect(await ticks(5 * MINUTE)).toBeGreaterThan(0);
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'podcast_rss' } });
    expect(row.lastError).toContain('boom');
    expect(await ticks(HOUR)).toBe(0);
    fakes.podcast.error = null;
    expect(await ticks(5 * MINUTE)).toBeGreaterThan(0);
    expect(
      (await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'podcast_rss' } })).lastError,
    ).toBeNull();
  });

  it('podcast: a source that fails before its first sync records the failure once, then a new error / recovery', async () => {
    fakes.podcast.error = new Error('boom');
    await app.jobs.runDue(); // boot: first sync attempt fails
    await ticks(10 * MINUTE);
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'podcast_rss' } });
    expect(row.lastError).toContain('boom');
    expect(row.initialSyncDone).toBe(false);
    // The same failure on every poll: no query (the podcast polls every 5 min).
    const polls = fakes.podcast.cursors.length;
    expect(await ticks(HOUR)).toBe(0);
    expect(fakes.podcast.cursors.length - polls).toBe(12);
    // A different error is recorded.
    fakes.podcast.error = new Error('bang');
    expect(await ticks(5 * MINUTE)).toBeGreaterThan(0);
    expect(
      (await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'podcast_rss' } })).lastError,
    ).toContain('bang');
    expect(await ticks(HOUR)).toBe(0);
    // Recovery: the first sync happens and the error clears.
    fakes.podcast.error = null;
    expect(await ticks(5 * MINUTE)).toBeGreaterThan(0);
    const after = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'podcast_rss' } });
    expect(after.lastError).toBeNull();
    expect(after.initialSyncDone).toBe(true);
    expect(await prisma.newsItem.count({ where: { source: 'podcast' } })).toBe(1);
  });

  it('instagram: the same posts every poll (rotating CDN URLs) cost no query; a new post is imported', async () => {
    await connectInstagram();
    const pAt = new Date(clock.now().getTime() - HOUR);
    fakes.igPosts.next = result([igPost('p', pAt, ['https://cdn.ig.test/p.jpg'])]);
    await app.jobs.run('instagram_posts', { force: true });
    await ticks(20 * MINUTE);
    // Same post, new signed URL: ingest would not touch the re-hosted media, so neither does the poll.
    files.set('https://cdn.ig.test/p.jpg?sig=2', { contentType: 'image/jpeg' });
    fakes.igPosts.next = result([igPost('p', pAt, ['https://cdn.ig.test/p.jpg?sig=2'])]);
    expect(await ticks(HOUR)).toBe(0);

    fakes.igPosts.next = result([
      igPost('q', clock.now(), ['https://cdn.ig.test/q.jpg']),
      igPost('p', pAt, ['https://cdn.ig.test/p.jpg?sig=2']),
    ]);
    expect(await ticks(10 * MINUTE)).toBeGreaterThan(0);
    expect(await prisma.newsItem.count({ where: { source: 'instagram_post' } })).toBe(2);
    expect(await ticks(HOUR)).toBe(0);
  });

  it('the admin console shows the in-memory last check of a DB-free poll', async () => {
    await app.jobs.run('podcast', { force: true });
    const savedAt = clock.now().toISOString();
    await ticks(10 * MINUTE);
    await ticks(30 * MINUTE);
    const token = await adminToken(app, prisma);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/integrations', headers: bearer(token) });
    const rss = IntegrationListSchema.parse(res.json()).integrations.find((i) => i.id === 'podcast_rss');
    expect(rss?.lastRunAt).not.toBe(savedAt);
    expect(Date.parse(rss?.lastRunAt ?? '')).toBeGreaterThan(clock.now().getTime() - 5 * MINUTE);
    expect(Date.parse(rss?.lastSuccessAt ?? '')).toBeGreaterThan(clock.now().getTime() - 5 * MINUTE);
  });
});

describe('time-driven jobs touch the database only around their action times', () => {
  it('community captain: DB-free before the deadline, locked within ~2 min after it, then quiet again', async () => {
    const fans = [];
    for (let i = 0; i < 3; i += 1) fans.push(await registerUser(app, fpl, 100 + i));
    for (const [i, fan] of fans.entries()) {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/community-captain',
        headers: bearer(fan.token),
        payload: { event: 12, playerId: [1, 1, 2][i] },
      });
      expect(res.statusCode).toBe(200);
    }
    setNow(GW12_DEADLINE - 30 * MINUTE);
    await app.jobs.runDue();
    await ticks(10 * MINUTE);
    expect(await ticks(19 * MINUTE)).toBe(0); // up to 1 min before the deadline
    expect(await prisma.communityCaptainResult.count()).toBe(0);

    await ticks(MINUTE + 2 * MINUTE + 30_000); // deadline + 2.5 min
    const row = await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } });
    expect(row).toMatchObject({ status: 'decided', source: 'votes', winnerPlayerId: 1 });
    expect(row.decidedAt!.getTime() - GW12_DEADLINE).toBeLessThanOrEqual(2 * MINUTE + 30_000);
    // Settled: the rest of the 24 h tally window is DB-free.
    await ticks(MINUTE);
    expect(await ticks(3 * HOUR)).toBe(0);
  });

  it('community captain: nobody voted → the admins are pushed once, then quiet', async () => {
    const token = await adminToken(app, prisma);
    const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    await prisma.pushSubscription.create({
      data: {
        endpoint: 'https://push.test/admin',
        userId: admin.id,
        p256dh: 'p256dh-key-0123456789',
        auth: 'a',
      },
    });
    expect(token).toBeTruthy();
    setNow(GW12_DEADLINE - 5 * MINUTE);
    await app.jobs.runDue();
    await ticks(8 * MINUTE);
    const row = await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } });
    expect(row.status).toBe('no_votes');
    expect(row.adminNotifiedAt).not.toBeNull();
    expect(push.sent.filter((s) => s.endpoint === 'https://push.test/admin')).toHaveLength(1);
    await ticks(MINUTE);
    expect(await ticks(2 * HOUR)).toBe(0);
    expect(push.sent.filter((s) => s.endpoint === 'https://push.test/admin')).toHaveLength(1);
  });

  it('deadline reminders: DB-free until a reminder time is crossed, then sent once', async () => {
    await fan(777);
    // Default reminder offsets include 2 h before the deadline.
    setNow(GW12_DEADLINE - 3 * HOUR);
    await app.jobs.runDue();
    await ticks(10 * MINUTE);
    expect(await ticks(45 * MINUTE)).toBe(0);
    expect(push.sent.filter((s) => s.payload.tag === 'deadline-12')).toHaveLength(0);
    await ticks(10 * MINUTE); // crosses deadline − 2 h
    expect(push.sent.filter((s) => s.payload.tag === 'deadline-12')).toHaveLength(1);
    await ticks(MINUTE);
    expect(await ticks(40 * MINUTE)).toBe(0);
    expect(push.sent.filter((s) => s.payload.tag === 'deadline-12')).toHaveLength(1);
  });

  it('live alerts: DB-free with no live fixture; run while a fixture is live (plus one final pass)', async () => {
    await app.jobs.runDue();
    await ticks(10 * MINUTE);
    expect(await ticks(HOUR)).toBe(0);
    fpl.fixtures = [makeFixture(100, 11, 'live')];
    expect(await ticks(4 * MINUTE)).toBeGreaterThan(0);
    fpl.fixtures = [makeFixture(100, 11, 'finished')];
    await ticks(4 * MINUTE); // the final pass
    await ticks(MINUTE);
    expect(await ticks(HOUR)).toBe(0);
  });

  it('live alerts keep a 2-minute cadence while live (their own queries never make them run early)', async () => {
    await app.jobs.runDue();
    await ticks(10 * MINUTE);
    fpl.fixtures = [makeFixture(100, 11, 'live')];
    const runs: number[] = [];
    const end = clock.now().getTime() + HOUR;
    while (clock.now().getTime() < end) {
      clock.advance(30_000);
      if ((await app.jobs.runDue()).includes('live_alerts')) runs.push(clock.now().getTime());
    }
    expect(runs).toHaveLength(30);
    for (let i = 1; i < runs.length; i += 1) expect((runs[i] ?? 0) - (runs[i - 1] ?? 0)).toBe(2 * MINUTE);
  });

  it('GW summary: failed users are retried with backoff capped at 2 h', async () => {
    // A fan with a push device but no GW11 picks: their summary fails every time.
    const user = await registerUser(app, fpl, 601);
    await subscribe(app, user.token, 'https://push.test/601');
    const runs: number[] = [];
    const end = clock.now().getTime() + 12 * HOUR;
    while (clock.now().getTime() < end) {
      if ((await app.jobs.runDue()).includes('gameweek_summary')) {
        const lease = await prisma.jobLease.findUnique({ where: { name: 'gameweek_summary' } });
        const at = lease?.lastRunAt?.getTime();
        if (at !== undefined && at !== runs.at(-1)) runs.push(at);
      }
      clock.advance(30_000);
    }
    const gaps = runs.slice(1).map((t, i) => (t - (runs[i] ?? 0)) / MINUTE);
    expect(gaps.slice(0, 2)).toEqual([30, 60]);
    expect(gaps.length).toBeGreaterThanOrEqual(6);
    for (const gap of gaps.slice(2)) expect(gap).toBe(120);
  });

  it('roundup, GW summary, cleanup, image back-fill: an idle afternoon costs no query', async () => {
    await app.jobs.runDue();
    await ticks(10 * MINUTE);
    expect(await ticks(HOUR)).toBe(0);
  });
});

describe('job scheduler', () => {
  it('logs tick failures (e.g. database unreachable), once per distinct message per 10 min', async () => {
    let now = 0;
    let error = new Error('db unreachable');
    const logged: unknown[] = [];
    const scheduler = new JobScheduler(
      {
        runDue: () => Promise.reject(error),
      },
      { error: (obj: unknown) => void logged.push(obj) },
      30_000,
      () => now,
    );
    for (let i = 0; i < 20; i += 1) {
      await scheduler.tick();
      now += 30_000;
    }
    expect(logged).toHaveLength(1);
    error = new Error('other failure');
    await scheduler.tick();
    expect(logged).toHaveLength(2);
    error = new Error('db unreachable');
    now = TICK_ERROR_LOG_EVERY_MS + 1;
    await scheduler.tick();
    expect(logged).toHaveLength(3);
  });
});
