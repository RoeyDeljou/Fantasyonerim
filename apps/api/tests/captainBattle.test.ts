import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptainBattleSchema } from '@fant/shared';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePicks, upstreamDown, type FakeFplService } from './fakeFpl.js';
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

async function configureBattle(event = 9, extra: object[] = []): Promise<void> {
  const token = await adminToken(app, prisma);
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/admin/captain-battle',
    headers: bearer(token),
    payload: {
      event,
      entries: [
        { label: 'Community captain', source: 'player', playerId: 1, kind: 'community' },
        { label: "Dor's captain", source: 'player', playerId: 2, kind: 'custom' },
        { label: "Moshe's captain", source: 'player', playerId: 3, kind: 'custom' },
        ...extra,
      ],
    },
  });
  expect(res.statusCode).toBe(200);
}

const getBattle = async (headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url: '/v1/captain-battle', headers });
  expect(res.statusCode).toBe(200);
  return CaptainBattleSchema.parse(res.json());
};

describe('GET /v1/captain-battle', () => {
  it('is empty when no battle is configured', async () => {
    const battle = await getBattle();
    expect(battle.event).toBeNull();
    expect(battle.rows).toEqual([]);
  });

  it('returns admin captains sorted by captain points (base × 2)', async () => {
    await configureBattle();
    const battle = await getBattle();
    expect(battle.event).toBe(9);
    expect(battle.rows.map((r) => [r.label, r.captainPoints, r.multiplier])).toEqual([
      ["Dor's captain", 26, 2],
      ['Community captain', 12, 2],
      ["Moshe's captain", 4, 2],
    ]);
    expect(battle.rows.every((r) => r.kind !== 'mine' && r.source === 'player' && r.entryId === null)).toBe(
      true,
    );
    expect(battle.rows[0]?.live).toMatchObject({ playerId: 2, basePoints: 13 });
  });

  it('adds a "mine" row for a signed-in fan, triple captain = ×3', async () => {
    await configureBattle();
    const fan = await registerUser(app, fpl, 555, 'Roey');
    fpl.picks.set('555:9', makePicks(555, 9, 4, 3));
    const battle = await getBattle(bearer(fan.token));
    expect(battle.rows.map((r) => [r.key === 'me' ? 'me' : r.label, r.captainPoints])).toEqual([
      ['me', 27],
      ["Dor's captain", 26],
      ['Community captain', 12],
      ["Moshe's captain", 4],
    ]);
    const mine = battle.rows[0];
    expect(mine).toMatchObject({
      key: 'me',
      kind: 'mine',
      source: 'mine',
      entryId: 555,
      label: 'Roey',
      playerId: 4,
      multiplier: 3,
    });
  });

  it('normal captain in the mine row is ×2', async () => {
    await configureBattle();
    const fan = await registerUser(app, fpl, 555, 'Roey');
    fpl.picks.set('555:9', makePicks(555, 9, 3, 2));
    const mine = (await getBattle(bearer(fan.token))).rows.find((r) => r.key === 'me');
    expect(mine).toMatchObject({ multiplier: 2, captainPoints: 4 });
  });

  it('omits the mine row when the picks fetch fails, instead of failing', async () => {
    await configureBattle();
    const fan = await registerUser(app, fpl, 555);
    fpl.failPicks = upstreamDown();
    const battle = await getBattle(bearer(fan.token));
    expect(battle.rows).toHaveLength(3);
    expect(battle.rows.some((r) => r.key === 'me')).toBe(false);
  });

  it('omits the mine row for admins without a team and for invalid tokens', async () => {
    await configureBattle();
    const admin = await adminToken(app, prisma, 'other-admin');
    expect((await getBattle(bearer(admin))).rows).toHaveLength(3);
    expect((await getBattle(bearer('not-a-real-token-but-long-enough'))).rows).toHaveLength(3);
  });

  it('uses the most recently saved battle', async () => {
    await configureBattle(9);
    const token = await adminToken(app, prisma, 'second-admin');
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload: {
        event: 10,
        entries: [{ label: 'Next week', source: 'player', playerId: 4, kind: 'custom' }],
      },
    });
    const battle = await getBattle();
    expect(battle.event).toBe(10);
    expect(battle.rows.map((r) => r.label)).toEqual(['Next week']);
  });

  it('503s when FPL live data is unavailable', async () => {
    await configureBattle();
    fpl.failAll = upstreamDown();
    const res = await app.inject({ method: 'GET', url: '/v1/captain-battle' });
    expect(res.statusCode).toBe(503);
  });

  it('entry-linked rows resolve the team captain; TC = ×3', async () => {
    fpl.addEntry(777).addEntry(888);
    fpl.picks.set('777:9', makePicks(777, 9, 4, 3)); // TC on Saka (9) → 27
    fpl.picks.set('888:9', makePicks(888, 9, 3, 2)); // Palmer (2) → 4
    await configureBattle(9, [
      { label: "Dor's team", source: 'entry', entryId: 777, kind: 'custom' },
      { label: "Moshe's team", source: 'entry', entryId: 888, kind: 'custom' },
    ]);
    const battle = await getBattle();
    expect(
      battle.rows.map((r) => [r.label, r.source, r.entryId, r.playerId, r.multiplier, r.captainPoints]),
    ).toEqual([
      ["Dor's team", 'entry', 777, 4, 3, 27],
      ["Dor's captain", 'player', null, 2, 2, 26],
      ['Community captain', 'player', null, 1, 2, 12],
      ["Moshe's captain", 'player', null, 3, 2, 4],
      ["Moshe's team", 'entry', 888, 3, 2, 4],
    ]);
    expect(battle.rows[0]?.live).toMatchObject({ playerId: 4, basePoints: 9 });
    // One live call for every resolved player.
    expect(fpl.calls.filter((c) => c.startsWith('getPlayersLive'))).toEqual(['getPlayersLive:1,2,3,4:9']);
  });

  it('entry row before the deadline (picks 404) → null player, 0 points, sorted last', async () => {
    fpl.addEntry(777).addEntry(888);
    fpl.picks.set('888:9', makePicks(888, 9, 3, 2));
    fpl.playerPoints.set(1, 0).set(2, 0).set(3, 0);
    await configureBattle(9, [
      { label: 'Hidden team', source: 'entry', entryId: 777, kind: 'community' },
      { label: 'Known team', source: 'entry', entryId: 888, kind: 'custom' },
    ]);
    const battle = await getBattle();
    const last = battle.rows.at(-1);
    expect(last).toMatchObject({
      label: 'Hidden team',
      source: 'entry',
      entryId: 777,
      playerId: null,
      live: null,
      captainPoints: 0,
      multiplier: 2,
    });
    // Resolved rows with 0 points still rank above the unresolved one.
    expect(battle.rows.slice(0, -1).every((r) => r.live !== null)).toBe(true);
  });

  it('entry row survives an upstream failure on its picks (row kept, captain unknown)', async () => {
    fpl.addEntry(777);
    await configureBattle(9, [{ label: 'Linked', source: 'entry', entryId: 777, kind: 'custom' }]);
    fpl.failPicks = upstreamDown();
    const battle = await getBattle();
    expect(battle.rows).toHaveLength(4);
    expect(battle.rows.at(-1)).toMatchObject({ label: 'Linked', playerId: null, live: null });
  });

  it('viewer who is also a linked team: picks fetched once, both rows present', async () => {
    const fan = await registerUser(app, fpl, 777, 'Dor');
    fpl.picks.set('777:9', makePicks(777, 9, 2, 2));
    await configureBattle(9, [{ label: "Dor's team", source: 'entry', entryId: 777, kind: 'custom' }]);
    fpl.calls = [];
    const battle = await getBattle(bearer(fan.token));
    expect(battle.rows.filter((r) => r.entryId === 777).map((r) => r.source)).toEqual(['entry', 'mine']);
    expect(fpl.calls.filter((c) => c.startsWith('getEntryPicks'))).toEqual(['getEntryPicks:777:9']);
  });
});

describe('captain battle migration', () => {
  it('moves pre-existing rows to source PLAYER and enforces one target per source', async () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations');
    const [init, ...rest] = readdirSync(dir)
      .filter((d) => /^\d+_/.test(d))
      .sort();
    const sql = (name: string) =>
      readFileSync(resolve(dir, name, 'migration.sql'), 'utf8')
        .split(/;\s*$/m)
        .map((stmt) => stmt.replace(/^\s*--.*$/gm, '').trim())
        .filter((stmt) => stmt.length > 0);

    const schema = 'migration_check';
    const url = new URL(TEST_DATABASE_URL);
    url.searchParams.set('schema', schema);
    const scratch = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await scratch.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await scratch.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await scratch.$executeRawUnsafe(`SET search_path TO "${schema}"`);
      for (const stmt of sql(init ?? '')) await scratch.$executeRawUnsafe(stmt);
      await scratch.$executeRawUnsafe(
        `INSERT INTO "CaptainBattle" (id, event, "updatedAt") VALUES ('b1', 9, now())`,
      );
      await scratch.$executeRawUnsafe(
        `INSERT INTO "CaptainBattleEntry" (id, "battleId", "order", label, "playerId", kind) VALUES ('e1', 'b1', 0, 'Old row', 7, 'CUSTOM')`,
      );
      for (const name of rest) for (const stmt of sql(name)) await scratch.$executeRawUnsafe(stmt);

      const rows = await scratch.$queryRawUnsafe<
        { source: string; playerId: number | null; entryId: number | null }[]
      >(`SELECT source::text AS source, "playerId", "entryId" FROM "CaptainBattleEntry"`);
      expect(rows).toEqual([{ source: 'PLAYER', playerId: 7, entryId: null }]);
      await expect(
        scratch.$executeRawUnsafe(
          `INSERT INTO "CaptainBattleEntry" (id, "battleId", "order", label, kind, source) VALUES ('e2', 'b1', 1, 'Bad', 'CUSTOM', 'ENTRY')`,
        ),
      ).rejects.toThrow();
    } finally {
      await scratch.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await scratch.$disconnect();
    }
  });
});
