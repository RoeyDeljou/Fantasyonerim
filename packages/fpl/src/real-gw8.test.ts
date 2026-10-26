import { FplPlayerIdSchema, GameweekSchema, PlayerLiveSchema } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { REAL_GW8 } from './__fixtures__/real-gw8.js';
import { createFplService } from './client.js';
import { createReplayFetch } from './replay.js';

/**
 * Regression over REAL recorded FPL data (GW8, fixtures 76 and 80). The recorded state is final; the
 * two in-progress states are derived from it exactly the way FPL serves them during/after a match.
 */

type Real = typeof REAL_GW8;
const gw = GameweekSchema.parse(8);
const clone = (): Real => JSON.parse(JSON.stringify(REAL_GW8)) as Real;

async function playersLive(data: Real) {
  const service = createFplService({
    fetch: createReplayFetch({
      'bootstrap-static/': data.bootstrap,
      'fixtures/?event=8': data.fixtures,
      'event/8/live/': data.live,
    }),
  });
  const ids = data.live.elements.map((e) => FplPlayerIdSchema.parse(e.id));
  const rows = await service.getPlayersLive(ids, gw);
  for (const r of rows) PlayerLiveSchema.parse(r);
  return new Map(rows.map((r) => [r.playerId as number, r]));
}

const realBonus = new Map(REAL_GW8.live.elements.map((e) => [e.id, e.stats.bonus]));
const realTotal = new Map(REAL_GW8.live.elements.map((e) => [e.id, e.stats.total_points]));

describe('real GW8 data: bonus semantics', () => {
  it('as recorded (finished): points = FPL total_points, nothing provisional', async () => {
    const live = await playersLive(clone());
    expect(live.size).toBe(REAL_GW8.live.elements.length);
    for (const [id, row] of live) {
      expect(row.basePoints, `element ${id}`).toBe(realTotal.get(id));
      expect(row.provisionalBonus).toBe(0);
      expect(row.fixtureStatus).toBe('finished');
    }
    expect([...realBonus.values()].filter((b) => b > 0).length).toBeGreaterThanOrEqual(7);
  });

  it('finished_provisional with FPL live bonus written in: shown as provisional, not added twice', async () => {
    const data = clone();
    for (const f of data.fixtures) f.finished = false;
    const live = await playersLive(data);
    for (const [id, row] of live) {
      expect(row.basePoints, `element ${id}`).toBe(realTotal.get(id));
      expect(row.provisionalBonus, `element ${id}`).toBe(realBonus.get(id));
    }
  });

  it('bonus not populated yet: BPS ranking reproduces FPL’s real awards (incl. ties)', async () => {
    const data = clone();
    for (const f of data.fixtures) {
      f.finished = false;
      for (const s of f.stats) if (s.identifier === 'bonus') s.h = s.a = [];
    }
    for (const e of data.live.elements) {
      e.stats.total_points -= e.stats.bonus;
      e.stats.bonus = 0;
    }
    const live = await playersLive(data);
    for (const [id, row] of live) {
      expect(row.provisionalBonus, `element ${id}`).toBe(realBonus.get(id));
      expect(row.basePoints, `element ${id}`).toBe(realTotal.get(id));
    }
  });
});
