import {
  FplEntryIdSchema,
  FplFixtureIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
} from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { REAL_GW9_FIXTURE81 } from './__fixtures__/real-gw9-fixture81.js';
import {
  rawBootstrap,
  rawEvent,
  rawFixture,
  rawLiveElement,
  rawPicks,
  SQUAD_IDS,
  standardSquad,
} from './__fixtures__/mini.js';
import { LruMap, TtlCache } from './cache.js';
import { createFplService, type CreateFplServiceExtras } from './client.js';
import { buildDemoDataset, createDemoFplService, DEMO_LEAGUE_ID, demoRoutes } from './demo/index.js';
import { fixtureLinesOf } from './normalize.js';
import { RawLiveSchema } from './raw.js';
import { createReplayFetch, replayStatus } from './replay.js';
import { FplNotFoundError, FplUnavailableError } from './service.js';

/**
 * Load/robustness behaviour of createFplService: in-flight de-duplication, refresh-ahead, stale-on-error,
 * backoff + FPL's update window, LRU bounds, and the memoized per-GW maps staying correct.
 */

const gw = GameweekSchema.parse(1);
const entry = (n: number) => FplEntryIdSchema.parse(n);
const league = FplLeagueIdSchema.parse(5);
const T0 = Date.UTC(2025, 9, 11, 15);

const standingsRow = (entryId: number, rank: number, total: number, eventTotal: number) => ({
  entry: entryId,
  entry_name: `Team ${entryId}`,
  player_name: `Manager ${entryId}`,
  rank,
  last_rank: rank,
  total,
  event_total: eventTotal,
});

function liveWith(points: number) {
  return { elements: SQUAD_IDS.map((id) => rawLiveElement(id, { minutes: 60, points })) };
}

function routes(): Record<string, unknown> {
  return {
    'bootstrap-static/': rawBootstrap(standardSquad(), [rawEvent(1, { current: true }), rawEvent(2)]),
    'fixtures/?event=1': [rawFixture({ id: 1, h: 1, a: 2, status: 'live' })],
    'fixtures/': [rawFixture({ id: 1, h: 1, a: 2, status: 'live' })],
    'event/1/live/': liveWith(2),
    'entry/11/': {
      id: 11,
      name: 'Team 11',
      player_first_name: 'Dor',
      player_last_name: 'Cohen',
      summary_overall_points: 1,
      summary_overall_rank: 1,
      summary_event_points: 1,
      current_event: 1,
    },
    'entry/11/history/': { current: [], chips: [] },
    'entry/11/event/1/picks/': rawPicks(SQUAD_IDS, { captain: 1, vice: 2, points: 10, total: 130 }),
    'entry/22/event/1/picks/': rawPicks(SQUAD_IDS, { captain: 6, vice: 7, points: 4, total: 110 }),
    'entry/33/event/1/picks/': rawPicks(SQUAD_IDS, { captain: 3, vice: 4, points: 4, total: 90 }),
    'leagues-classic/5/standings/?page_standings=1': {
      league: { id: 5, name: 'Test League' },
      standings: {
        has_next: false,
        page: 1,
        results: [standingsRow(11, 1, 130, 10), standingsRow(22, 2, 110, 4), standingsRow(33, 3, 90, 4)],
      },
    },
  };
}

/** A replay fetch over a mutable route table, with a per-request delay and a request log. */
function harness(
  table: Record<string, unknown> = routes(),
  extras: CreateFplServiceExtras & { delayMs?: number } = {},
) {
  const clock = { t: T0 };
  const calls: string[] = [];
  const replay = createReplayFetch((path, query) => {
    const key = query.size > 0 ? `${path}?${query.toString()}` : path;
    return table[key] ?? table[path];
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname.replace(/^\/api\//, '') + url.search);
    if (extras.delayMs) await new Promise((r) => setTimeout(r, extras.delayMs));
    return replay(input, init);
  }) as typeof globalThis.fetch;
  const service = createFplService({ fetch, now: () => clock.t, ...extras });
  const count = (path: string) => calls.filter((c) => c === path).length;
  return { service, table, clock, calls, count };
}

/** Lets background refreshes (fetch → body → parse → store) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('in-flight de-duplication', () => {
  it('50 simultaneous identical calls → 1 fetch per FPL resource, for every method', async () => {
    const { service, count } = harness(routes(), { delayMs: 5 });
    const fifty = <T>(fn: () => Promise<T>) => Promise.all(Array.from({ length: 50 }, fn));

    const [boots] = await Promise.all([
      fifty(() => service.getBootstrap()),
      fifty(() => service.getFixtures(gw)),
      fifty(() => service.getEntry(entry(11))),
      fifty(() => service.getEntryPicks(entry(11), gw)),
      fifty(() => service.getEntryLive(entry(22), gw)),
      fifty(() => service.getLeagueStandings(league, 1)),
      fifty(() => service.getPlayersLive([FplPlayerIdSchema.parse(6)], gw)),
      fifty(() => service.getFixtureDetail(FplFixtureIdSchema.parse(1))),
    ]);
    const pages = await fifty(() => service.getLiveLeague(league, gw, 1));

    for (const path of [
      'bootstrap-static/',
      'fixtures/?event=1',
      'event/1/live/',
      'entry/11/',
      'entry/11/history/',
      'entry/11/event/1/picks/',
      'entry/22/event/1/picks/',
      'entry/33/event/1/picks/',
      'leagues-classic/5/standings/?page_standings=1',
    ])
      expect(count(path), path).toBe(1);
    // Everyone got the same normalized object (normalized once, never cloned).
    expect(new Set(boots).size).toBe(1);
    expect(new Set(pages).size).toBe(1);
  });

  it('50 cold live league requests share one page build', async () => {
    const { service, count } = harness(routes(), { delayMs: 2 });
    const pages = await Promise.all(Array.from({ length: 50 }, () => service.getLiveLeague(league, gw, 1)));
    expect(new Set(pages).size).toBe(1);
    expect(count('entry/22/event/1/picks/')).toBe(1);
    expect(count('event/1/live/')).toBe(1);
  });
});

describe('stale-while-revalidate (refresh-ahead)', () => {
  it('serves the cached value immediately past 85% of the TTL and refreshes once in the background', async () => {
    const { service, table, clock, count } = harness();
    const first = await service.getEntryLive(entry(11), gw);
    table['event/1/live/'] = liveWith(5);

    clock.t += 26_000; // > 0.85 × 30 s, < 30 s
    const [a, b] = await Promise.all([
      service.getEntryLive(entry(11), gw),
      service.getEntryLive(entry(11), gw),
    ]);
    expect(a).toBe(first); // served from cache, no waiting
    expect(b).toBe(first);
    expect(count('event/1/live/')).toBe(2); // one background refresh for both readers

    await settle();
    const refreshed = await service.getEntryLive(entry(11), gw);
    expect(refreshed.livePoints).toBeGreaterThan(first.livePoints);
    expect(refreshed.updatedAt).toBe(new Date(T0 + 26_000).toISOString());
    expect(count('event/1/live/')).toBe(2);
  });

  it('within 85% of the TTL nothing is refetched', async () => {
    const { service, clock, count } = harness();
    await service.getEntryLive(entry(11), gw);
    clock.t += 20_000;
    await service.getEntryLive(entry(11), gw);
    await settle();
    expect(count('event/1/live/')).toBe(1);
  });
});

describe('stale on error', () => {
  it('live: serves the last good data up to 2 min old on an FPL error, then fails', async () => {
    const { service, table, clock } = harness();
    const good = await service.getEntryLive(entry(11), gw);
    table['event/1/live/'] = replayStatus(500);

    clock.t += 31_000;
    expect(await service.getEntryLive(entry(11), gw)).toEqual(good); // fixtures refreshed, live stale
    clock.t += 80_000; // 111 s old
    const stale = await service.getEntryLive(entry(11), gw);
    expect(stale).toEqual(good);
    expect(stale.updatedAt).toBe(new Date(T0).toISOString()); // the age of the live data served

    clock.t += 10_000; // 121 s old
    await expect(service.getEntryLive(entry(11), gw)).rejects.toBeInstanceOf(FplUnavailableError);
  });

  it('a 404 is not hidden by stale data', async () => {
    const { service, table, clock } = harness();
    await service.getEntry(entry(11));
    delete table['entry/11/'];
    clock.t += 6 * 60_000;
    await expect(service.getEntry(entry(11))).rejects.toBeInstanceOf(FplNotFoundError);
  });
});

describe("backoff and FPL's update window", () => {
  it('503 "being updated": keeps serving last good data (beyond 2 min), health says updating/stale', async () => {
    const { service, table, clock, count } = harness();
    const good = await service.getLiveLeague(league, gw, 1);
    expect(service.getHealth?.()).toMatchObject({ state: 'ok', stale: false, lastError: null });

    // The update window: every endpoint answers 503.
    const saved = { ...table };
    for (const key of Object.keys(table)) table[key] = replayStatus(503, 'The game is being updated.');
    clock.t += 31_000;
    expect(await service.getLiveLeague(league, gw, 1)).toBe(good);
    const health = service.getHealth?.();
    expect(health).toMatchObject({ state: 'updating', stale: true });
    expect(health?.lastError).toMatchObject({ kind: 'updating', status: 503 });
    expect(health?.retryAt).not.toBeNull();

    // 45 minutes into the update window: still the last good data, and FPL is polled sparingly.
    const before = count('event/1/live/');
    for (let i = 0; i < 90; i++) {
      clock.t += 30_000;
      expect(await service.getLiveLeague(league, gw, 1)).toBe(good);
    }
    expect(count('event/1/live/') - before).toBeLessThan(40); // backoff (≤ 2 min apart), not every 30 s

    // FPL is back.
    Object.assign(table, saved, { 'event/1/live/': liveWith(5) });
    clock.t += 3 * 60_000;
    const fresh = await service.getLiveLeague(league, gw, 1);
    expect(fresh).not.toBe(good);
    expect(fresh.updatedAt).toBe(new Date(clock.t).toISOString());
    expect(service.getHealth?.()).toMatchObject({ state: 'ok', stale: false, retryAt: null });
  });

  it('a 200 "The game is being updated." text body counts as the update window', async () => {
    const clock = { t: T0 };
    let updating = false;
    const replay = createReplayFetch(routes());
    const service = createFplService({
      now: () => clock.t,
      fetch: (input, init) =>
        updating
          ? Promise.resolve(new Response('The game is being updated.', { status: 200 }))
          : replay(input, init),
    });
    const good = await service.getBootstrap();
    updating = true;
    clock.t += 2 * 60 * 60_000; // 2 h: far past bootstrap's normal 1 h stale-on-error window
    expect(await service.getBootstrap()).toBe(good);
    expect(service.getHealth?.()).toMatchObject({ state: 'updating', stale: true });
    expect(service.getHealth?.().lastError).toMatchObject({ kind: 'updating', status: 200 });

    // Without any cached value the error surfaces, typed.
    const cold = createFplService({
      fetch: () => Promise.resolve(new Response('The game is being updated.', { status: 200 })),
    });
    const err = await cold.getBootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FplUnavailableError);
    expect((err as FplUnavailableError).kind).toBe('updating');
  });

  it('a non-update error (500) is served stale only within the normal window', async () => {
    const clock = { t: T0 };
    let down = false;
    const replay = createReplayFetch(routes());
    const service = createFplService({
      now: () => clock.t,
      fetch: (input, init) =>
        down ? Promise.resolve(new Response('', { status: 500 })) : replay(input, init),
    });
    const good = await service.getBootstrap();
    down = true;
    clock.t += 50 * 60_000;
    expect(await service.getBootstrap()).toBe(good);
    clock.t += 15 * 60_000; // 65 min > bootstrap's 1 h
    await expect(service.getBootstrap()).rejects.toBeInstanceOf(FplUnavailableError);
  });

  it('429: no FPL call until the backoff (≥ Retry-After) has passed; fails fast without stale data', async () => {
    let calls = 0;
    let status = 429;
    const clock = { t: T0 };
    const replay = createReplayFetch(routes());
    const service = createFplService({
      now: () => clock.t,
      fetch: async (input, init) => {
        calls++;
        if (status !== 200) return new Response('', { status, headers: { 'retry-after': '30' } });
        return replay(input, init);
      },
    });

    const first = await service.getEntry(entry(11)).catch((e: unknown) => e);
    expect(first).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 30_000 });
    expect(calls).toBe(1);

    clock.t += 10_000;
    const fast = await service.getBootstrap().catch((e: unknown) => e);
    expect(fast).toBeInstanceOf(FplUnavailableError);
    expect((fast as FplUnavailableError).kind).toBe('backoff');
    expect(calls).toBe(1); // nothing sent while backing off
    expect(service.getHealth?.()).toMatchObject({ state: 'degraded', stale: true });

    status = 200;
    clock.t += 21_000; // 31 s after the 429
    await expect(service.getBootstrap()).resolves.toBeDefined();
    expect(calls).toBe(2);
    expect(service.getHealth?.().state).toBe('ok');
  });

  it('backoff doubles per consecutive failure, capped', async () => {
    const clock = { t: T0 };
    let calls = 0;
    const service = createFplService({
      now: () => clock.t,
      fetch: async () => {
        calls++;
        return new Response('', { status: 502 });
      },
      resilience: { backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
    });
    const attempt = () => service.getBootstrap().catch(() => undefined);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await attempt();
      const retryAt = Date.parse(service.getHealth?.().retryAt ?? '');
      waits.push(retryAt - clock.t);
      clock.t = retryAt;
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
    expect(calls).toBe(5);
  });

  it('a live league page with a transient per-manager failure is not memoized', async () => {
    const { service, table, clock } = harness();
    table['entry/22/event/1/picks/'] = replayStatus(500);
    const degraded = await service.getLiveLeague(league, gw, 1);
    expect(degraded.rows.find((r) => r.entryId === 22)).toMatchObject({ captainPlayerId: null });

    table['entry/22/event/1/picks/'] = routes()['entry/22/event/1/picks/'];
    clock.t += 1_000;
    const healed = await service.getLiveLeague(league, gw, 1);
    expect(healed.rows.find((r) => r.entryId === 22)).toMatchObject({ captainPlayerId: 6 });
  });
});

describe('bounded memory (LRU)', () => {
  it('TtlCache evicts the least recently used key; a hit refreshes recency', async () => {
    const cache = new TtlCache({ now: () => 0, maxEntries: 2 });
    const load = (v: string) => () => Promise.resolve(v);
    await cache.get('a', 1000, load('a'));
    await cache.get('b', 1000, load('b'));
    await cache.get('a', 1000, load('a2')); // hit → a is now most recent
    await cache.get('c', 1000, load('c')); // evicts b
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).toEqual([true, false, true]);
    expect(cache.size).toBe(2);
    expect(await cache.get('a', 1000, load('a3'))).toBe('a');
  });

  it('LruMap', () => {
    const m = new LruMap<string, number>(2);
    m.set('x', 1);
    m.set('y', 2);
    m.get('x');
    m.set('z', 3);
    expect([m.get('x'), m.get('y'), m.get('z'), m.size]).toEqual([1, undefined, 3, 2]);
  });

  it('per-entry picks cache is capped: the evicted entry is refetched', async () => {
    const { service, count } = harness(routes(), { cacheLimits: { picks: 2 } });
    await service.getEntryLive(entry(11), gw);
    await service.getEntryLive(entry(22), gw);
    await service.getEntryLive(entry(33), gw); // evicts 11
    await service.getEntryLive(entry(33), gw);
    await service.getEntryLive(entry(22), gw);
    expect(count('entry/22/event/1/picks/')).toBe(1);
    await service.getEntryLive(entry(11), gw);
    expect(count('entry/11/event/1/picks/')).toBe(2);
  });

  it('a 404 for picks is remembered for a minute, then retried', async () => {
    const table = routes();
    delete table['entry/33/event/1/picks/'];
    const { service, clock, count } = harness(table);
    const first = await service.getLiveLeague(league, gw, 1);
    expect(first.rows.find((r) => r.entryId === 33)).toMatchObject({ livePoints: 0, liveTotal: 86 });
    clock.t += 31_000; // live expires → page rebuilt
    await service.getLiveLeague(league, gw, 1);
    expect(count('entry/33/event/1/picks/')).toBe(1);
    clock.t += 31_000;
    await service.getLiveLeague(league, gw, 1);
    expect(count('entry/33/event/1/picks/')).toBe(2);
  });
});

describe('memoized maps stay correct', () => {
  it('fixtureLinesOf (one pass) = per-fixture explain scan, on real GW9 data', () => {
    const live = RawLiveSchema.parse(REAL_GW9_FIXTURE81.live);
    const index = fixtureLinesOf(live);
    const fixtureIds = new Set(live.elements.flatMap((e) => e.explain.map((x) => x.fixture)));
    expect(fixtureIds.size).toBeGreaterThan(0);
    for (const fixtureId of fixtureIds) {
      const naive = live.elements
        .map((el) => {
          const entries = el.explain.filter((x) => x.fixture === fixtureId);
          if (entries.length === 0) return null;
          const stats = entries.flatMap((x) => x.stats);
          return {
            playerId: el.id,
            minutes: stats.filter((s) => s.identifier === 'minutes').reduce((a, s) => a + s.value, 0),
            points: stats.reduce((a, s) => a + s.points, 0),
          };
        })
        .filter((x) => x !== null);
      expect(index.get(fixtureId), `fixture ${fixtureId}`).toEqual(naive);
    }
  });

  it('warm (memoized) results equal a fresh service, for every demo manager and page', async () => {
    const NOW = Date.UTC(2026, 9, 25, 15, 30);
    const warm = createDemoFplService({ now: () => NOW });
    const leagueId = FplLeagueIdSchema.parse(DEMO_LEAGUE_ID);
    const gw9 = GameweekSchema.parse(9);
    const data = buildDemoDataset({ anchorMs: NOW });
    // Prime: pages, then every entry, then again (memo hits).
    for (let pass = 0; pass < 2; pass++) {
      for (const page of [1, 2]) await warm.getLiveLeague(leagueId, gw9, page);
      for (const id of data.entryIds) await warm.getEntryLive(entry(id), gw9);
    }
    for (const id of data.entryIds) {
      const fresh = createFplService({ fetch: createReplayFetch(demoRoutes(data)), now: () => NOW });
      expect(await warm.getEntryLive(entry(id), gw9)).toEqual(await fresh.getEntryLive(entry(id), gw9));
    }
    const fresh = createFplService({ fetch: createReplayFetch(demoRoutes(data)), now: () => NOW });
    for (const page of [1, 2])
      expect(await warm.getLiveLeague(leagueId, gw9, page)).toEqual(
        await fresh.getLiveLeague(leagueId, gw9, page),
      );
  });

  it('new live data invalidates every memo: entry live, live league, players live, fixture detail', async () => {
    const { service, table, clock } = harness();
    const fid = FplFixtureIdSchema.parse(1);
    const p6 = [FplPlayerIdSchema.parse(6)];
    const before = {
      entry: await service.getEntryLive(entry(11), gw),
      page: await service.getLiveLeague(league, gw, 1),
      player: await service.getPlayersLive(p6, gw),
      detail: await service.getFixtureDetail(fid),
    };
    // Warm calls return the very same objects.
    expect(await service.getEntryLive(entry(11), gw)).toBe(before.entry);
    expect(await service.getLiveLeague(league, gw, 1)).toBe(before.page);
    expect((await service.getPlayersLive(p6, gw))[0]).toBe(before.player[0]);
    expect(await service.getFixtureDetail(fid)).toBe(before.detail);

    table['event/1/live/'] = liveWith(5);
    clock.t += 31_000;
    const entryAfter = await service.getEntryLive(entry(11), gw);
    const pageAfter = await service.getLiveLeague(league, gw, 1);
    const playerAfter = await service.getPlayersLive(p6, gw);
    // 11 starters × 3 more points, captain doubled → +36.
    expect(entryAfter.livePoints - before.entry.livePoints).toBe(36);
    expect(pageAfter.rows.find((r) => r.entryId === 11)?.livePoints).toBe(entryAfter.livePoints);
    expect((playerAfter[0]?.basePoints ?? 0) - (before.player[0]?.basePoints ?? 0)).toBe(3);
    expect(pageAfter.updatedAt).toBe(new Date(clock.t).toISOString());
    expect(await service.getFixtureDetail(fid)).not.toBe(before.detail);
  });
});
