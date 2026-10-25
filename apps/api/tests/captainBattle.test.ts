import { CaptainBattleSchema } from '@fant/shared';
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

async function configureBattle(event = 9): Promise<void> {
  const token = await adminToken(app, prisma);
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/admin/captain-battle',
    headers: bearer(token),
    payload: {
      event,
      entries: [
        { label: 'Community captain', playerId: 1, kind: 'community' },
        { label: "Dor's captain", playerId: 2, kind: 'custom' },
        { label: "Moshe's captain", playerId: 3, kind: 'custom' },
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
    expect(battle.rows.every((r) => r.kind !== 'mine')).toBe(true);
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
    expect(mine).toMatchObject({ key: 'me', kind: 'mine', label: 'Roey', playerId: 4, multiplier: 3 });
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
      payload: { event: 10, entries: [{ label: 'Next week', playerId: 4, kind: 'custom' }] },
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
});
