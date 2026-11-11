import { AdminCommunityCaptainSchema, CommunityCaptainStateSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeBootstrap, makeEvents, type FakeFplService } from './fakeFpl.js';
import { FakePushProvider, subscribe } from './fakes.js';
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

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;

// Test GW calendar (makeEvents): GW n's deadline is 2026-08-15T10:00Z + (n-1) weeks. GW12 = Oct 31.
const GW12_DEADLINE = Date.parse('2026-10-31T10:00:00.000Z');
const MIN = 60_000;

function setSeason(now: number, finishedUpTo: number) {
  clock.advance(now - clock.now().getTime());
  const current = finishedUpTo + 1;
  fpl.bootstrap =
    finishedUpTo >= 38
      ? { ...makeBootstrap(null, null), events: makeEvents(null, 38) }
      : { ...makeBootstrap(current, current + 1), events: makeEvents(current, finishedUpTo) };
}

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  push = new FakePushProvider();
  ({ app, fpl, clock } = await buildTestApp(prisma, { push, config: { vapidPublicKey: 'BKEY' } }));
  // Oct 28: GW11 is finished, GW12 (deadline Oct 31) is the one being voted for.
  setSeason(Date.parse('2026-10-28T12:00:00.000Z'), 11);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const getState = async (token?: string) => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/community-captain',
    ...(token === undefined ? {} : { headers: bearer(token) }),
  });
  return { res, state: res.statusCode === 200 ? CommunityCaptainStateSchema.parse(res.json()) : null };
};
const vote = (token: string | null, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/v1/community-captain',
    ...(token === null ? {} : { headers: bearer(token) }),
    payload: payload as object,
  });
const adminGet = async (token: string, query = '') => {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/admin/community-captain${query}`,
    headers: bearer(token),
  });
  expect(res.statusCode, res.body).toBe(200);
  return AdminCommunityCaptainSchema.parse(res.json());
};
const resolve = (token: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/admin/community-captain/resolve',
    ...(token === null ? {} : { headers: bearer(token) }),
    payload: payload as object,
  });
const runJob = () => app.jobs.run('community_captain', { force: true });

async function fans(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await registerUser(app, fpl, 100 + i));
  return out;
}
async function castVotes(picks: number[]) {
  const users = await fans(picks.length);
  for (const [i, u] of users.entries()) {
    expect((await vote(u.token, { event: 12, playerId: picks[i] })).statusCode).toBe(200);
  }
  return users;
}
/** Moves the clock past GW12's deadline (GW13 becomes the target). */
const pastDeadline = (minutes = 5) => setSeason(GW12_DEADLINE + minutes * MIN, 11);

const communityPlayer = async (event: number) => {
  const battle = await prisma.captainBattle.findUnique({
    where: { event },
    include: { entries: { orderBy: { order: 'asc' } } },
  });
  return battle?.entries.find((e) => e.kind === 'COMMUNITY')?.playerId ?? null;
};

describe('window and target GW', () => {
  it('targets the first GW whose deadline is ahead; open once the previous GW is finished', async () => {
    const { state } = await getState();
    expect(state).toMatchObject({
      event: 12,
      status: 'open',
      opensAfterEvent: 11,
      deadline: '2026-10-31T10:00:00.000Z',
      voters: 0,
      myPick: null,
      result: null,
    });
  });

  it('shows the GW in progress as locked, with its pending result, voters and myPick; PUT to it is rejected', async () => {
    const [fan] = await fans(1);
    await vote(fan!.token, { event: 12, playerId: 2 });
    pastDeadline();
    const guest = (await getState()).state;
    expect(guest).toMatchObject({ event: 12, status: 'locked', voters: 1, myPick: null });
    expect(guest?.result).toMatchObject({ status: 'pending', winnerPlayerId: null });
    expect((await getState(fan!.token)).state).toMatchObject({ event: 12, status: 'locked', myPick: 2 });
    const closed = await vote(fan!.token, { event: 12, playerId: 3 });
    expect(closed.statusCode).toBe(409);
    // The next GW is not open while this one runs.
    const next = await vote(fan!.token, { event: 13, playerId: 3 });
    expect(next.statusCode).toBe(409);
    expect(next.json().error.message).toMatch(/opens when gameweek 12 ends/);
    await runJob();
    expect((await getState(fan!.token)).state?.result).toMatchObject({
      status: 'decided',
      source: 'votes',
      winnerPlayerId: 2,
      top: [{ playerId: 2, votes: 1 }],
    });
  });

  it('hands over to the next GW when the locked one finishes', async () => {
    pastDeadline();
    expect((await getState()).state).toMatchObject({ event: 12, status: 'locked' });
    setSeason(GW12_DEADLINE + 2 * 24 * 60 * MIN, 12);
    expect((await getState()).state).toMatchObject({
      event: 13,
      status: 'open',
      opensAfterEvent: 12,
      result: null,
    });
  });

  it('the previous GW in progress is shown locked before the next one opens', async () => {
    setSeason(Date.parse('2026-10-28T12:00:00.000Z'), 10);
    expect((await getState()).state).toMatchObject({ event: 11, status: 'locked' });
    const [fan] = await fans(1);
    const res = await vote(fan!.token, { event: 12, playerId: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/opens when gameweek 11 ends/);
  });

  it('GW1 is open from the start of the season', async () => {
    setSeason(Date.parse('2026-08-01T00:00:00.000Z'), 0);
    expect((await getState()).state).toMatchObject({ event: 1, status: 'open', opensAfterEvent: null });
  });

  it('is locked with no event once the season is over', async () => {
    setSeason(Date.parse('2027-06-01T00:00:00.000Z'), 38);
    expect((await getState()).state).toMatchObject({ event: null, status: 'locked', deadline: null });
  });
});

describe('PUT /v1/community-captain', () => {
  it('upserts: a fan changes the pick freely, one vote per fan', async () => {
    const [a, b] = await fans(2);
    const first = await vote(a!.token, { event: 12, playerId: 1 });
    expect(first.statusCode).toBe(200);
    expect(CommunityCaptainStateSchema.parse(first.json())).toMatchObject({ myPick: 1, voters: 1 });
    const changed = await vote(a!.token, { event: 12, playerId: 3 });
    expect(CommunityCaptainStateSchema.parse(changed.json())).toMatchObject({ myPick: 3, voters: 1 });
    await vote(b!.token, { event: 12, playerId: 3 });
    expect(await prisma.communityCaptainVote.count()).toBe(2);
    expect(first.headers['cache-control']).toBe('private, no-cache');
  });

  it('rejects: signed out 401, bad body 400, unknown player 400, wrong GW 400, past GW 409, closed at the deadline', async () => {
    const [fan] = await fans(1);
    expect((await vote(null, { event: 12, playerId: 1 })).statusCode).toBe(401);
    expect((await vote(fan!.token, { event: 12 })).statusCode).toBe(400);
    expect((await vote(fan!.token, { event: 99, playerId: 1 })).statusCode).toBe(400);
    expect((await vote(fan!.token, { event: 12, playerId: 'x' })).statusCode).toBe(400);
    const unknown = await vote(fan!.token, { event: 12, playerId: 999 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toMatch(/Unknown player/);
    const wrong = await vote(fan!.token, { event: 14, playerId: 1 });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/only vote for gameweek 12/);
    const old = await vote(fan!.token, { event: 11, playerId: 1 });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.message).toMatch(/deadline has passed/);
    // Exactly at the deadline: closed.
    setSeason(GW12_DEADLINE, 11);
    const atDeadline = await vote(fan!.token, { event: 12, playerId: 1 });
    expect(atDeadline.statusCode).toBe(409);
    expect(atDeadline.json().error.message).toMatch(/closed/);
    expect(await prisma.communityCaptainVote.count()).toBe(0);
  });

  it('a vote one second before the deadline still counts', async () => {
    const [fan] = await fans(1);
    setSeason(GW12_DEADLINE - 1000, 11);
    expect((await vote(fan!.token, { event: 12, playerId: 2 })).statusCode).toBe(200);
  });

  it('banned users get the same 403 as other community writes', async () => {
    const [fan] = await fans(1);
    await prisma.user.update({ where: { id: fan!.user.id }, data: { bannedAt: new Date() } });
    const res = await vote(fan!.token, { event: 12, playerId: 1 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('is rate limited like other community writes', async () => {
    await app.close();
    ({ app, fpl, clock } = await buildTestApp(prisma, { rateLimit: { writeMax: 2 } }));
    setSeason(Date.parse('2026-10-28T12:00:00.000Z'), 11);
    const [fan] = await fans(1);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await vote(fan!.token, { event: 12, playerId: 1 })).statusCode);
    expect(codes).toContain(429);
  });
});

describe('GET /v1/community-captain privacy and caching', () => {
  it('a guest gets a short public cache that varies by authorization; myPick is never shared', async () => {
    const [a, b] = await fans(2);
    await vote(a!.token, { event: 12, playerId: 4 });
    const guest = await getState();
    expect(guest.res.headers['cache-control']).toMatch(/^public, max-age=15/);
    expect(String(guest.res.headers['vary'])).toMatch(/authorization/);
    expect(guest.state).toMatchObject({ myPick: null, voters: 1 });

    const mine = await getState(a!.token);
    expect(mine.res.headers['cache-control']).toBe('private, no-cache');
    expect(String(mine.res.headers['vary'])).toMatch(/authorization/);
    expect(mine.state?.myPick).toBe(4);
    const other = await getState(b!.token);
    expect(other.state?.myPick).toBeNull();
    expect((await getState()).state?.myPick).toBeNull();
  });

  it('the shared part is computed once per ~15 s', async () => {
    const [a] = await fans(1);
    await getState();
    await vote(a!.token, { event: 12, playerId: 1 });
    expect((await getState()).state?.voters).toBe(0); // cached
    clock.advance(16_000);
    expect((await getState()).state?.voters).toBe(1);
  });

  it('hides the tally from fans before the lock; admins see it live', async () => {
    await castVotes([1, 1, 2]);
    const body = (await getState()).res.body;
    expect(body).not.toMatch(/"top"|"tally"/);
    expect((await getState()).state?.result).toBeNull();
    const admin = await adminToken(app, prisma);
    const view = await adminGet(admin);
    expect(view).toMatchObject({
      event: 12,
      status: 'open',
      totalVotes: 3,
      result: null,
      battlePlayerId: null,
    });
    expect(view.tally).toEqual([
      { playerId: 1, votes: 2 },
      { playerId: 2, votes: 1 },
    ]);
  });
});

describe('job community_captain', () => {
  it('a clear winner is stored and applied to the battle (created from scratch)', async () => {
    await castVotes([3, 3, 1]);
    pastDeadline();
    expect(await runJob()).toBe('ok');
    const row = await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } });
    expect(row).toMatchObject({
      status: 'decided',
      source: 'votes',
      winnerPlayerId: 3,
      totalVotes: 3,
    });
    expect(await communityPlayer(12)).toBe(3);
    const battle = await prisma.captainBattle.findUniqueOrThrow({
      where: { event: 12 },
      include: { entries: true },
    });
    expect(battle.entries.map((e) => e.kind).sort()).toEqual(['COMMUNITY', 'FPL_LAD']);
    // The live captain battle shows it.
    const live = (await app.inject({ method: 'GET', url: '/v1/captain-battle' })).json();
    expect(live.event).toBe(12);
    expect(live.rows.find((r: { kind: string }) => r.kind === 'community').playerId).toBe(3);
  });

  it('copies the latest earlier battle (labels, tags, linked teams; FPL Lad empty) when GW N has none', async () => {
    const admin = await adminToken(app, prisma);
    fpl.addEntry(555);
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(admin),
      payload: {
        event: 11,
        entries: [
          { label: 'Crowd', source: 'player', playerId: 1, kind: 'community', tag: 'vote' },
          { label: 'Lad', source: 'player', playerId: 2, kind: 'fpl_lad', tag: 'lad' },
          { label: 'Dor', source: 'entry', entryId: 555, kind: 'custom', tag: null },
          { label: 'Guest', source: 'player', playerId: 4, kind: 'custom', tag: 'guest' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    await castVotes([3]);
    pastDeadline();
    await runJob();
    const battle = await prisma.captainBattle.findUniqueOrThrow({
      where: { event: 12 },
      include: { entries: { orderBy: { order: 'asc' } } },
    });
    expect(battle.entries.map((e) => [e.label, e.kind, e.tag, e.source, e.entryId, e.playerId])).toEqual([
      ['Crowd', 'COMMUNITY', 'vote', 'PLAYER', null, 3],
      ['Lad', 'FPL_LAD', 'lad', 'PLAYER', null, null],
      ['Dor', 'CUSTOM', null, 'ENTRY', 555, null],
      ['Guest', 'CUSTOM', 'guest', 'PLAYER', null, 4],
    ]);
    // The earlier battle is untouched.
    expect(await communityPlayer(11)).toBe(1);
  });

  it('a tie: stored as tied, every admin with a subscription is notified once (deduped across re-runs)', async () => {
    await castVotes([1, 1, 2, 2, 3]);
    const a1 = await adminToken(app, prisma, 'admin');
    const a2 = await adminToken(app, prisma, 'admin2');
    await adminToken(app, prisma, 'admin3'); // no subscription
    await subscribe(app, a1, 'https://push.test/a1');
    await subscribe(app, a2, 'https://push.test/a2');
    pastDeadline();
    await runJob();
    const row = await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } });
    expect(row).toMatchObject({ status: 'tied', source: null, winnerPlayerId: null, totalVotes: 5 });
    expect(row.tiedPlayerIds).toEqual([1, 2]);
    expect(row.adminNotifiedAt).not.toBeNull();
    expect(await prisma.captainBattle.count({ where: { event: 12 } })).toBe(0);
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual(['https://push.test/a1', 'https://push.test/a2']);
    const payload = push.sent[0]!.payload;
    expect(payload.url).toBe('/admin/?card=vote');
    expect(payload.title).toMatch(/12/);
    expect(payload.body).toMatch(/Salah/);
    expect(payload.body).toMatch(/Haaland/);

    await runJob();
    await runJob();
    expect(push.sent).toHaveLength(2);
    // Even a lost "notified" stamp can't re-send: the per-admin dedupe row holds.
    await prisma.communityCaptainResult.update({ where: { event: 12 }, data: { adminNotifiedAt: null } });
    await runJob();
    expect(push.sent).toHaveLength(2);
  });

  it('no votes: stored as no_votes and the admins are notified', async () => {
    const admin = await adminToken(app, prisma);
    await subscribe(app, admin, 'https://push.test/a1');
    pastDeadline();
    await runJob();
    expect(await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } })).toMatchObject({
      status: 'no_votes',
      totalVotes: 0,
      winnerPlayerId: null,
    });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload.url).toBe('/admin/?card=vote');
    await runJob();
    expect(push.sent).toHaveLength(1);
  });

  it('does not back-fill: a deadline older than 24 h is ignored; nothing runs before the deadline', async () => {
    await castVotes([1]);
    await runJob();
    expect(await prisma.communityCaptainResult.count()).toBe(0);
    setSeason(GW12_DEADLINE + 25 * 60 * MIN, 11);
    await runJob();
    expect(await prisma.communityCaptainResult.count()).toBe(0);
  });

  it('keeps a manual community pick: result is decided with source admin and the battle is untouched', async () => {
    const admin = await adminToken(app, prisma);
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(admin),
      payload: {
        event: 12,
        entries: [{ label: 'Crowd', source: 'player', playerId: 4, kind: 'community' }],
      },
    });
    await castVotes([1, 1, 2]);
    pastDeadline();
    await runJob();
    expect(await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } })).toMatchObject({
      status: 'decided',
      source: 'admin',
      winnerPlayerId: 4,
      totalVotes: 3,
    });
    expect(await communityPlayer(12)).toBe(4);
    expect(push.sent).toHaveLength(0);
  });

  it('is idempotent: a re-run or a concurrent run does not double-apply', async () => {
    await castVotes([2, 2, 1]);
    pastDeadline();
    await Promise.all([runJob(), runJob()]);
    await runJob();
    expect(await prisma.communityCaptainResult.count()).toBe(1);
    expect(await prisma.captainBattle.count({ where: { event: 12 } })).toBe(1);
    expect(await communityPlayer(12)).toBe(2);
    // A later manual edit is not undone by another run.
    await prisma.captainBattleEntry.updateMany({ where: { kind: 'COMMUNITY' }, data: { playerId: 4 } });
    await runJob();
    expect(await communityPlayer(12)).toBe(4);
  });

  it('invalidates the hot battle cache', async () => {
    const before = await app.inject({ method: 'GET', url: '/v1/captain-battle' });
    expect(before.json().event).toBeNull();
    await castVotes([2]);
    pastDeadline();
    await runJob();
    const after = await app.inject({ method: 'GET', url: '/v1/captain-battle' });
    expect(after.json().event).toBe(12);
  });
});

describe('admin routes', () => {
  it('401 without a token, 403 for a fan, on every route', async () => {
    const [fan] = await fans(1);
    const calls: [string, string, object?][] = [
      ['GET', '/v1/admin/community-captain'],
      ['POST', '/v1/admin/community-captain/resolve', { event: 12, playerId: 1 }],
    ];
    for (const [method, url, payload] of calls) {
      const anon = await app.inject({ method: method as 'GET', url, ...(payload ? { payload } : {}) });
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
      const asFan = await app.inject({
        method: method as 'GET',
        url,
        headers: bearer(fan!.token),
        ...(payload ? { payload } : {}),
      });
      expect(asFan.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('validates: bad query/body 400, unknown GW 404, unknown player 400, too old / future GW 400', async () => {
    const admin = await adminToken(app, prisma);
    const h = { headers: bearer(admin) };
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/community-captain?event=abc', ...h })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/community-captain?event=99', ...h })).statusCode,
    ).toBe(400);
    expect((await resolve(admin, { event: 12 })).statusCode).toBe(400);
    expect((await resolve(admin, { event: 12, playerId: 999 })).statusCode).toBe(400);
    expect((await resolve(admin, { event: 5, playerId: 1 })).statusCode).toBe(400); // deadline long past
    expect((await resolve(admin, { event: 14, playerId: 1 })).statusCode).toBe(400); // not the target
    fpl.bootstrap = { ...fpl.bootstrap, events: fpl.bootstrap.events.filter((e) => e.id !== 20) };
    const missing = await app.inject({ method: 'GET', url: '/v1/admin/community-captain?event=20', ...h });
    expect(missing.statusCode).toBe(404);
  });

  it('breaks a tie: applies to the battle, source votes for a tied top player, decidedBy recorded', async () => {
    await castVotes([1, 2]);
    pastDeadline();
    await runJob();
    const admin = await adminToken(app, prisma);
    const tied = await adminGet(admin, '?event=12');
    expect(tied).toMatchObject({ status: 'locked', result: { status: 'tied', tiedPlayerIds: [1, 2] } });
    expect(tied.battlePlayerId).toBeNull();

    // Warm the hot caches, then resolve: the live battle must show it at once.
    expect((await app.inject({ method: 'GET', url: '/v1/captain-battle' })).json().event).toBeNull();
    const res = await resolve(admin, { event: 12, playerId: 2 });
    expect(res.statusCode, res.body).toBe(200);
    const view = AdminCommunityCaptainSchema.parse(res.json());
    expect(view.result).toMatchObject({ status: 'decided', source: 'votes', winnerPlayerId: 2 });
    expect(view.battlePlayerId).toBe(2);
    const row = await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } });
    expect(row.decidedById).not.toBeNull();
    const live = (await app.inject({ method: 'GET', url: '/v1/captain-battle' })).json();
    expect(live.event).toBe(12);
    expect(live.rows.find((r: { kind: string }) => r.kind === 'community').playerId).toBe(2);
  });

  it('picks by hand after no votes (source admin) and overwrites an earlier value', async () => {
    pastDeadline();
    await runJob();
    const admin = await adminToken(app, prisma);
    expect((await resolve(admin, { event: 12, playerId: 4 })).statusCode).toBe(200);
    expect(await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } })).toMatchObject({
      status: 'decided',
      source: 'admin',
      winnerPlayerId: 4,
    });
    expect(await communityPlayer(12)).toBe(4);
    const [fan] = await fans(1);
    await prisma.communityCaptainVote.create({ data: { event: 12, userId: fan!.user.id, playerId: 1 } });
    expect((await resolve(admin, { event: 12, playerId: 3 })).statusCode).toBe(200);
    expect(await communityPlayer(12)).toBe(3);
  });

  it('resolves a GW a few days after its deadline but not much later', async () => {
    const admin = await adminToken(app, prisma);
    setSeason(GW12_DEADLINE + 2 * 24 * 60 * MIN, 12);
    expect((await resolve(admin, { event: 12, playerId: 1 })).statusCode).toBe(200);
    setSeason(GW12_DEADLINE + 4 * 24 * 60 * MIN, 12);
    expect((await resolve(admin, { event: 12, playerId: 1 })).statusCode).toBe(400);
  });

  it('a pick before the deadline sets only the battle; the job then keeps it as the admin pick', async () => {
    const admin = await adminToken(app, prisma);
    expect((await resolve(admin, { event: 12, playerId: 4 })).statusCode).toBe(200);
    expect(await prisma.communityCaptainResult.count()).toBe(0);
    expect((await adminGet(admin)).battlePlayerId).toBe(4);
    await castVotes([1, 1]);
    pastDeadline();
    await runJob();
    expect(await communityPlayer(12)).toBe(4);
    expect(await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } })).toMatchObject({
      source: 'admin',
      winnerPlayerId: 4,
    });
  });
});

describe('account deletion', () => {
  it('deleting an account removes its votes', async () => {
    const [a, b] = await fans(2);
    await vote(a!.token, { event: 12, playerId: 1 });
    await vote(b!.token, { event: 12, playerId: 1 });
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(a!.token),
      payload: { confirm: 'DELETE' },
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.communityCaptainVote.findMany({ select: { userId: true } })).toEqual([
      { userId: b!.user.id },
    ]);
  });
});

describe('banned voters and late applies', () => {
  it('a banned fan’s earlier vote does not count (winner, tie, voters, admin tally)', async () => {
    const users = await castVotes([1, 2, 2]);
    // Without the ban: player 2 leads. Ban both of its voters but one: 1 vs 2 is a tie.
    await prisma.user.update({ where: { id: users[2]!.user.id }, data: { bannedAt: new Date() } });
    const admin = await adminToken(app, prisma);
    expect((await adminGet(admin)).tally).toEqual([
      { playerId: 1, votes: 1 },
      { playerId: 2, votes: 1 },
    ]);
    expect((await adminGet(admin)).totalVotes).toBe(2);
    clock.advance(16_000);
    expect((await getState()).state?.voters).toBe(2);
    pastDeadline();
    await runJob();
    expect(await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } })).toMatchObject({
      status: 'tied',
      totalVotes: 2,
    });
    // Banning the other 2-voter too leaves a clear winner.
    await prisma.communityCaptainResult.deleteMany();
    await prisma.user.update({ where: { id: users[1]!.user.id }, data: { bannedAt: new Date() } });
    await runJob();
    expect(await prisma.communityCaptainResult.findUniqueOrThrow({ where: { event: 12 } })).toMatchObject({
      status: 'decided',
      winnerPlayerId: 1,
    });
  });

  it('applying to an older GW does not change which battle is shown publicly', async () => {
    const admin = await adminToken(app, prisma);
    const save = (event: number, playerId: number) =>
      app.inject({
        method: 'PUT',
        url: '/v1/admin/captain-battle',
        headers: bearer(admin),
        payload: {
          event,
          entries: [{ label: 'Crowd', source: 'player', playerId, kind: 'community' }],
        },
      });
    // Latest saved battle is GW13; GW12 (older) has none and gets a tie-break after its deadline.
    setSeason(GW12_DEADLINE + 5 * MIN, 11);
    expect((await save(13, 4)).statusCode).toBe(200);
    expect((await resolve(admin, { event: 12, playerId: 2 })).statusCode).toBe(200);
    expect(await communityPlayer(12)).toBe(2);
    const live = (await app.inject({ method: 'GET', url: '/v1/captain-battle' })).json();
    expect(live.event).toBe(13);
    expect(live.rows.find((r: { kind: string }) => r.kind === 'community').playerId).toBe(4);
    // Same for an existing older battle being updated.
    clock.advance(MIN);
    expect((await save(12, 1)).statusCode).toBe(200);
    clock.advance(MIN);
    expect((await save(13, 4)).statusCode).toBe(200);
    expect((await resolve(admin, { event: 12, playerId: 3 })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/captain-battle' })).json().event).toBe(13);
  });
});
