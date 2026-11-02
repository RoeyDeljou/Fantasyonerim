import { FixtureDetailSchema, FixtureStatIdSchema, FplFixtureIdSchema, GameweekSchema } from '@fant/shared';
import { describe, expect, it, vi } from 'vitest';
import { REAL_GW9_FIXTURE81 } from './__fixtures__/real-gw9-fixture81.js';
import { createFplService } from './client.js';
import { createReplayFetch } from './replay.js';
import { FplNotFoundError } from './service.js';

/**
 * getFixtureDetail over REAL recorded FPL data (GW9 fixture 81, 1–1, finished_provisional;
 * fixture 89 not started), plus synthetic edits for DGW and unknown stat identifiers.
 */

type Real = typeof REAL_GW9_FIXTURE81;
type RawStat = {
  identifier: string;
  a: { value: number; element: number }[];
  h: { value: number; element: number }[];
};
const clone = (): Real => JSON.parse(JSON.stringify(REAL_GW9_FIXTURE81)) as Real;
const fid = (n: number) => FplFixtureIdSchema.parse(n);
const NOW = Date.UTC(2026, 10, 2, 9, 0);

function serviceFor(data: Real, extra: { onWarn?: (m: string) => void } = {}) {
  const requests: string[] = [];
  const service = createFplService({
    fetch: createReplayFetch(
      {
        'bootstrap-static/': data.bootstrap,
        'fixtures/?event=9': data.fixtures,
        'fixtures/': data.fixtures,
        'event/9/live/': data.live,
      },
      { onRequest: (k) => requests.push(k) },
    ),
    now: () => NOW,
    ...extra,
  });
  return { service, requests };
}

const raw81 = REAL_GW9_FIXTURE81.fixtures.find((f) => f.id === 81);
if (!raw81) throw new Error('fixture 81 missing from recording');
const teamOf = new Map(REAL_GW9_FIXTURE81.bootstrap.elements.map((e) => [e.id, e.team]));

describe('getFixtureDetail — real GW9 fixture 81', () => {
  it('stat blocks: FixtureStatIdSchema order, empty blocks dropped, values desc', async () => {
    const { service } = serviceFor(clone());
    const detail = FixtureDetailSchema.parse(await service.getFixtureDetail(fid(81)));

    expect(detail.fixture).toMatchObject({ id: 81, teamH: 2, teamA: 10, teamHScore: 1, teamAScore: 1 });
    expect(detail.fixture.status).toBe('finished_provisional');
    // penalties_saved and red_cards are empty in the recording → dropped.
    expect(detail.stats.map((s) => s.id)).toEqual([
      'goals_scored',
      'assists',
      'own_goals',
      'penalties_missed',
      'yellow_cards',
      'saves',
      'bonus',
      'bps',
      'defensive_contribution',
    ]);
    const order = FixtureStatIdSchema.options;
    const idx = detail.stats.map((s) => order.indexOf(s.id));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    for (const block of detail.stats) {
      expect(block.home.length + block.away.length).toBeGreaterThan(0);
      for (const side of [block.home, block.away]) {
        const values = side.map((v) => v.value);
        expect(values).toEqual([...values].sort((a, b) => b - a));
      }
    }
  });

  it('home/away mapping: h → home (team_h players), a → away (team_a players)', async () => {
    const { service } = serviceFor(clone());
    const detail = await service.getFixtureDetail(fid(81));
    const block = (id: string) => detail.stats.find((s) => s.id === id);

    expect(block('goals_scored')).toEqual({
      id: 'goals_scored',
      home: [{ playerId: 166, value: 1 }],
      away: [],
    });
    expect(block('bonus')?.home.slice(0, 2)).toEqual([
      { playerId: 166, value: 3 },
      { playerId: 53, value: 2 },
    ]);
    expect(block('penalties_missed')?.home).toEqual([{ playerId: 45, value: 1 }]);

    for (const s of detail.stats) {
      const rawBlock = (raw81.stats as RawStat[]).find((r) => r.identifier === s.id);
      expect(new Set(s.home.map((v) => v.playerId))).toEqual(new Set(rawBlock?.h.map((v) => v.element)));
      expect(new Set(s.away.map((v) => v.playerId))).toEqual(new Set(rawBlock?.a.map((v) => v.element)));
      // every stat (incl. own goals) is listed under the side of the player it belongs to
      for (const v of s.home) expect(teamOf.get(v.playerId), `${s.id} home ${v.playerId}`).toBe(2);
      for (const v of s.away) expect(teamOf.get(v.playerId), `${s.id} away ${v.playerId}`).toBe(10);
    }
  });

  it('players: Σ explain points for this fixture, minutes > 0 only, points desc, team from the sheet', async () => {
    const { service } = serviceFor(clone());
    const detail = await service.getFixtureDetail(fid(81));

    // 64 players have an explain entry for fixture 81; 32 of them played.
    expect(detail.players).toHaveLength(32);
    expect(detail.players.slice(0, 2)).toEqual([
      { playerId: 166, teamId: 2, minutes: expect.any(Number) as number, points: 9 },
      { playerId: 53, teamId: 2, minutes: expect.any(Number) as number, points: 7 },
    ]);
    const points = detail.players.map((p) => p.points);
    expect(points).toEqual([...points].sort((a, b) => b - a));

    // Single-fixture GW for these players: the per-fixture sum must equal FPL's own GW total.
    const live = new Map(REAL_GW9_FIXTURE81.live.elements.map((e) => [e.id, e.stats]));
    for (const p of detail.players) {
      expect(p.minutes).toBeGreaterThan(0);
      expect(p.minutes, `minutes ${p.playerId}`).toBe(live.get(p.playerId)?.minutes);
      expect(p.points, `points ${p.playerId}`).toBe(live.get(p.playerId)?.total_points);
      expect(p.teamId).toBe(teamOf.get(p.playerId));
    }
    // 569 played 86' with 0 BPS, so FPL doesn't list him in any stat block: team comes from bootstrap.
    expect(detail.players.find((p) => p.playerId === 569)).toEqual({
      playerId: 569,
      teamId: teamOf.get(569),
      minutes: 86,
      points: 2,
    });
    expect(detail.updatedAt).toBe(new Date(NOW).toISOString());
  });

  it('not started → empty stats and players, and the live endpoint is not fetched', async () => {
    const { service, requests } = serviceFor(clone());
    const detail = FixtureDetailSchema.parse(await service.getFixtureDetail(fid(89)));
    expect(detail.fixture.status).toBe('not_started');
    expect(detail.stats).toEqual([]);
    expect(detail.players).toEqual([]);
    expect(requests).not.toContain('event/9/live/');
  });

  it('unknown fixture id → FplNotFoundError', async () => {
    const { service } = serviceFor(clone());
    await expect(service.getFixtureDetail(fid(9999))).rejects.toBeInstanceOf(FplNotFoundError);
  });

  it('an unknown stat identifier is ignored and warned about once', async () => {
    const data = clone();
    const f = data.fixtures.find((x) => x.id === 81) as { stats: RawStat[] };
    f.stats.unshift({ identifier: 'shots_on_target', h: [{ value: 3, element: 166 }], a: [] });
    const onWarn = vi.fn();
    const { service } = serviceFor(data, { onWarn });

    const detail = await service.getFixtureDetail(fid(81));
    await service.getFixtureDetail(fid(81));
    expect(detail.stats[0]?.id).toBe('goals_scored');
    expect(detail.stats.map((s) => s.id)).not.toContain('shots_on_target');
    expect(detail.stats).toHaveLength(9);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]?.[0])).toContain('shots_on_target');
  });

  it('DGW: each fixture only counts its own explain entry', async () => {
    const data = clone();
    // Synthetic second GW9 fixture 95 for team 2 (home) vs team 9.
    const second = {
      ...JSON.parse(JSON.stringify(raw81)),
      id: 95,
      team_a: 9,
      team_a_score: 0,
      team_h_score: 2,
    } as (typeof data.fixtures)[number];
    (second as { stats: RawStat[] }).stats = [
      { identifier: 'goals_scored', h: [{ value: 2, element: 166 }], a: [] },
      { identifier: 'bps', h: [{ value: 50, element: 166 }], a: [] },
    ];
    data.fixtures.push(second);
    const scorer = data.live.elements.find((e) => e.id === 166);
    if (!scorer) throw new Error('166 missing');
    scorer.explain.push({
      fixture: 95,
      stats: [
        { identifier: 'minutes', points: 2, value: 70, points_modification: 0 },
        { identifier: 'goals_scored', points: 8, value: 2, points_modification: 0 },
      ],
    });
    scorer.stats.total_points += 10;
    scorer.stats.minutes += 70;

    const { service } = serviceFor(data);
    const first = await service.getFixtureDetail(fid(81));
    const dgw = await service.getFixtureDetail(fid(95));
    const in81 = first.players.find((p) => p.playerId === 166);
    expect(in81?.points).toBe(9);
    expect(in81?.minutes).toBe(REAL_GW9_FIXTURE81.live.elements.find((e) => e.id === 166)?.stats.minutes);
    expect(dgw.players).toEqual([{ playerId: 166, teamId: 2, minutes: 70, points: 10 }]);
    expect(dgw.stats.map((s) => s.id)).toEqual(['goals_scored', 'bps']);
  });

  it('uses the cached current-GW fixtures and live (no whole-season fetch, shared across calls)', async () => {
    const { service, requests } = serviceFor(clone());
    await Promise.all([service.getFixtureDetail(fid(81)), service.getFixtureDetail(fid(81))]);
    await service.getFixtures(GameweekSchema.parse(9));
    expect(requests.filter((r) => r === 'fixtures/?event=9')).toHaveLength(1);
    expect(requests.filter((r) => r === 'event/9/live/')).toHaveLength(1);
    expect(requests).not.toContain('fixtures/');
  });

  it('falls back to the whole-season fixture list for a fixture outside the current GW', async () => {
    const data = clone();
    for (const e of data.bootstrap.events) e.is_current = false;
    const { service, requests } = serviceFor(data);
    const detail = await service.getFixtureDetail(fid(81));
    expect(detail.players).toHaveLength(32);
    expect(requests).toContain('fixtures/');
  });
});

/**
 * Fixture 81 rewound to 55' as FPL serves it mid-match: started, not finished, score 1–0, own goal and
 * missed penalty not happened yet, bonus not written in (bps present), explain minutes capped at 55 with
 * the 1-point (< 60') minutes award. One unused sub comes on at 52' (3 minutes); another stays benched.
 */
function liveAt55(): { data: Real; subOn: number; benched: number } {
  const data = clone();
  const f = data.fixtures.find((x) => x.id === 81) as Record<string, unknown> & { stats: RawStat[] };
  Object.assign(f, { finished: false, finished_provisional: false, started: true, minutes: 55 });
  Object.assign(f, { team_h_score: 1, team_a_score: 0 });
  const later = new Set(['own_goals', 'penalties_missed']);
  for (const s of f.stats) if (later.has(s.identifier) || s.identifier === 'bonus') s.h = s.a = [];

  const unused = data.live.elements.filter((e) =>
    e.explain.some(
      (x) => x.fixture === 81 && x.stats.every((st) => st.identifier !== 'minutes' || st.value === 0),
    ),
  );
  const [sub, bench] = unused;
  if (!sub || !bench) throw new Error('need two unused players');
  for (const e of data.live.elements) {
    for (const x of e.explain) {
      if (x.fixture !== 81) continue;
      x.stats = x.stats
        .filter((st) => st.identifier !== 'bonus' && !later.has(st.identifier))
        .map((st) => {
          if (st.identifier !== 'minutes') return st;
          const value = e.id === sub.id ? 3 : Math.min(st.value, 55);
          return { ...st, value, points: value > 0 ? 1 : 0 };
        });
    }
  }
  return { data, subOn: sub.id, benched: bench.id };
}

describe('getFixtureDetail — live fixture (synthetic 55′ of real fixture 81)', () => {
  it('status, score and minutes from fixtures; in-play blocks present, bonus absent; points = live explain', async () => {
    const { data, subOn, benched } = liveAt55();
    const { service } = serviceFor(data);
    const d = FixtureDetailSchema.parse(await service.getFixtureDetail(fid(81)));

    expect(d.fixture).toMatchObject({ status: 'live', minutes: 55, teamHScore: 1, teamAScore: 0 });
    const ids = d.stats.map((s) => s.id);
    for (const id of ['goals_scored', 'assists', 'bps', 'defensive_contribution'] as const)
      expect(ids).toContain(id);
    expect(ids).not.toContain('bonus');
    expect(ids).not.toContain('own_goals');

    const expected = data.live.elements
      .map((e) => {
        const stats = e.explain.filter((x) => x.fixture === 81).flatMap((x) => x.stats);
        return {
          playerId: e.id,
          minutes: stats.find((s) => s.identifier === 'minutes')?.value ?? 0,
          points: stats.reduce((sum, s) => sum + s.points, 0),
        };
      })
      .filter((p) => p.minutes > 0);
    expect(d.players).toHaveLength(expected.length);
    for (const p of d.players) {
      const e = expected.find((x) => x.playerId === p.playerId);
      expect({ minutes: p.minutes, points: p.points }, `player ${p.playerId}`).toEqual({
        minutes: e?.minutes,
        points: e?.points,
      });
      expect(p.minutes).toBeLessThanOrEqual(55);
    }
    // Goal scorer at 55': 1 (minutes) + goal, no bonus yet.
    const scorer = d.players.find((p) => p.playerId === 166);
    expect(scorer?.points).toBeLessThan(9);

    expect(d.players.find((p) => p.playerId === subOn)).toMatchObject({ minutes: 3, points: 1 });
    expect(d.players.map((p) => p.playerId)).not.toContain(benched);
  });

  it('a live sheet updates: calls 31 s apart refetch fixtures and live (30 s TTL)', async () => {
    let clock = NOW;
    let state = liveAt55().data;
    const requests: string[] = [];
    const service = createFplService({
      fetch: createReplayFetch(
        (path, query) => {
          if (path === 'bootstrap-static/') return state.bootstrap;
          if (path === 'fixtures/' && query.get('event') === '9') return state.fixtures;
          if (path === 'event/9/live/') return state.live;
          return undefined;
        },
        { onRequest: (k) => requests.push(k) },
      ),
      now: () => clock,
    });

    const first = await service.getFixtureDetail(fid(81));
    expect(first.fixture.minutes).toBe(55);

    // FPL moves on to 90+ (the recorded final state, bonus written in).
    state = clone();
    clock += 10_000;
    expect((await service.getFixtureDetail(fid(81))).fixture.minutes).toBe(55); // still cached
    clock += 21_000; // 31 s after the first call
    const second = await service.getFixtureDetail(fid(81));

    expect(requests.filter((r) => r === 'fixtures/?event=9')).toHaveLength(2);
    expect(requests.filter((r) => r === 'event/9/live/')).toHaveLength(2);
    expect(second.fixture).toMatchObject({ status: 'finished_provisional', minutes: 90, teamAScore: 1 });
    expect(second.stats.map((s) => s.id)).toContain('bonus');
    expect(second.players.find((p) => p.playerId === 166)?.points).toBe(9);
    expect(second.updatedAt).toBe(new Date(NOW + 31_000).toISOString());
  });
});
