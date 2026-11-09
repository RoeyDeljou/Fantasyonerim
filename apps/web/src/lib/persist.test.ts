import { describe, expect, it } from 'vitest';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { deserialize, isPersistedKey, serialize } from './persist';

type Q = PersistedClient['clientState']['queries'][number];

function query(queryKey: unknown[], data: unknown, status: 'success' | 'error' = 'success'): Q {
  return {
    queryKey,
    queryHash: JSON.stringify(queryKey),
    dehydratedAt: 1,
    state: {
      data,
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status,
      fetchStatus: 'idle',
    },
  } as Q;
}

function client(queries: Q[]): PersistedClient {
  return { buster: 'b', timestamp: 1, clientState: { mutations: [], queries } };
}

const page = (cursor: string | null) => ({ items: [], nextCursor: cursor });

describe('query cache persistence', () => {
  it('persists only the allow-list — never admin data (other users emails) or invite previews', () => {
    expect(isPersistedKey(['news', 'feed'])).toBe(true);
    expect(isPersistedKey(['news', 'feed', 'shorts'])).toBe(true);
    expect(isPersistedKey(['news', 'filters'])).toBe(true);
    expect(isPersistedKey(['news', 'feed', 'bogus'])).toBe(false);
    expect(isPersistedKey(['news', 'head', 'shorts'])).toBe(false);
    expect(isPersistedKey(['me'])).toBe(true);
    expect(isPersistedKey(['community', 'feed', 'all'])).toBe(true);
    expect(isPersistedKey(['fpl', 'picks', 1, 9])).toBe(true);
    expect(isPersistedKey(['admin', 'users', ''])).toBe(false);
    expect(isPersistedKey(['me', 'notification-prefs'])).toBe(false);
    expect(isPersistedKey(['admin', 'settings'])).toBe(false);
    expect(isPersistedKey(['admin', 'invites'])).toBe(false);
    expect(isPersistedKey(['community', 'post', 'p1'])).toBe(false);
    expect(isPersistedKey(['fpl', 'picks', 'none'])).toBe(false);
    // Gameweek Roundup: per viewer and GW; never the placeholder key used before the viewer is known.
    expect(isPersistedKey(['league', 'roundup', 'u1', 'latest'])).toBe(true);
    expect(isPersistedKey(['league', 'roundup', 'guest', 10])).toBe(true);
    expect(isPersistedKey(['league', 'roundup', 'pending', 'latest'])).toBe(false);
    expect(isPersistedKey(['league', 'roundup'])).toBe(false);
    expect(isPersistedKey(['league', 'season-captains'])).toBe(true);
  });

  it('keeps only the first page of an infinite feed and restores its `undefined` cursor', () => {
    const raw = serialize(
      client([query(['news', 'feed'], { pages: [page('c2'), page(null)], pageParams: [undefined, 'c2'] })]),
    );
    const restored = deserialize(raw).clientState.queries;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.state.data).toEqual({ pages: [page('c2')], pageParams: [undefined] });
  });

  it('drops anything that no longer parses, is not allow-listed, or did not succeed', () => {
    const raw = JSON.stringify(
      client([
        query(['news', 'feed'], { pages: [{ items: 'nope' }], pageParams: [null] }),
        query(['admin', 'settings'], { leagueId: 1 }),
        query(['admin', 'users', ''], []),
        query(['news', 'stories'], null, 'error'),
      ]),
    );
    expect(deserialize(raw).clientState.queries).toEqual([]);
  });

  it('persists the FPL match sheet (re-parsed with FixtureDetailSchema)', () => {
    expect(isPersistedKey(['fpl', 'fixture', 12])).toBe(true);
    expect(isPersistedKey(['fpl', 'fixture', 'none'])).toBe(false);
    const detail = {
      fixture: {
        id: 12,
        event: 9,
        kickoffTime: '2026-10-25T14:00:00Z',
        teamH: 1,
        teamA: 2,
        teamHScore: 2,
        teamAScore: 1,
        minutes: 90,
        status: 'finished',
      },
      stats: [{ id: 'goals_scored', home: [{ playerId: 10, value: 2 }], away: [{ playerId: 20, value: 1 }] }],
      players: [{ playerId: 10, teamId: 1, minutes: 90, points: 13 }],
      updatedAt: '2026-10-25T16:00:00Z',
    };
    const restored = deserialize(serialize(client([query(['fpl', 'fixture', 12], detail)]))).clientState
      .queries;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.state.data).toEqual(detail);
    const broken = { ...detail, stats: [{ id: 'nope', home: [], away: [] }] };
    expect(
      deserialize(serialize(client([query(['fpl', 'fixture', 12], broken)]))).clientState.queries,
    ).toEqual([]);
  });
});
