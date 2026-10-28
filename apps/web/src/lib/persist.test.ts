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
  it('persists only the allow-list — never admin data, the recovery code or invite previews', () => {
    expect(isPersistedKey(['news', 'feed'])).toBe(true);
    expect(isPersistedKey(['news', 'feed', 'shorts'])).toBe(true);
    expect(isPersistedKey(['news', 'filters'])).toBe(true);
    expect(isPersistedKey(['news', 'feed', 'bogus'])).toBe(false);
    expect(isPersistedKey(['news', 'head', 'shorts'])).toBe(false);
    expect(isPersistedKey(['me'])).toBe(true);
    expect(isPersistedKey(['community', 'feed', 'all'])).toBe(true);
    expect(isPersistedKey(['fpl', 'picks', 1, 9])).toBe(true);
    expect(isPersistedKey(['me', 'recovery-code'])).toBe(false);
    expect(isPersistedKey(['me', 'notification-prefs'])).toBe(false);
    expect(isPersistedKey(['admin', 'settings'])).toBe(false);
    expect(isPersistedKey(['admin', 'invites'])).toBe(false);
    expect(isPersistedKey(['community', 'post', 'p1'])).toBe(false);
    expect(isPersistedKey(['fpl', 'picks', 'none'])).toBe(false);
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
        query(['me', 'recovery-code'], 'ABCD-EFGH'),
        query(['news', 'stories'], null, 'error'),
      ]),
    );
    expect(deserialize(raw).clientState.queries).toEqual([]);
  });
});
