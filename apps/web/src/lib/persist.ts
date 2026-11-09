'use client';

import { removeOldestQuery } from '@tanstack/react-query-persist-client';
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';
import { dehydrate } from '@tanstack/react-query';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import {
  BootstrapSchema,
  CaptainBattleSchema,
  CommunityPageSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureDetailSchema,
  FixtureSchema,
  GameweekRoundupSchema,
  LeagueStandingsSchema,
  LeaguePositionSchema,
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
 * Only an allow-list is persisted: public data and the signed-in user's own read views. Never admin queries
 * (e.g. other users' emails), invite previews or anything secret. Each restored entry is re-parsed with the same Zod
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
    if (b === 'fixture' && c !== 'none' && key.length === 3) return { schema: FixtureDetailSchema };
    if (b === 'entry' && c !== 'none') return { schema: EntrySummarySchema };
    if (b === 'picks' && c !== 'none') return { schema: EntryPicksSchema };
    if (b === 'live' && c !== 'none') return { schema: EntryLiveSchema };
    return null;
  }
  // ['league', 'roundup', viewer, event | 'latest']: per viewer (it carries their own captain), cleared on sign-out.
  if (a === 'league' && b === 'roundup' && key.length === 4 && c !== 'pending')
    return { schema: GameweekRoundupSchema };
  if (a === 'league' && key.length === 2) {
    if (b === 'standings') return { schema: LeagueStandingsSchema, infinite: true };
    if (b === 'live') return { schema: LiveLeagueSchema, infinite: true };
    if (b === 'position') return { schema: LeaguePositionSchema };
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

/**
 * JSON of a query's data, cached by object identity. TanStack Query keeps unchanged data referentially equal across
 * refetches (structural sharing), so a save after a poll or a next page only stringifies what actually changed —
 * not the whole bootstrap (hundreds of KB) every time. That full re-stringify was a 100+ ms main-thread task while
 * scrolling a feed on a mid-range phone.
 */
const dataJson = new WeakMap<object, string>();
function jsonOf(v: unknown): string {
  if (typeof v !== 'object' || v === null) return JSON.stringify(v) ?? 'null';
  let json = dataJson.get(v);
  if (json === undefined) {
    json = JSON.stringify(v);
    dataJson.set(v, json);
  }
  return json;
}

/** Infinite feeds: only the first page goes to disk (cached on that page object). */
function dataToJson(data: unknown): string {
  if (!isInfinite(data)) return jsonOf(data);
  const pages = data.pages.slice(0, KEEP_PAGES).map(jsonOf).join(',');
  return `{"pages":[${pages}],"pageParams":${JSON.stringify(data.pageParams.slice(0, KEEP_PAGES))}}`;
}

const DATA_SLOT = '"__fant_data__"';

/** The persisted queries as a JSON array (everything but `buster` / `timestamp`). */
function queriesJson(client: PersistedClient): string {
  const parts = client.clientState.queries.map((q) => {
    const shell = JSON.stringify({ ...q, state: { ...q.state, data: '__fant_data__' } });
    return shell.replace(DATA_SLOT, () => dataToJson(q.state.data));
  });
  return `[${parts.join(',')}]`;
}

function wrap(client: PersistedClient, queries: string): string {
  return `{"buster":${JSON.stringify(client.buster)},"timestamp":${JSON.stringify(client.timestamp)},"clientState":{"mutations":[],"queries":${queries}}}`;
}

export function serialize(client: PersistedClient): string {
  return wrap(client, queriesJson(client));
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

/**
 * The queries part last written, to skip a write when nothing kept on the device changed (the stored timestamp
 * then stays at the last real change, which is what the 7-day max age should count from anyway).
 */
let lastWritten: string | null = null;

/** Writes now; on a quota error drops the oldest query and tries again (like the stock persister's `retry`). */
function save(client: PersistedClient): void {
  if (!storage) return;
  let current: PersistedClient | undefined = client;
  let errorCount = 0;
  while (current) {
    const queries = queriesJson(current);
    if (queries === lastWritten) return;
    try {
      storage.setItem(PERSIST_KEY, wrap(current, queries));
      lastWritten = queries;
      return;
    } catch (error) {
      errorCount++;
      current = removeOldestQuery({
        persistedClient: current,
        error: error instanceof Error ? error : new Error(String(error)),
        errorCount,
      });
    }
  }
}

/** At most one save per THROTTLE_MS, run when the main thread is idle (never in the middle of a scroll frame). */
const THROTTLE_MS = 1_000;
let pending: PersistedClient | null = null;
let scheduled = false;
function scheduleSave(client: PersistedClient): void {
  pending = client;
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    const run = () => {
      scheduled = false;
      const c = pending;
      pending = null;
      if (c) save(c);
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2_000 });
    else run();
  }, THROTTLE_MS);
}

export const persister: Persister = {
  persistClient: (client) => {
    if (storage) scheduleSave(client);
  },
  restoreClient: () => {
    const raw = storage?.getItem(PERSIST_KEY);
    return raw ? deserialize(raw) : undefined;
  },
  removeClient: () => {
    lastWritten = null;
    storage?.removeItem(PERSIST_KEY);
  },
};

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
  lastWritten = null;
  pending = null;
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
  pending = null; // supersedes a throttled save that hasn't run yet
  save({
    buster: PERSIST_BUSTER,
    timestamp: Date.now(),
    clientState: dehydrate(queryClient, persistOptions.dehydrateOptions),
  });
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
