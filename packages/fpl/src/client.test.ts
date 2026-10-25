import {
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  FplEntryIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  PlayerLiveSchema,
} from '@fant/shared';
import { describe, expect, it } from 'vitest';
import {
  rawBootstrap,
  rawEvent,
  rawFixture,
  rawLiveElement,
  rawPicks,
  SQUAD_IDS,
  standardSquad,
} from './__fixtures__/mini.js';
import { createFplService } from './client.js';
import { createReplayFetch, replayStatus, type ReplayRoutes } from './replay.js';
import { FplNotFoundError, FplUnavailableError } from './service.js';

const gw = GameweekSchema.parse(1);
const entry = (n: number) => FplEntryIdSchema.parse(n);
const league = FplLeagueIdSchema.parse(5);

function rawEntry(id: number) {
  return {
    id,
    name: `Team ${id}`,
    player_first_name: 'Dor',
    player_last_name: 'Cohen',
    player_region_name: 'Israel',
    summary_overall_points: 130,
    summary_overall_rank: 12345,
    summary_event_points: 10,
    current_event: 1,
    last_deadline_bank: 5,
    last_deadline_value: 1003,
    leagues: { classic: [], h2h: [] },
    kit: null,
  };
}

const standingsRow = (entryId: number, rank: number, total: number, eventTotal: number) => ({
  id: entryId * 10,
  entry: entryId,
  entry_name: `Team ${entryId}`,
  player_name: `Manager ${entryId}`,
  rank,
  last_rank: rank,
  rank_sort: rank,
  total,
  event_total: eventTotal,
  has_played: true,
});

/** Everybody 90 min / 2 pts except player 6 (8 pts); team 1 vs team 2 still live. */
function baseRoutes(): Record<string, unknown> {
  return {
    'bootstrap-static/': rawBootstrap(standardSquad(), [rawEvent(1, { current: true }), rawEvent(2)]),
    'fixtures/?event=1': [
      rawFixture({
        id: 1,
        h: 1,
        a: 2,
        status: 'live',
        bps: [
          [6, 30],
          [7, 20],
          [8, 10],
        ],
      }),
    ],
    'fixtures/': [
      rawFixture({ id: 1, h: 1, a: 2, status: 'live' }),
      rawFixture({ id: 2, h: 3, a: 4, status: 'not_started', event: 2 }),
      rawFixture({ id: 3, h: 5, a: 6, status: 'finished_provisional', event: 2 }),
      rawFixture({ id: 4, h: 7, a: 8, status: 'finished', event: 2 }),
    ],
    'event/1/live/': {
      elements: SQUAD_IDS.map((id) =>
        rawLiveElement(id, id === 6 ? { minutes: 60, points: 8 } : { minutes: 60, points: 2 }),
      ),
    },
    // A: before GW 120, FPL partial 10 → total 130. B: before 110, partial 4 − 4 hit → 110.
    'entry/11/event/1/picks/': rawPicks(SQUAD_IDS, { captain: 1, vice: 2, points: 10, total: 130 }),
    'entry/22/event/1/picks/': rawPicks(SQUAD_IDS, { captain: 6, vice: 7, points: 4, total: 110, cost: 4 }),
    'entry/11/': rawEntry(11),
    'entry/11/history/': {
      current: [rawPicks([]).entry_history],
      past: [],
      chips: [
        { name: 'wildcard', event: 1, time: '2025-08-15T10:00:00Z' },
        { name: 'some_future_chip', event: 1, time: '2025-08-15T10:00:00Z' },
      ],
    },
    'leagues-classic/5/standings/?page_standings=1': {
      new_entries: { has_next: false, page: 1, results: [] },
      league: { id: 5, name: 'Test League', created: '2025-07-01T00:00:00Z' },
      standings: {
        has_next: true,
        page: 1,
        results: [standingsRow(11, 1, 130, 10), standingsRow(22, 2, 110, 0), standingsRow(33, 3, 90, 5)],
      },
    },
  };
}

function setup(routes: ReplayRoutes = baseRoutes(), clock = { t: Date.UTC(2025, 9, 11, 15) }) {
  const calls: string[] = [];
  const fetch = createReplayFetch(routes, { onRequest: (k) => calls.push(k) });
  const service = createFplService({ fetch, now: () => clock.t });
  return { service, calls, clock };
}

describe('createFplService — mapping to @fant/shared DTOs', () => {
  it('getBootstrap', async () => {
    const { service } = setup();
    const b = await service.getBootstrap();
    expect(() => BootstrapSchema.parse(b)).not.toThrow();
    expect(b.currentEvent).toBe(1);
    expect(b.players).toHaveLength(15);
    expect(b.players[0]).toMatchObject({
      photoCode: '100001',
      selectedByPercent: 10.5,
      form: 3,
      position: 'GKP',
    });
    expect(b.fetchedAt).toBe('2025-10-11T15:00:00.000Z');
  });

  it('getFixtures maps all four statuses', async () => {
    const { service } = setup();
    const all = await service.getFixtures();
    for (const f of all) expect(() => FixtureSchema.parse(f)).not.toThrow();
    expect(all.map((f) => f.status)).toEqual(['live', 'not_started', 'finished_provisional', 'finished']);
    expect(await service.getFixtures(gw)).toHaveLength(1);
  });

  it('getEntry and FplNotFoundError for an unknown team', async () => {
    const { service } = setup();
    const e = await service.getEntry(entry(11));
    expect(() => EntrySummarySchema.parse(e)).not.toThrow();
    expect(e).toMatchObject({ managerName: 'Dor Cohen', teamName: 'Team 11', overallPoints: 130, bank: 5 });
    await expect(service.getEntry(entry(999))).rejects.toBeInstanceOf(FplNotFoundError);
  });

  it('getEntryPicks: points net of the hit, known chips only', async () => {
    const routes = baseRoutes();
    routes['entry/11/event/1/picks/'] = rawPicks(SQUAD_IDS, { points: 30, total: 130, cost: 4 });
    const { service } = setup(routes);
    const picks = await service.getEntryPicks(entry(11), gw);
    expect(() => EntryPicksSchema.parse(picks)).not.toThrow();
    expect(picks).toMatchObject({ points: 26, transfersCost: 4, activeChip: null });
    expect(picks.chipsUsed).toEqual([{ chip: 'wildcard', event: 1 }]);
    expect(picks.picks).toHaveLength(15);
  });

  it('getEntryLive: engine result + liveTotal = total before GW + live points', async () => {
    const { service } = setup();
    const live = await service.getEntryLive(entry(22), gw);
    expect(() => EntryLiveSchema.parse(live)).not.toThrow();
    // XI 10 × 2 + captain 6: (8 + 3 provisional bonus) × 2 = 22; 7 +2, 8 +1 bonus; −4 hit
    expect(live.livePoints).toBe(20 + 22 + 2 + 1 - 4);
    // before GW = 110 − 4 + 4 = 110
    expect(live.liveTotal).toBe(110 + live.livePoints);
    expect(live.transfersCost).toBe(4);
  });

  it('getPlayersLive', async () => {
    const { service } = setup();
    const rows = await service.getPlayersLive([FplPlayerIdSchema.parse(6), FplPlayerIdSchema.parse(99)], gw);
    for (const r of rows) expect(() => PlayerLiveSchema.parse(r)).not.toThrow();
    expect(rows[0]).toMatchObject({
      basePoints: 11,
      provisionalBonus: 3,
      minutes: 60,
      fixtureStatus: 'live',
    });
    expect(rows[1]).toMatchObject({ basePoints: 0, fixtureStatus: 'no_fixture' });
  });

  it('getLeagueStandings', async () => {
    const { service } = setup();
    const s = await service.getLeagueStandings(league, 1);
    expect(() => LeagueStandingsSchema.parse(s)).not.toThrow();
    expect(s).toMatchObject({ league: { id: 5, name: 'Test League' }, page: 1, hasNext: true });
    expect(s.rows[1]).toMatchObject({ entryId: 22, total: 110, eventTotal: 0, rank: 2 });
  });

  it('getLiveLeague re-ranks by liveTotal without double counting the in-progress GW', async () => {
    const { service } = setup();
    const ll = await service.getLiveLeague(league, gw, 1);
    expect(() => LiveLeagueSchema.parse(ll)).not.toThrow();
    const a = ll.rows.find((r) => r.entryId === 11);
    const b = ll.rows.find((r) => r.entryId === 22);
    const c = ll.rows.find((r) => r.entryId === 33);
    // A's XI: 11 × 2 = 22, captain 1 extra 2, player 6 +6 (8 pts) +3 bonus, 7 +2, 8 +1 → 36
    expect(a).toMatchObject({ livePoints: 36, liveTotal: 120 + 36, officialRank: 1, captainPlayerId: 1 });
    // B: 45 − 4 = 41 (see getEntryLive test), before GW 110
    expect(b).toMatchObject({ livePoints: 41, liveTotal: 110 + 41, officialRank: 2, captainPlayerId: 6 });
    // C has no picks (404): livePoints 0, liveTotal = total − event_total
    expect(c).toMatchObject({ livePoints: 0, liveTotal: 85, captainPlayerId: null, activeChip: null });
    expect(ll.rows.map((r) => [r.entryId, r.liveRank])).toEqual([
      [11, 1],
      [22, 2],
      [33, 3],
    ]);
    expect(ll.hasNext).toBe(true);
  });

  it('getLiveLeague: overtakes re-order rows and equal live totals share a rank', async () => {
    const routes = baseRoutes();
    // Make B's pre-GW total 10 higher than A's after live points: 156 vs 166.
    routes['entry/22/event/1/picks/'] = rawPicks(SQUAD_IDS, {
      captain: 6,
      vice: 7,
      points: 4,
      total: 125,
      cost: 4,
    });
    // C ends level with A: no picks, total − event_total = 156.
    const standings = routes['leagues-classic/5/standings/?page_standings=1'] as {
      standings: { results: ReturnType<typeof standingsRow>[] };
    };
    standings.standings.results[2] = standingsRow(33, 3, 160, 4);
    const { service } = setup(routes);
    const ll = await service.getLiveLeague(league, gw, 1);
    expect(ll.rows.map((r) => [r.entryId, r.liveTotal, r.liveRank])).toEqual([
      [22, 166, 1],
      [11, 156, 2],
      [33, 156, 2],
    ]);
  });
});

describe('createFplService — errors', () => {
  it.each([503, 429, 500])('HTTP %i → FplUnavailableError', async (status) => {
    const { service } = setup({ 'bootstrap-static/': replayStatus(status) });
    const err = await service.getBootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FplUnavailableError);
    expect((err as FplUnavailableError).status).toBe(status);
  });

  it('network error → FplUnavailableError(status null)', async () => {
    const service = createFplService({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const err = await service.getBootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FplUnavailableError);
    expect((err as FplUnavailableError).status).toBeNull();
  });

  it('200 with "The game is being updated." text → FplUnavailableError', async () => {
    const service = createFplService({
      fetch: () => Promise.resolve(new Response('The game is being updated.', { status: 200 })),
    });
    await expect(service.getBootstrap()).rejects.toBeInstanceOf(FplUnavailableError);
  });

  it('unexpected shape → FplUnavailableError', async () => {
    const { service } = setup({ 'bootstrap-static/': { events: 'nope' } });
    await expect(service.getBootstrap()).rejects.toBeInstanceOf(FplUnavailableError);
  });

  it('404 → FplNotFoundError (league)', async () => {
    const { service } = setup();
    await expect(service.getLeagueStandings(FplLeagueIdSchema.parse(77), 1)).rejects.toBeInstanceOf(
      FplNotFoundError,
    );
  });

  it('sends a User-Agent and hits the configured base URL', async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const replay = createReplayFetch(baseRoutes());
    const service = createFplService({
      baseUrl: 'https://fantasy.premierleague.com/api/',
      userAgent: 'TestAgent/1',
      fetch: (input, init) => {
        seen.push({ url: String(input), ua: new Headers(init?.headers).get('User-Agent') });
        return replay(input, init);
      },
    });
    await service.getBootstrap();
    expect(seen).toEqual([
      { url: 'https://fantasy.premierleague.com/api/bootstrap-static/', ua: 'TestAgent/1' },
    ]);
  });
});

describe('createFplService — caching', () => {
  it('serves from cache within the TTL and refetches after it', async () => {
    const { service, calls, clock } = setup();
    await service.getBootstrap();
    clock.t += 4 * 60_000;
    await service.getBootstrap();
    expect(calls.filter((c) => c === 'bootstrap-static/')).toHaveLength(1);
    clock.t += 2 * 60_000; // > 5 min since fetch
    await service.getBootstrap();
    expect(calls.filter((c) => c === 'bootstrap-static/')).toHaveLength(2);
  });

  it('de-duplicates concurrent identical requests', async () => {
    const { service, calls } = setup();
    await Promise.all([service.getBootstrap(), service.getBootstrap(), service.getBootstrap()]);
    expect(calls.filter((c) => c === 'bootstrap-static/')).toHaveLength(1);
  });

  it('live data expires after ~30 s, picks stay cached for the GW', async () => {
    const { service, calls, clock } = setup();
    await service.getEntryLive(entry(11), gw);
    clock.t += 31_000;
    await service.getEntryLive(entry(11), gw);
    expect(calls.filter((c) => c === 'event/1/live/')).toHaveLength(2);
    expect(calls.filter((c) => c === 'entry/11/event/1/picks/')).toHaveLength(1);
  });

  it('a live league page fetches shared GW data once', async () => {
    const { service, calls } = setup();
    await service.getLiveLeague(league, gw, 1);
    expect(calls.filter((c) => c === 'event/1/live/')).toHaveLength(1);
    expect(calls.filter((c) => c === 'bootstrap-static/')).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith('/picks/'))).toHaveLength(3);
  });

  it('serves the stale value while FPL answers 503', async () => {
    let down = false;
    const routes = baseRoutes();
    const { service, clock } = setup((path, query) => {
      if (down) return replayStatus(503);
      const key = query.size > 0 ? `${path}?${query.toString()}` : path;
      return routes[key];
    });
    const first = await service.getBootstrap();
    down = true;
    clock.t += 10 * 60_000;
    expect(await service.getBootstrap()).toBe(first);
  });

  it('limits concurrent requests when building a live league', async () => {
    const results = Array.from({ length: 50 }, (_, i) => standingsRow(100 + i, i + 1, 100, 0));
    const routes = baseRoutes();
    routes['leagues-classic/5/standings/?page_standings=1'] = {
      league: { id: 5, name: 'Big' },
      standings: { has_next: false, page: 1, results },
    };
    for (const r of results) routes[`entry/${r.entry}/event/1/picks/`] = rawPicks(SQUAD_IDS);
    const replay = createReplayFetch(routes);
    let inFlight = 0;
    let peak = 0;
    const service = createFplService({
      fetch: async (input, init) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        try {
          return await replay(input, init);
        } finally {
          inFlight--;
        }
      },
    });
    const ll = await service.getLiveLeague(league, gw, 1);
    expect(ll.rows).toHaveLength(50);
    expect(peak).toBe(6); // shared GW requests (4) finish before the picks fan-out starts
  });
});
