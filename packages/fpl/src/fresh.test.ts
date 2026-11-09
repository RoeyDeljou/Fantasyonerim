import { FplEntryIdSchema, FplLeagueIdSchema, GameweekSchema, type EntryPicks } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { REAL_4611_GW10 } from './__fixtures__/real-4611-gw10.js';
import { createFplService, FPL_CACHE_TTL } from './client.js';
import { createReplayFetch, replayStatus } from './replay.js';
import { FplNotFoundError, FplUnavailableError, type FplService } from './service.js';

/**
 * `fresh` reads and the official-picks cache key. Real recorded data of entry 2900498 in GW10: FPL's final
 * picks have captain ×0 / vice ×2 (the captain played 0 minutes). During the GW FPL served ×2 / ×1.
 */

const ID = 2900498;
const entry = FplEntryIdSchema.parse(ID);
const gw10 = GameweekSchema.parse(10);
const league = FplLeagueIdSchema.parse(4611);
const REAL = REAL_4611_GW10;
const detail = (REAL.detail as Record<string, { picks: unknown; history: unknown; transfers: unknown }>)[
  String(ID)
] as { picks: { picks: { is_captain: boolean; is_vice_captain: boolean; multiplier: number }[] } };
const finalPicks = detail.picks;
const livePicks = (() => {
  const copy = JSON.parse(JSON.stringify(finalPicks)) as typeof finalPicks & { automatic_subs: unknown[] };
  for (const p of copy.picks) {
    if (p.is_captain) p.multiplier = 2;
    else if (p.is_vice_captain) p.multiplier = 1;
  }
  copy.automatic_subs = [];
  return copy;
})();

const armband = (picks: EntryPicks) => [
  picks.picks.find((p) => p.isCaptain)?.multiplier,
  picks.picks.find((p) => p.isViceCaptain)?.multiplier,
];

function setup() {
  const state = {
    t: Date.parse('2026-11-08T18:00:00Z'),
    /** GW10 finished + data-checked in bootstrap. */
    official: false,
    /** FPL has rewritten the picks (auto-subs / vice). */
    finalPicks: false,
    /** Paths answering 503. */
    down: new Set<string>(),
    calls: [] as string[],
    history: (REAL.detail as Record<string, { history: unknown }>)[String(ID)]?.history,
  };
  const fetch = createReplayFetch(
    (path) => {
      if (state.down.has(path)) return replayStatus(503);
      if (path === 'bootstrap-static/') {
        const events = REAL.bootstrapEvents.map((e) =>
          e.id === 10 ? { ...e, finished: state.official, data_checked: state.official } : e,
        );
        return { events, teams: [], elements: [] };
      }
      if (path === 'fixtures/') return [];
      if (path === 'event/10/live/') return REAL.live;
      if (path === `entry/${ID}/history/`) return state.history;
      if (path === `entry/${ID}/transfers/`)
        return (REAL.detail as Record<string, { transfers: unknown }>)[String(ID)]?.transfers;
      if (path === `entry/${ID}/event/10/picks/`) return state.finalPicks ? finalPicks : livePicks;
      if (path === 'leagues-classic/4611/standings/')
        return { league: REAL.league, standings: { has_next: false, page: 1, results: [] } };
      return undefined;
    },
    { onRequest: (k) => state.calls.push(k) },
  );
  const service = createFplService({ fetch, now: () => state.t });
  const count = (path: string) => state.calls.filter((c) => c === path).length;
  return { state, service, count };
}

const req = <T>(f: T | undefined): T => {
  if (f === undefined) throw new Error('missing method');
  return f;
};

describe('picks of a GW that becomes official (QA: stale pre-auto-sub picks)', () => {
  it('Live Action during the GW, then official: getEntryPicks returns FPL’s final picks', async () => {
    const { state, service } = setup();
    await service.getEntryLive(entry, gw10); // caches the in-progress picks for the live engine (12 h)
    expect(armband(await service.getEntryPicks(entry, gw10))).toEqual([2, 1]);

    // GW ends; FPL rewrites the picks and later marks the GW official.
    state.finalPicks = true;
    state.official = true;
    state.t += FPL_CACHE_TTL.bootstrap + 1; // the service's bootstrap sees it
    expect(armband(await service.getEntryPicks(entry, gw10))).toEqual([0, 2]);
  });

  it('with fresh: final picks at once, even before the cached bootstrap says official', async () => {
    const { state, service } = setup();
    await service.getEntryLive(entry, gw10);
    state.finalPicks = true;
    state.official = true; // bootstrap still cached as "in progress"
    expect(armband(await service.getEntryPicks(entry, gw10, { fresh: true }))).toEqual([0, 2]);
  });

  it('before official, normal reads converge within the short picks TTL', async () => {
    const { state, service } = setup();
    await service.getEntryLive(entry, gw10);
    expect(armband(await service.getEntryPicks(entry, gw10))).toEqual([2, 1]);
    state.finalPicks = true; // auto-subs processed, not data-checked yet
    state.t += FPL_CACHE_TTL.picksSummary + 1;
    expect(armband(await service.getEntryPicks(entry, gw10))).toEqual([0, 2]);
  });

  it('official picks are then cached for the long TTL', async () => {
    const { state, service, count } = setup();
    state.official = true;
    state.finalPicks = true;
    await service.getEntryPicks(entry, gw10);
    state.t += 60 * 60_000;
    await service.getEntryPicks(entry, gw10);
    await service.getEntryLive(entry, gw10);
    expect(count(`entry/${ID}/event/10/picks/`)).toBe(1);
  });
});

describe('fresh reads', () => {
  it('always fetch, share concurrent fresh loads, and refresh the cache for normal reads', async () => {
    const { service, count } = setup();
    const history = req(service.getEntryHistory);
    await history(entry);
    await history(entry, { fresh: true });
    await Promise.all([history(entry, { fresh: true }), history(entry, { fresh: true })]);
    expect(count(`entry/${ID}/history/`)).toBe(3);
    await history(entry); // served from the fresh value
    expect(count(`entry/${ID}/history/`)).toBe(3);
  });

  it('every roundup read honours fresh', async () => {
    const { service, count } = setup();
    const s: FplService = service;
    for (let i = 0; i < 2; i++) {
      await s.getBootstrap({ fresh: true });
      await req(s.getEntryTransfers)(entry, { fresh: true });
      await req(s.getEventPoints)(gw10, { fresh: true });
      await req(s.getLeagueInfo)(league, { fresh: true });
      await s.getLeagueStandings(league, 1, { fresh: true });
      await s.getEntryPicks(entry, gw10, { fresh: true });
    }
    expect(count('bootstrap-static/')).toBe(2);
    expect(count(`entry/${ID}/transfers/`)).toBe(2);
    expect(count('event/10/live/')).toBe(2);
    expect(count('leagues-classic/4611/standings/?page_standings=1')).toBe(4); // info + page 1, ×2
    expect(count(`entry/${ID}/event/10/picks/`)).toBe(2);
    expect(count(`entry/${ID}/history/`)).toBe(1); // getEntryPicks' chipsUsed: the cached history only
  });

  it('fresh never serves stale data on a 503; normal reads still do; the backoff applies to fresh', async () => {
    const { state, service, count } = setup();
    const history = req(service.getEntryHistory);
    const good = await history(entry);
    state.t += FPL_CACHE_TTL.history + 1;
    state.down.add(`entry/${ID}/history/`);

    await expect(history(entry, { fresh: true })).rejects.toMatchObject({
      name: 'FplUnavailableError',
      status: 503,
      kind: 'updating',
    });
    // A normal read answers from the last good value (stale-if-error).
    expect(await history(entry)).toBe(good);
    // Circuit open: fresh fails fast without calling FPL.
    const before = count(`entry/${ID}/history/`);
    const err = await history(entry, { fresh: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FplUnavailableError);
    expect((err as FplUnavailableError).kind).toBe('backoff');
    expect(count(`entry/${ID}/history/`)).toBe(before);
  });

  it('fresh picks / event points throw on 503 instead of serving the cached copy', async () => {
    const { state, service } = setup();
    await service.getEntryPicks(entry, gw10);
    await req(service.getEventPoints)(gw10);
    state.down.add(`entry/${ID}/event/10/picks/`);
    await expect(service.getEntryPicks(entry, gw10, { fresh: true })).rejects.toBeInstanceOf(
      FplUnavailableError,
    );
  });

  it('fresh skips the remembered 404 and reports a real 404', async () => {
    const { state, service, count } = setup();
    const missing = FplEntryIdSchema.parse(42);
    await expect(service.getEntryPicks(missing, gw10)).rejects.toBeInstanceOf(FplNotFoundError);
    await expect(service.getEntryPicks(missing, gw10)).rejects.toBeInstanceOf(FplNotFoundError);
    expect(count('entry/42/event/10/picks/')).toBe(1);
    await expect(service.getEntryPicks(missing, gw10, { fresh: true })).rejects.toBeInstanceOf(
      FplNotFoundError,
    );
    expect(count('entry/42/event/10/picks/')).toBe(2);
    expect(state.calls.length).toBeGreaterThan(0);
  });
});

describe('fresh reads: request budget (roundup job)', () => {
  function multiGw() {
    const calls: string[] = [];
    let down = false;
    const fetch = createReplayFetch(
      (path) => {
        if (path === 'bootstrap-static/') {
          const events = [8, 9, 10].map((id) => ({
            ...REAL.bootstrapEvents[0],
            id,
            name: `Gameweek ${id}`,
            finished: true,
            data_checked: true,
            is_current: id === 10,
            is_next: false,
          }));
          return { events, teams: [], elements: [] };
        }
        if (path === 'event/10/live/') return REAL.live;
        if (path === `entry/${ID}/history/`)
          return (REAL.detail as Record<string, { history: unknown }>)[String(ID)]?.history;
        const m = new RegExp(`^entry/${ID}/event/(8|9|10)/picks/$`).exec(path);
        if (m) return down ? replayStatus(503) : finalPicks;
        return undefined;
      },
      { onRequest: (k) => calls.push(k) },
    );
    const service = createFplService({ fetch, now: () => Date.parse('2026-11-09T12:00:00Z') });
    return { service, calls, setDown: (v: boolean) => (down = v) };
  }

  it('fresh history + fresh picks for 3 GWs = exactly 1 + 3 FPL requests', async () => {
    const { service, calls } = multiGw();
    await service.getBootstrap({ fresh: true }); // the job confirms the GW is official first
    calls.length = 0;
    await req(service.getEntryHistory)(entry, { fresh: true });
    for (const n of [8, 9, 10]) {
      const picks = await service.getEntryPicks(entry, GameweekSchema.parse(n), { fresh: true });
      expect(armband(picks)).toEqual([0, 2]);
    }
    expect(calls).toEqual([
      `entry/${ID}/history/`,
      `entry/${ID}/event/8/picks/`,
      `entry/${ID}/event/9/picks/`,
      `entry/${ID}/event/10/picks/`,
    ]);
  });

  it('fresh event points = 1 request', async () => {
    const { service, calls } = multiGw();
    await req(service.getEventPoints)(gw10, { fresh: true });
    expect(calls).toEqual(['event/10/live/']);
  });

  it('fresh picks still throw on a 503 of the picks endpoint (history cached and healthy)', async () => {
    const { service, calls, setDown } = multiGw();
    await service.getEntryPicks(entry, gw10); // warm picks + history
    setDown(true);
    calls.length = 0;
    await expect(service.getEntryPicks(entry, gw10, { fresh: true })).rejects.toMatchObject({
      name: 'FplUnavailableError',
      status: 503,
    });
    expect(calls).toEqual([`entry/${ID}/event/10/picks/`]);
  });
});
