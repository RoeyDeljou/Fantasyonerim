import { FplLeagueIdSchema } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { REAL_LEAGUE_4611_STANDINGS } from './__fixtures__/real-league-4611.js';
import { createFplService } from './client.js';
import { createReplayFetch, replayStatus, type ReplayResolver } from './replay.js';
import { FplNotFoundError } from './service.js';

/** getLeagueNewEntries: `new_entries` paging over the cached standings responses. */

const L4611 = FplLeagueIdSchema.parse(4611);
const T0 = Date.UTC(2026, 10, 4, 12);
const clone = () =>
  JSON.parse(JSON.stringify(REAL_LEAGUE_4611_STANDINGS)) as typeof REAL_LEAGUE_4611_STANDINGS;

const newEntry = (entry: number) => ({
  entry,
  entry_name: `Team ${entry}`,
  player_first_name: 'New',
  player_last_name: `Manager ${entry}`,
  joined_time: '2026-11-03T18:22:10.123456Z',
});

function setup(resolve: ReplayResolver) {
  const clock = { t: T0 };
  const calls: string[] = [];
  const service = createFplService({
    fetch: createReplayFetch(resolve, { onRequest: (k) => calls.push(k) }),
    now: () => clock.t,
  });
  return { service, clock, calls };
}

/** League 4611 as recorded, with `new_entries` replaced per page_new_entries (null = drop the field). */
function league4611(newEntriesPage: (page: number) => unknown): ReplayResolver {
  return (path, query) => {
    if (path !== 'leagues-classic/4611/standings/') return undefined;
    const page = Number(query.get('page_new_entries') ?? '1');
    const body: Record<string, unknown> = clone();
    const ne = newEntriesPage(page);
    if (ne === null) delete body.new_entries;
    else if (ne !== undefined) body.new_entries = ne;
    return body;
  };
}

describe('getLeagueNewEntries', () => {
  it('recorded league 4611 (new_entries empty) → [] from the standings page-1 fetch, shared with standings', async () => {
    const { service, calls } = setup(league4611(() => undefined));
    expect(await service.getLeagueNewEntries?.(L4611)).toEqual([]);
    const standings = await service.getLeagueStandings(L4611, 1);
    expect(standings.rows).toHaveLength(3);
    expect(calls).toEqual(['leagues-classic/4611/standings/?page_standings=1']);
  });

  it('absent new_entries field → [] and standings still parse', async () => {
    const { service } = setup(league4611(() => null));
    expect(await service.getLeagueNewEntries?.(L4611)).toEqual([]);
    expect((await service.getLeagueStandings(L4611, 1)).league.name).toBe('Fantasyonerim');
  });

  it('pages until has_next is false, de-duplicated, cached for 2 min', async () => {
    const pages: Record<number, unknown> = {
      1: { has_next: true, page: 1, results: [newEntry(901), newEntry(902)] },
      2: { has_next: false, page: 2, results: [newEntry(903), newEntry(902)] },
    };
    const { service, clock, calls } = setup(league4611((p) => pages[p]));
    expect(await service.getLeagueNewEntries?.(L4611)).toEqual([901, 902, 903]);
    expect(calls).toEqual([
      'leagues-classic/4611/standings/?page_standings=1',
      'leagues-classic/4611/standings/?page_new_entries=2&page_standings=1',
    ]);

    clock.t += 60_000;
    await service.getLeagueNewEntries?.(L4611);
    expect(calls).toHaveLength(2); // cached

    clock.t += 61_000; // > 2 min after the fetch
    await service.getLeagueNewEntries?.(L4611);
    expect(calls).toHaveLength(4);
  });

  it('stops at 20 pages even if FPL keeps saying has_next', async () => {
    const { service, calls } = setup(
      league4611((p) => ({ has_next: true, page: p, results: [newEntry(1000 + p)] })),
    );
    const ids = (await service.getLeagueNewEntries?.(L4611)) ?? [];
    expect(ids).toHaveLength(20);
    expect(calls).toHaveLength(20);
  });

  it('50 concurrent calls share one sweep (1 fetch per page)', async () => {
    const pages: Record<number, unknown> = {
      1: { has_next: true, page: 1, results: [newEntry(901)] },
      2: { has_next: false, page: 2, results: [newEntry(902)] },
    };
    const { service, calls } = setup(league4611((p) => pages[p]));
    const all = await Promise.all(Array.from({ length: 50 }, () => service.getLeagueNewEntries?.(L4611)));
    for (const ids of all) expect(ids).toEqual([901, 902]);
    expect(calls).toHaveLength(2);
  });

  it('serves the last good list while FPL answers 503', async () => {
    let down = false;
    const pages: Record<number, unknown> = {
      1: { has_next: true, page: 1, results: [newEntry(901)] },
      2: { has_next: false, page: 2, results: [newEntry(902)] },
    };
    const ok = league4611((p) => pages[p]);
    const { service, clock } = setup((path, query) => (down ? replayStatus(503) : ok(path, query)));
    const good = await service.getLeagueNewEntries?.(L4611);
    down = true;
    clock.t += 5 * 60_000;
    expect(await service.getLeagueNewEntries?.(L4611)).toEqual(good);
  });

  it('unknown league → FplNotFoundError', async () => {
    const { service } = setup(league4611(() => undefined));
    await expect(service.getLeagueNewEntries?.(FplLeagueIdSchema.parse(1))).rejects.toBeInstanceOf(
      FplNotFoundError,
    );
  });
});
