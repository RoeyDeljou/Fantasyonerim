import { ApiErrorSchema, LeagueStandingsSchema, LiveLeagueSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeBootstrap, upstreamDown, type FakeFplService } from './fakeFpl.js';
import { adminToken, bearer, buildTestApp, createTestPrisma, migrateTestDb, resetDb } from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl } = await buildTestApp(prisma));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function configureLeague(): Promise<void> {
  fpl.leagues.set(314, { id: 314, name: 'Fantasyonerim League' });
  const token = await adminToken(app, prisma);
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

describe('league routes', () => {
  it.each(['/v1/league/standings', '/v1/league/live'])(
    '%s 404s with a clear message when unconfigured',
    async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      const body = ApiErrorSchema.parse(res.json());
      expect(body.error.code).toBe('not_found');
      expect(body.error.message).toMatch(/no league/i);
    },
  );

  it('serves standings (paged) once the admin sets the league', async () => {
    await configureLeague();
    const res = await app.inject({ method: 'GET', url: '/v1/league/standings?page=2' });
    expect(res.statusCode).toBe(200);
    const body = LeagueStandingsSchema.parse(res.json());
    expect(body.league).toEqual({ id: 314, name: 'Fantasyonerim League' });
    expect(body.page).toBe(2);
    expect(fpl.calls).toContain('getLeagueStandings:314:2');

    const def = LeagueStandingsSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/league/standings' })).json(),
    );
    expect(def.page).toBe(1);
  });

  it('serves the live table for the current GW (next GW pre-season)', async () => {
    await configureLeague();
    const res = await app.inject({ method: 'GET', url: '/v1/league/live' });
    expect(res.statusCode).toBe(200);
    expect(LiveLeagueSchema.parse(res.json()).event).toBe(9);
    expect(fpl.calls).toContain('getLiveLeague:314:9:1');

    fpl.bootstrap = makeBootstrap(null, 1);
    const pre = LiveLeagueSchema.parse((await app.inject({ method: 'GET', url: '/v1/league/live' })).json());
    expect(pre.event).toBe(1);
  });

  it('400s on a bad page and 503s when FPL is down', async () => {
    await configureLeague();
    expect((await app.inject({ method: 'GET', url: '/v1/league/standings?page=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/league/standings?page=x' })).statusCode).toBe(400);
    fpl.failAll = upstreamDown();
    const res = await app.inject({ method: 'GET', url: '/v1/league/live' });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('upstream_unavailable');
  });
});
