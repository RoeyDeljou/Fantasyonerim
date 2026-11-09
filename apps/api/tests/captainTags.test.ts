import { ApiErrorSchema, CaptainBattleConfigSchema, CaptainBattleSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePicks, type FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';
import { cleanTag, DEFAULT_CAPTAIN_LABELS, upgradeCaptainKinds } from '../src/league/captains.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl } = await buildTestApp(prisma));
  fpl.playerPoints.set(1, 6).set(2, 13).set(3, 2).set(4, 9);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let cachedToken: string | null = null;
beforeEach(() => {
  cachedToken = null;
});
const put = async (payload: object) => {
  const token = (cachedToken ??= await adminToken(app, prisma));
  return app.inject({ method: 'PUT', url: '/v1/admin/captain-battle', headers: bearer(token), payload });
};
const getAdmin = async () => {
  const token = await adminToken(app, prisma, 'reader');
  const res = await app.inject({ method: 'GET', url: '/v1/admin/captain-battle', headers: bearer(token) });
  expect(res.statusCode).toBe(200);
  return CaptainBattleConfigSchema.parse(res.json());
};
const getLive = async (headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url: '/v1/captain-battle', headers });
  expect(res.statusCode).toBe(200);
  return CaptainBattleSchema.parse(res.json());
};

describe('admin captain battle: tags and permanent captains', () => {
  it('saves kind fpl_lad and tags; trims them and turns empty into null', async () => {
    const res = await put({
      event: 9,
      entries: [
        { label: 'FPL Lad', source: 'player', playerId: 3, kind: 'fpl_lad', tag: '  Lad  ' },
        { label: 'Community', source: 'player', playerId: 1, kind: 'community', tag: '   ' },
        { label: 'Producer', source: 'player', playerId: 2, kind: 'custom', tag: '' },
        { label: 'No tag key', source: 'player', playerId: 4, kind: 'custom' },
        { label: 'Null tag', source: 'player', playerId: 4, kind: 'custom', tag: null },
      ],
    });
    expect(res.statusCode).toBe(200);
    const expected = [
      ['FPL Lad', 'fpl_lad', 'Lad'],
      ['Community', 'community', null],
      ['Producer', 'custom', null],
      ['No tag key', 'custom', null],
      ['Null tag', 'custom', null],
    ];
    expect(CaptainBattleConfigSchema.parse(res.json()).entries.map((e) => [e.label, e.kind, e.tag])).toEqual(
      expected,
    );
    expect((await getAdmin()).entries.map((e) => [e.label, e.kind, e.tag])).toEqual(expected);
    const rows = await prisma.captainBattleEntry.findMany({ orderBy: { order: 'asc' } });
    expect(rows.map((r) => [r.kind, r.tag])).toEqual([
      ['FPL_LAD', 'Lad'],
      ['COMMUNITY', null],
      ['CUSTOM', null],
      ['CUSTOM', null],
      ['CUSTOM', null],
    ]);
  });

  it('a linked team can wear any tag', async () => {
    fpl.addEntry(777);
    const res = await put({
      event: 9,
      entries: [{ label: 'Dor', source: 'entry', entryId: 777, kind: 'custom', tag: 'Host' }],
    });
    expect(res.statusCode).toBe(200);
    expect((await getAdmin()).entries[0]).toMatchObject({ source: 'entry', tag: 'Host', kind: 'custom' });
  });

  it.each([
    [
      'a tag over 24 characters',
      [{ label: 'X', source: 'player', playerId: 1, kind: 'custom', tag: 'x'.repeat(25) }],
    ],
    [
      'two fpl_lad captains',
      [
        { label: 'A', source: 'player', playerId: 1, kind: 'fpl_lad' },
        { label: 'B', source: 'player', playerId: 2, kind: 'fpl_lad' },
      ],
    ],
    [
      'two community captains',
      [
        { label: 'A', source: 'player', playerId: 1, kind: 'community' },
        { label: 'B', source: 'player', playerId: 2, kind: 'community' },
      ],
    ],
    ['a non-string tag', [{ label: 'X', source: 'player', playerId: 1, kind: 'custom', tag: 5 }]],
    ['an unknown kind', [{ label: 'X', source: 'player', playerId: 1, kind: 'lad' }]],
  ])('PUT 400s for %s', async (_what, entries) => {
    const res = await put({ event: 9, entries });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('bad_request');
    expect(await prisma.captainBattle.count()).toBe(0);
  });

  it('a tag of exactly 24 characters is accepted', async () => {
    const tag = 'x'.repeat(24);
    const res = await put({
      event: 9,
      entries: [{ label: 'X', source: 'player', playerId: 1, kind: 'custom', tag }],
    });
    expect(res.statusCode).toBe(200);
    expect((await getAdmin()).entries[0]?.tag).toBe(tag);
  });

  it('a battle saved without the permanent rows is stored as sent (a permanent row needs a player to be stored)', async () => {
    const res = await put({
      event: 9,
      entries: [{ label: 'Producer', source: 'player', playerId: 2, kind: 'custom' }],
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.captainBattleEntry.count()).toBe(1);
    // ...and the live battle still shows both permanent captains (below).
    expect((await getLive()).rows.map((r) => r.kind)).toEqual(['custom', 'community', 'fpl_lad']);
  });

  it('cleanTag', () => {
    expect([cleanTag(undefined), cleanTag(null), cleanTag(' '), cleanTag(' a ')]).toEqual([
      null,
      null,
      null,
      'a',
    ]);
  });
});

describe('GET /v1/captain-battle: permanent rows and tags', () => {
  it('shows saved tags and kinds; absent permanent rows are virtual "not picked yet" rows', async () => {
    fpl.addEntry(777);
    fpl.picks.set('777:9', makePicks(777, 9, 4, 2));
    await put({
      event: 9,
      entries: [
        { label: 'Fans', source: 'player', playerId: 1, kind: 'community', tag: 'Crowd' },
        { label: 'Dor', source: 'entry', entryId: 777, kind: 'custom', tag: 'Host' },
      ],
    });
    const battle = await getLive();
    expect(battle.rows.map((r) => [r.label, r.kind, r.tag, r.playerId, r.captainPoints])).toEqual([
      ['Dor', 'custom', 'Host', 4, 18],
      ['Fans', 'community', 'Crowd', 1, 12],
      [DEFAULT_CAPTAIN_LABELS.fpl_lad, 'fpl_lad', null, null, 0],
    ]);
    const virtual = battle.rows[2];
    expect(virtual).toMatchObject({
      key: 'fpl_lad',
      source: 'player',
      entryId: null,
      live: null,
      multiplier: 2,
    });
  });

  it('a saved fpl_lad row is a normal row; both permanent rows missing are both virtual (default labels)', async () => {
    await put({
      event: 9,
      entries: [{ label: 'הקפטן של FPL Lad', source: 'player', playerId: 2, kind: 'fpl_lad', tag: 'Lad' }],
    });
    let battle = await getLive();
    expect(battle.rows.map((r) => [r.kind, r.tag, r.playerId, r.captainPoints])).toEqual([
      ['fpl_lad', 'Lad', 2, 26],
      ['community', null, null, 0],
    ]);
    expect(battle.rows[1]?.label).toBe(DEFAULT_CAPTAIN_LABELS.community);

    await put({ event: 9, entries: [] });
    battle = await getLive();
    expect(battle.rows.map((r) => [r.kind, r.label, r.playerId])).toEqual([
      ['community', 'קפטן הקהילה', null],
      ['fpl_lad', 'הקפטן של FPL Lad', null],
    ]);
  });

  it('a battle saved before permanent rows existed (legacy kinds in the DB) still shows both', async () => {
    await prisma.captainBattle.create({
      data: {
        event: 9,
        entries: { create: [{ order: 0, label: 'Old', kind: 'CUSTOM', source: 'PLAYER', playerId: 1 }] },
      },
    });
    expect((await getLive()).rows.map((r) => r.kind)).toEqual(['custom', 'community', 'fpl_lad']);
  });

  it("the viewer's mine row has a null tag", async () => {
    await put({ event: 9, entries: [] });
    const fan = await registerUser(app, fpl, 555, 'Roey');
    fpl.picks.set('555:9', makePicks(555, 9, 4, 2));
    const mine = (await getLive(bearer(fan.token))).rows.find((r) => r.kind === 'mine');
    expect(mine).toMatchObject({ tag: null, captainPoints: 18 });
  });

  it('an admin save is visible at once (hot cache invalidated)', async () => {
    await put({
      event: 9,
      entries: [{ label: 'A', source: 'player', playerId: 1, kind: 'custom', tag: 'one' }],
    });
    expect((await getLive()).rows[0]?.tag).toBe('one');
    await put({
      event: 9,
      entries: [{ label: 'A', source: 'player', playerId: 1, kind: 'custom', tag: 'two' }],
    });
    expect((await getLive()).rows[0]?.tag).toBe('two');
  });
});

describe('upgradeCaptainKinds (boot-time, idempotent)', () => {
  it('turns the legacy FPL LAD label into FPL_LAD and demotes duplicates of a permanent kind to CUSTOM', async () => {
    const battle = await prisma.captainBattle.create({
      data: {
        event: 9,
        entries: {
          create: [
            { order: 0, label: 'קפטן הקהילה', kind: 'COMMUNITY', source: 'PLAYER', playerId: 1 },
            { order: 1, label: 'הקפטן של FPL LAD', kind: 'COMMUNITY', source: 'PLAYER', playerId: 2 },
            { order: 2, label: 'הקפטן של דור', kind: 'CUSTOM', source: 'ENTRY', entryId: 11 },
            { order: 3, label: 'second fpl-lad', kind: 'CUSTOM', source: 'PLAYER', playerId: 3 },
            { order: 4, label: 'Another community', kind: 'COMMUNITY', source: 'PLAYER', playerId: 4 },
            { order: 5, label: 'FPL   Lad again', kind: 'FPL_LAD', source: 'PLAYER', playerId: 4 },
          ],
        },
      },
    });
    const kinds = async () =>
      (
        await prisma.captainBattleEntry.findMany({
          where: { battleId: battle.id },
          orderBy: { order: 'asc' },
        })
      ).map((e) => e.kind);

    expect(await upgradeCaptainKinds(prisma)).toBe(3);
    expect(await kinds()).toEqual(['COMMUNITY', 'FPL_LAD', 'CUSTOM', 'CUSTOM', 'CUSTOM', 'CUSTOM']);

    // Idempotent: nothing left to change, nothing written.
    const before = await prisma.captainBattleEntry.findMany({ orderBy: { order: 'asc' } });
    expect(await upgradeCaptainKinds(prisma)).toBe(0);
    expect(await prisma.captainBattleEntry.findMany({ orderBy: { order: 'asc' } })).toEqual(before);
  });

  it('keeps the first of two FPL_LAD rows by order, per battle, and leaves clean battles alone', async () => {
    const dirty = await prisma.captainBattle.create({
      data: {
        event: 8,
        entries: {
          create: [
            { order: 0, label: 'Lad B', kind: 'FPL_LAD', source: 'PLAYER', playerId: 1 },
            { order: 1, label: 'Lad A', kind: 'FPL_LAD', source: 'PLAYER', playerId: 2 },
          ],
        },
      },
    });
    await prisma.captainBattle.create({
      data: {
        event: 9,
        entries: {
          create: [
            { order: 0, label: 'Fans', kind: 'COMMUNITY', source: 'PLAYER', playerId: 1 },
            { order: 1, label: 'Lad', kind: 'FPL_LAD', source: 'PLAYER', playerId: 2 },
          ],
        },
      },
    });
    expect(await upgradeCaptainKinds(prisma)).toBe(1);
    const rows = await prisma.captainBattleEntry.findMany({
      where: { battleId: dirty.id },
      orderBy: { order: 'asc' },
    });
    expect(rows.map((r) => [r.label, r.kind])).toEqual([
      ['Lad B', 'FPL_LAD'],
      ['Lad A', 'CUSTOM'],
    ]);
  });

  it('upgraded production-shaped data: the live battle shows the FPL Lad row with its own kind', async () => {
    await prisma.captainBattle.create({
      data: {
        event: 9,
        entries: {
          create: [
            { order: 0, label: 'הקפטן של דור', kind: 'CUSTOM', source: 'PLAYER', playerId: 2 },
            { order: 1, label: 'קפטן הקהילה', kind: 'COMMUNITY', source: 'PLAYER', playerId: 1 },
            { order: 2, label: 'הקפטן של FPL LAD', kind: 'COMMUNITY', source: 'PLAYER', playerId: 4 },
          ],
        },
      },
    });
    await upgradeCaptainKinds(prisma);
    app.hot.invalidateConfig();
    expect((await getLive()).rows.map((r) => [r.label, r.kind])).toEqual([
      ['הקפטן של דור', 'custom'],
      ['הקפטן של FPL LAD', 'fpl_lad'],
      ['קפטן הקהילה', 'community'],
    ]);
    const admin = await getAdmin();
    expect(admin.entries.map((e) => e.kind)).toEqual(['custom', 'community', 'fpl_lad']);
  });

  it('does nothing without battles', async () => {
    expect(await upgradeCaptainKinds(prisma)).toBe(0);
  });
});
