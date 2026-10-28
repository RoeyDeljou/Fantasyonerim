'use client';

import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { removeOldestQuery } from '@tanstack/react-query-persist-client';
import type { PersistedClient, PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { dehydrate } from '@tanstack/react-query';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import {
  BootstrapSchema,
  CaptainBattleSchema,
  CommunityPageSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  MeSchema,
  NewsFilterSchema,
  NewsFiltersSchema,
  NewsPageSchema,
  PublicConfigSchema,
  StoriesSchema,
} from '@fant/shared';

/**
 * "Open the app → see content now." The API sleeps when idle (a cold start takes up to a minute), so the last
 * good copy of the read-only screens is kept on the device and shown instantly while it revalidates.
 *
 * Only an allow-list is persisted: public data and the signed-in user's own read views. Never admin queries,
 * the recovery code, invite previews or anything secret. Each restored entry is re-parsed with the same Zod
 * schema the API client uses; anything that doesn't parse is dropped (and the build id busts the whole cache
 * on every deploy, so a contract change never meets an old shape).
 */
export const PERSIST_KEY = 'fant.queryCache';
export const PERSIST_MAX_AGE = 7 * 24 * 60 * 60_000;
/** Infinite feeds keep only their first page on the device. */
const KEEP_PAGES = 1;

/** The bit of a Zod schema we need (the contract schemas from @fant/shared). */
interface Schema {
  safeParse(v: unknown): { success: true; data: unknown } | { success: false };
}
type Kind = { schema: Schema; infinite?: boolean; list?: boolean };

/** The allow-list: query key → how to re-validate it. Anything not matched here is never written. */
function kindOf(key: QueryKey): Kind | null {
  const [a, b, c] = key as readonly unknown[];
  if (a === 'config' && key.length === 1) return { schema: PublicConfigSchema };
  if (a === 'me' && key.length === 1) return { schema: MeSchema };
  if (a === 'captain-battle' && key.length === 1) return { schema: CaptainBattleSchema };
  if (a === 'fpl') {
    if (b === 'bootstrap') return { schema: BootstrapSchema };
    if (b === 'fixtures' && c !== 'none') return { schema: FixtureSchema, list: true };
    if (b === 'entry' && c !== 'none') return { schema: EntrySummarySchema };
    if (b === 'picks' && c !== 'none') return { schema: EntryPicksSchema };
    if (b === 'live' && c !== 'none') return { schema: EntryLiveSchema };
    return null;
  }
  if (a === 'league' && key.length === 2) {
    if (b === 'standings') return { schema: LeagueStandingsSchema, infinite: true };
    if (b === 'live') return { schema: LiveLeagueSchema, infinite: true };
    return null;
  }
  if (a === 'news' && key.length === 2) {
    if (b === 'feed') return { schema: NewsPageSchema, infinite: true };
    if (b === 'stories') return { schema: StoriesSchema };
    if (b === 'filters') return { schema: NewsFiltersSchema };
    return null;
  }
  // A filter chip's own feed, e.g. ['news', 'feed', 'shorts'].
  if (a === 'news' && b === 'feed' && key.length === 3 && NewsFilterSchema.safeParse(c).success)
    return { schema: NewsPageSchema, infinite: true };
  if (a === 'community' && b === 'feed' && c === 'all')
    return { schema: CommunityPageSchema, infinite: true };
  return null;
}

export function isPersistedKey(key: QueryKey): boolean {
  return kindOf(key) !== null;
}

function isInfinite(v: unknown): v is { pages: unknown[]; pageParams: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { pages?: unknown }).pages) &&
    Array.isArray((v as { pageParams?: unknown }).pageParams)
  );
}

/** Re-validates restored data with the contract schema; null = drop it. */
function revalidate(kind: Kind, data: unknown): unknown {
  if (kind.infinite) {
    if (!isInfinite(data) || data.pages.length === 0) return null;
    const pages: unknown[] = [];
    for (const p of data.pages.slice(0, KEEP_PAGES)) {
      const r = kind.schema.safeParse(p);
      if (!r.success) return null;
      pages.push(r.data);
    }
    // JSON turns the first page's `undefined` cursor into `null` — which the API would reject as a cursor.
    const pageParams = data.pageParams.slice(0, KEEP_PAGES).map((p) => (p === null ? undefined : p));
    return { pages, pageParams };
  }
  if (kind.list) {
    if (!Array.isArray(data)) return null;
    const items: unknown[] = [];
    for (const x of data) {
      const r = kind.schema.safeParse(x);
      if (!r.success) return null;
      items.push(r.data);
    }
    return items;
  }
  const r = kind.schema.safeParse(data);
  return r.success ? r.data : null;
}

/** localStorage, or nothing when it's blocked (private mode, sandboxed webview) — persistence just turns off. */
function safeStorage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    const s = window.localStorage;
    const probe = '__fant_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return {
      get length() {
        return s.length;
      },
      clear: () => s.clear(),
      key: (i: number) => s.key(i),
      getItem: (k: string) => {
        try {
          return s.getItem(k);
        } catch {
          return null;
        }
      },
      // Quota errors are thrown on purpose: the persister then drops the oldest query and retries.
      setItem: (k: string, v: string) => s.setItem(k, v),
      removeItem: (k: string) => {
        try {
          s.removeItem(k);
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return undefined;
  }
}

export function serialize(client: PersistedClient): string {
  // Infinite feeds: only the first page goes to disk.
  const queries = client.clientState.queries.map((q) => {
    const data = q.state.data;
    if (!isInfinite(data) || data.pages.length <= KEEP_PAGES) return q;
    return {
      ...q,
      state: {
        ...q.state,
        data: { pages: data.pages.slice(0, KEEP_PAGES), pageParams: data.pageParams.slice(0, KEEP_PAGES) },
      },
    };
  });
  return JSON.stringify({ ...client, clientState: { ...client.clientState, queries } });
}

export function deserialize(raw: string): PersistedClient {
  const client = JSON.parse(raw) as PersistedClient;
  const queries = (client.clientState?.queries ?? []).flatMap((q) => {
    const kind = kindOf(q.queryKey);
    if (!kind || q.state.status !== 'success') return [];
    const data = revalidate(kind, q.state.data);
    return data === null ? [] : [{ ...q, state: { ...q.state, data } }];
  });
  return { ...client, clientState: { mutations: [], queries } };
}

const storage = safeStorage();

export const persister = createSyncStoragePersister({
  storage,
  key: PERSIST_KEY,
  throttleTime: 1_000,
  serialize,
  deserialize,
  retry: removeOldestQuery,
});

/** One cache per deploy: a new build never reads data written by an older one. */
export const PERSIST_BUSTER = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: PERSIST_MAX_AGE,
  buster: PERSIST_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: (q: Query) => q.state.status === 'success' && isPersistedKey(q.queryKey),
    shouldDehydrateMutation: () => false,
  },
};

/** Signed out / account deleted: forget everything that was kept on this device. */
export function clearPersistedQueries(): void {
  try {
    window.localStorage.removeItem(PERSIST_KEY);
  } catch {
    // ignore
  }
}

/**
 * Writes the cache now, bypassing the persister's 1 s throttle. Called when the page is hidden or unloaded, so a
 * like / post / setting changed just before closing the app is what the next start shows (the throttled save would
 * never run once the page is gone).
 */
export function flushPersistedQueries(queryClient: QueryClient): void {
  if (!storage) return;
  const client: PersistedClient = {
    buster: PERSIST_BUSTER,
    timestamp: Date.now(),
    clientState: dehydrate(queryClient, persistOptions.dehydrateOptions),
  };
  try {
    storage.setItem(PERSIST_KEY, serialize(client));
  } catch {
    // quota: the throttled persister (which drops the oldest queries and retries) still runs if the page lives on
  }
}

/** Flush on every way the app goes away: hidden (tab switch, app switcher, iOS freeze) and page unload. */
export function wirePersistFlush(
  queryClient: QueryClient,
  onHidden: (cb: () => void) => () => void,
): () => void {
  const flush = () => flushPersistedQueries(queryClient);
  window.addEventListener('pagehide', flush);
  const off = onHidden(flush);
  return () => {
    window.removeEventListener('pagehide', flush);
    off();
  };
}
