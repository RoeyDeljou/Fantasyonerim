import { CaptainBattleSchema, CommunityPageSchema, MeSchema } from '@fant/shared';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_BATCH_MAX } from '../src/auth/session.js';
import { makeFixtureDetail, makePicks, type FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  TEST_DATABASE_URL,
} from './helpers.js';

const setup = createTestPrisma();
/** Every query this app runs, so session lookups can be counted. */
let queries: string[] = [];
const counting = new PrismaClient({
  datasourceUrl: TEST_DATABASE_URL,
  log: [{ emit: 'event', level: 'query' }],
});
counting.$on('query', (e) => queries.push(e.query));
const sessionReads = () => queries.filter((q) => /^SELECT .*FROM "public"\."Session"/s.test(q)).length;

let app: FastifyInstance;
let fpl: FakeFplService;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(setup);
  ({ app, fpl } = await buildTestApp(counting));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await counting.$disconnect();
  await setup.$disconnect();
});

/** A fresh app: same database, empty session cache (as after a deploy, or for a token not seen yet). */
async function restart(): Promise<void> {
  await app.close();
  ({ app, fpl } = await buildTestApp(counting, { fpl }));
}

const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, headers: token === undefined ? {} : bearer(token) });

async function configureLeague(): Promise<void> {
  fpl.leagues.set(314, { id: 314, name: 'Fantasyonerim League' });
  const token = await adminToken(app, setup);
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
}

describe('A. public routes never resolve the session', () => {
  it('a signed-in app open makes no session query for config, bootstrap, fixtures, news, league, match sheet, FPL', async () => {
    await configureLeague();
    fpl.fixtureDetails.set(100, makeFixtureDetail(100));
    fpl.addEntry(777);
    fpl.picks.set('777:9', makePicks(777, 9, 1, 2));
    const fan = await registerUser(app, fpl, 501);
    await restart(); // the fan's session is not cached
    queries = [];
    const publicRoutes = [
      '/v1/config',
      '/v1/fpl/bootstrap',
      '/v1/fpl/fixtures?event=9',
      '/v1/fpl/fixtures/100',
      '/v1/fpl/entries/777',
      '/v1/fpl/entries/777/picks?event=9',
      '/v1/fpl/entries/777/live?event=9',
      '/v1/news',
      '/v1/news/stories',
      '/v1/news/filters',
      '/v1/league/standings',
      '/v1/league/live',
      '/health',
    ];
    for (const url of publicRoutes) {
      expect((await get(url, fan.token)).statusCode, url).toBe(200);
    }
    expect(sessionReads()).toBe(0);
    // A route that needs the user resolves it (once), and the rest of the app open then reuses it.
    expect((await get('/v1/me', fan.token)).statusCode).toBe(200);
    expect(sessionReads()).toBe(1);
    await get('/v1/config', fan.token);
    await get('/v1/me', fan.token);
    expect(sessionReads()).toBe(1);
  });

  it("community read and the captain battle still know the viewer (likedByMe, mine, the 'me' row)", async () => {
    fpl.playerPoints.set(1, 6).set(2, 13);
    fpl.addEntry(777);
    fpl.picks.set('777:9', makePicks(777, 9, 1, 2));
    const admin = await adminToken(app, setup);
    const battle = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(admin),
      payload: { event: 9, entries: [{ label: 'Dor', source: 'entry', entryId: 777, kind: 'custom' }] },
    });
    expect(battle.statusCode).toBe(200);
    const fan = await registerUser(app, fpl, 502);
    fpl.picks.set('502:9', makePicks(502, 9, 2, 3));
    const post = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: bearer(fan.token),
      payload: { text: 'mine' },
    });
    const postId = (post.json() as { id: string }).id;
    await app.inject({
      method: 'PUT',
      url: `/v1/community/posts/${postId}/like`,
      headers: bearer(fan.token),
    });
    await restart();
    queries = [];
    const feed = CommunityPageSchema.parse((await get('/v1/community/posts', fan.token)).json());
    expect(feed.items[0]).toMatchObject({ id: postId, mine: true, likedByMe: true });
    const forFan = CaptainBattleSchema.parse((await get('/v1/captain-battle', fan.token)).json());
    expect(forFan.rows.map((r) => r.kind)).toEqual(['mine', 'custom']);
    expect(sessionReads()).toBe(1); // resolved once, through the batched + cached path
    const anon = CaptainBattleSchema.parse((await get('/v1/captain-battle')).json());
    expect(anon.rows.map((r) => r.kind)).toEqual(['custom']);
  });
});

describe('B. coalesced first-time session lookups', () => {
  it(`N concurrent new tokens → one query (${SESSION_BATCH_MAX} per batch); the same token twice → one lookup`, async () => {
    const fans = [];
    for (let i = 0; i < 20; i += 1) fans.push(await registerUser(app, fpl, 600 + i));
    await restart();
    queries = [];
    const res = await Promise.all([...fans, ...fans].map((f) => get('/v1/me', f.token)));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    expect(res.slice(0, 20).map((r) => MeSchema.parse(r.json()).entryId)).toEqual(
      fans.map((f) => f.user.entryId),
    );
    expect(sessionReads()).toBe(1);

    // More than a batch: ⌈N / 50⌉ queries.
    for (let i = 20; i < 120; i += 1) fans.push(await registerUser(app, fpl, 600 + i));
    await restart();
    queries = [];
    const many = await Promise.all(fans.map((f) => get('/v1/me', f.token)));
    expect(many.every((r) => r.statusCode === 200)).toBe(true);
    expect(sessionReads()).toBe(Math.ceil(120 / SESSION_BATCH_MAX));
  });

  it('unknown, expired and valid tokens in one batch each get the right answer', async () => {
    const good = await registerUser(app, fpl, 701);
    const old = await registerUser(app, fpl, 702);
    await setup.session.updateMany({ where: { userId: old.user.id }, data: { expiresAt: new Date(0) } });
    await restart();
    queries = [];
    const [a, b, c] = await Promise.all([
      get('/v1/me', good.token),
      get('/v1/me', old.token),
      get('/v1/me', 'nope'),
    ]);
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 401, 401]);
    expect(sessionReads()).toBe(1);
    expect(await setup.session.count({ where: { userId: old.user.id } })).toBe(0); // expired → deleted
  });
});

describe('invalidation stays immediate; writes and admin re-check the database', () => {
  it('logout, ban and account deletion apply on the very next request', async () => {
    const fan = await registerUser(app, fpl, 801);
    expect((await get('/v1/me', fan.token)).statusCode).toBe(200); // cached now
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(fan.token) });
    expect(logout.statusCode).toBe(204);
    expect((await get('/v1/me', fan.token)).statusCode).toBe(401);

    const banned = await registerUser(app, fpl, 802);
    expect(MeSchema.parse((await get('/v1/me', banned.token)).json()).canPost).toBe(true);
    const admin = await adminToken(app, setup);
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${banned.user.id}/ban`,
      headers: bearer(admin),
      payload: { reason: 'spam' },
    });
    expect(MeSchema.parse((await get('/v1/me', banned.token)).json()).canPost).toBe(false);

    const gone = await registerUser(app, fpl, 803);
    expect((await get('/v1/me', gone.token)).statusCode).toBe(200);
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(gone.token),
      payload: { confirm: 'DELETE' },
    });
    expect(del.statusCode).toBe(204);
    expect((await get('/v1/me', gone.token)).statusCode).toBe(401);
  });

  it('a session removed behind the API: writes see it at once; an admin demoted behind the API loses admin at once', async () => {
    const fan = await registerUser(app, fpl, 804);
    expect((await get('/v1/me', fan.token)).statusCode).toBe(200);
    await setup.session.deleteMany({ where: { userId: fan.user.id } });
    const write = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(fan.token),
      payload: { name: 'New' },
    });
    expect(write.statusCode).toBe(401);

    const admin = await adminToken(app, setup, 'temp-admin');
    expect((await get('/v1/admin/settings', admin)).statusCode).toBe(200);
    const me = MeSchema.parse((await get('/v1/me', admin)).json());
    await setup.user.update({ where: { id: me.id }, data: { role: 'USER' } });
    expect((await get('/v1/admin/settings', admin)).statusCode).toBe(403);
  });
});
