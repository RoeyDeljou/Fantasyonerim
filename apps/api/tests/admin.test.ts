import {
  AdminAccountSchema,
  AdminSettingsSchema,
  ApiErrorSchema,
  CaptainBattleConfigSchema,
  PublicConfigSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { upstreamDown, type FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';

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

const SETTINGS = {
  leagueId: 314,
  deadlineReminderMinutes: [120, 1440],
  socials: {
    spotifyUrl: 'https://open.spotify.com/show/abc',
    appleUrl: null,
    instagramUrl: 'https://instagram.com/fantasyonerim',
    xUrl: null,
    whatsappUrl: null,
  },
};

const ADMIN_ROUTES = [
  { method: 'GET', url: '/v1/admin/settings' },
  { method: 'PUT', url: '/v1/admin/settings', payload: SETTINGS },
  { method: 'GET', url: '/v1/admin/captain-battle' },
  { method: 'PUT', url: '/v1/admin/captain-battle', payload: { event: 9, entries: [] } },
  { method: 'GET', url: '/v1/admin/admins' },
  {
    method: 'POST',
    url: '/v1/admin/admins',
    payload: { username: 'x-admin', password: 'password123', name: 'X' },
  },
] as const;

describe('admin authorization', () => {
  it.each(ADMIN_ROUTES)('$method $url: anonymous → 401, fan → 403', async (route) => {
    const fan = await registerUser(app, fpl, 5);
    const anon = await app.inject({ ...route });
    expect(anon.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(anon.json()).error.code).toBe('unauthorized');

    const asFan = await app.inject({ ...route, headers: bearer(fan.token) });
    expect(asFan.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(asFan.json()).error.code).toBe('forbidden');
  });

  it('a demoted admin loses access immediately (role re-checked per request)', async () => {
    const token = await adminToken(app, prisma);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(token) })).statusCode,
    ).toBe(200);
    await prisma.user.updateMany({ where: { role: 'ADMIN' }, data: { role: 'USER' } });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(token) })).statusCode,
    ).toBe(403);
  });
});

describe('admin settings', () => {
  it('GET returns defaults; PUT validates the league and stores its name', async () => {
    const token = await adminToken(app, prisma);
    const initial = await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(token) });
    expect(AdminSettingsSchema.parse(initial.json())).toEqual({
      leagueId: null,
      leagueName: null,
      deadlineReminderMinutes: [1440, 120],
      socials: { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null },
    });

    // Unknown league → 404, nothing saved.
    const missing = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(token),
      payload: SETTINGS,
    });
    expect(missing.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(missing.json()).error.message).toContain('314');

    fpl.leagues.set(314, { id: 314, name: 'Fantasyonerim League' });
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(token),
      payload: SETTINGS,
    });
    expect(saved.statusCode).toBe(200);
    expect(AdminSettingsSchema.parse(saved.json())).toMatchObject({
      leagueId: 314,
      leagueName: 'Fantasyonerim League',
      deadlineReminderMinutes: [1440, 120],
    });

    const config = PublicConfigSchema.parse((await app.inject({ method: 'GET', url: '/v1/config' })).json());
    expect(config.league).toEqual({ id: 314, name: 'Fantasyonerim League' });
    expect(config.socials.instagramUrl).toBe('https://instagram.com/fantasyonerim');

    // Clearing the league.
    const cleared = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(token),
      payload: { ...SETTINGS, leagueId: null },
    });
    expect(AdminSettingsSchema.parse(cleared.json()).leagueId).toBeNull();
    const after = PublicConfigSchema.parse((await app.inject({ method: 'GET', url: '/v1/config' })).json());
    expect(after.league).toBeNull();
  });

  it.each([
    ['bad url', { ...SETTINGS, socials: { ...SETTINGS.socials, xUrl: 'not a url' } }],
    ['reminder too small', { ...SETTINGS, deadlineReminderMinutes: [1] }],
    ['too many reminders', { ...SETTINGS, deadlineReminderMinutes: [10, 20, 30, 40, 50, 60] }],
    ['missing socials', { leagueId: null, deadlineReminderMinutes: [] }],
  ])('PUT 400s on invalid body (%s)', async (_label, payload) => {
    const token = await adminToken(app, prisma);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(token),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('bad_request');
  });

  it('PUT 503s when FPL is down while validating the league', async () => {
    const token = await adminToken(app, prisma);
    fpl.failAll = upstreamDown();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(token),
      payload: SETTINGS,
    });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('upstream_unavailable');
  });
});

describe('admin captain battle', () => {
  it('GET is null when unset; PUT saves and replaces; config reflects the latest event', async () => {
    const token = await adminToken(app, prisma);
    const empty = await app.inject({
      method: 'GET',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();

    fpl.addEntry(777);
    const config = {
      event: 9,
      entries: [
        { label: 'Community captain', source: 'player', playerId: 1, kind: 'community' },
        { label: "Dor's captain", source: 'entry', entryId: 777, kind: 'custom' },
      ],
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload: config,
    });
    expect(put.statusCode).toBe(200);
    expect(CaptainBattleConfigSchema.parse(put.json())).toEqual(config);

    const replaced = {
      event: 9,
      entries: [{ label: 'Only one', source: 'player', playerId: 3, kind: 'custom' }],
    };
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload: replaced,
    });
    const got = await app.inject({ method: 'GET', url: '/v1/admin/captain-battle', headers: bearer(token) });
    expect(CaptainBattleConfigSchema.parse(got.json())).toEqual(replaced);
    expect(await prisma.captainBattleEntry.count()).toBe(1);

    const pub = PublicConfigSchema.parse((await app.inject({ method: 'GET', url: '/v1/config' })).json());
    expect(pub.captainBattleEvent).toBe(9);
  });

  it.each([
    [
      'unknown player',
      { event: 9, entries: [{ label: 'X', source: 'player', playerId: 999, kind: 'custom' }] },
    ],
    ['bad event', { event: 39, entries: [] }],
    ['empty label', { event: 9, entries: [{ label: '', source: 'player', playerId: 1, kind: 'custom' }] }],
    ['kind mine', { event: 9, entries: [{ label: 'X', source: 'player', playerId: 1, kind: 'mine' }] }],
    ['no source', { event: 9, entries: [{ label: 'X', playerId: 1, kind: 'custom' }] }],
    [
      'player row without playerId',
      { event: 9, entries: [{ label: 'X', source: 'player', kind: 'custom' }] },
    ],
    [
      'player row with entryId only',
      { event: 9, entries: [{ label: 'X', source: 'player', entryId: 777, kind: 'custom' }] },
    ],
    [
      'entry row without entryId',
      { event: 9, entries: [{ label: 'X', source: 'entry', playerId: 1, kind: 'custom' }] },
    ],
  ])('PUT 400s (%s)', async (_label, payload) => {
    const token = await adminToken(app, prisma);
    fpl.addEntry(777);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('bad_request');
    expect(await prisma.captainBattle.count()).toBe(0);
  });

  it('PUT 400s naming an unknown linked Team ID; 503 when FPL is down', async () => {
    const token = await adminToken(app, prisma);
    const payload = {
      event: 9,
      entries: [
        { label: 'Real', source: 'entry', entryId: 777, kind: 'custom' },
        { label: 'Ghost', source: 'entry', entryId: 4242, kind: 'custom' },
      ],
    };
    fpl.addEntry(777);
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload,
    });
    expect(bad.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(bad.json());
    expect(body.error.message).toContain('4242');
    expect(body.error.message).not.toContain('777');

    fpl.failAll = upstreamDown();
    const down = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload,
    });
    expect(down.statusCode).toBe(503);
    expect(await prisma.captainBattle.count()).toBe(0);
  });

  it('DB check rejects rows with the wrong target for their source', async () => {
    const battle = await prisma.captainBattle.create({ data: { event: 9 } });
    await expect(
      prisma.captainBattleEntry.create({
        data: { battleId: battle.id, order: 0, label: 'x', kind: 'CUSTOM', source: 'ENTRY', playerId: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.captainBattleEntry.create({
        data: {
          battleId: battle.id,
          order: 0,
          label: 'x',
          kind: 'CUSTOM',
          source: 'PLAYER',
          playerId: 1,
          entryId: 5,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.captainBattleEntry.create({
        data: { battleId: battle.id, order: 0, label: 'x', kind: 'CUSTOM', source: 'PLAYER' },
      }),
    ).rejects.toThrow();
  });
});

describe('admin accounts', () => {
  it('lists admins and creates new ones (201), 409 on duplicate username', async () => {
    const token = await adminToken(app, prisma, 'first-admin');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/admins',
      headers: bearer(token),
      payload: { username: 'second', password: 'password123', name: 'Second Admin' },
    });
    expect(created.statusCode).toBe(201);
    expect(AdminAccountSchema.parse(created.json())).toMatchObject({
      username: 'second',
      name: 'Second Admin',
    });

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin-login',
      payload: { username: 'second', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/admin/admins',
      headers: bearer(token),
      payload: { username: 'second', password: 'password456', name: 'Dup' },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/admin/admins',
      headers: bearer(token),
      payload: { username: 'third', password: 'short', name: 'Third' },
    });
    expect(bad.statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: '/v1/admin/admins', headers: bearer(token) });
    const admins = z.array(AdminAccountSchema).parse(list.json());
    expect(admins.map((a) => a.username)).toEqual(['first-admin', 'second']);
    expect(JSON.stringify(list.json())).not.toContain('argon2');
  });
});
