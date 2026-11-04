'use client';

import type { QueryClient } from '@tanstack/react-query';
import { whenIdle } from './idle';
import { isGuest } from './guest';
import { readNewsFilter } from './localState';
import {
  bootstrapQuery,
  communityFeedQuery,
  configQuery,
  entryQuery,
  fixturesQuery,
  liveLeagueQuery,
  meQuery,
  newsFeedQuery,
  newsFiltersQuery,
  picksQuery,
  standingsQuery,
  storiesQuery,
} from './queries';

/**
 * No waterfalls on tab open. Each screen renders in stages (session → bootstrap → the list), and a query owned by
 * a later stage would only start once the earlier one rendered. This starts every query a tab needs at once, the
 * moment the shell knows the tab, resolving the few true dependencies (the league id, the user's Team ID, the
 * current GW) as early as their own data lands. The screens then read the very same cache entries (same option
 * builders, lib/queries.ts), and anything still fresh is not fetched again.
 *
 * Once the tab is idle, the main list of the tabs next to it is warmed too (lib/idle.ts: online, no data saver),
 * so switching tabs shows content instead of a skeleton.
 */
export type Tab = 'news' | 'community' | 'myTeam' | 'table' | 'live';

const swallow = () => undefined;

async function leagueSet(qc: QueryClient): Promise<boolean> {
  const config = await qc.ensureQueryData(configQuery());
  return config.league !== null;
}

async function currentEvent(qc: QueryClient) {
  return (await qc.ensureQueryData(bootstrapQuery())).currentEvent;
}

/** The tab's own data (all of it, in parallel). */
const FULL: Record<Tab, (qc: QueryClient) => Promise<unknown>[]> = {
  news: (qc) => {
    const pref = readNewsFilter();
    return [
      qc.prefetchInfiniteQuery(newsFeedQuery(pref === 'all' ? null : pref)),
      qc.prefetchQuery(storiesQuery()),
      qc.prefetchQuery(newsFiltersQuery()),
    ];
  },
  community: (qc) => [qc.prefetchInfiniteQuery(communityFeedQuery(null))],
  myTeam: (qc) => {
    const me = qc.ensureQueryData(meQuery());
    const event = currentEvent(qc);
    return [
      me.then((m) => (m.entryId === null ? undefined : qc.prefetchQuery(entryQuery(m.entryId)))),
      Promise.all([me, event]).then(([m, gw]) =>
        m.entryId === null || gw === null ? undefined : qc.prefetchQuery(picksQuery(m.entryId, gw)),
      ),
    ];
  },
  table: (qc) => [
    leagueSet(qc).then((set) => (set ? qc.prefetchInfiniteQuery(standingsQuery()) : undefined)),
    qc.prefetchQuery(bootstrapQuery()),
  ],
  live: (qc) => [
    leagueSet(qc).then((set) => (set ? qc.prefetchInfiniteQuery(liveLeagueQuery()) : undefined)),
    currentEvent(qc).then((gw) => (gw === null ? undefined : qc.prefetchQuery(fixturesQuery(gw)))),
  ],
};

/** Only the main list of a neighbouring tab (one or two requests). */
const MAIN: Record<Tab, (qc: QueryClient) => Promise<unknown>> = {
  news: (qc) => {
    const pref = readNewsFilter();
    return qc.prefetchInfiniteQuery(newsFeedQuery(pref === 'all' ? null : pref));
  },
  community: (qc) => qc.prefetchInfiniteQuery(communityFeedQuery(null)),
  myTeam: (qc) => Promise.all(FULL.myTeam(qc)),
  table: (qc) => leagueSet(qc).then((set) => (set ? qc.prefetchInfiniteQuery(standingsQuery()) : undefined)),
  live: (qc) => leagueSet(qc).then((set) => (set ? qc.prefetchInfiniteQuery(liveLeagueQuery()) : undefined)),
};

/** Tab-bar neighbours: where a thumb goes next. */
const NEIGHBOURS: Record<Tab, readonly Tab[]> = {
  news: ['community'],
  community: ['news', 'myTeam'],
  myTeam: ['community', 'table'],
  table: ['myTeam', 'live'],
  live: ['table'],
};

/** Starts the tab's queries now and its neighbours' when idle. Returns a cancel for the idle part. */
export function prefetchTab(qc: QueryClient, tab: Tab): () => void {
  // Guests: only public data (no account → no me, no My Team).
  const guest = isGuest();
  // Every screen shows the profile button (me); ensure* never refetches what is cached.
  if (!guest) void qc.prefetchQuery(meQuery()).catch(swallow);
  if (!(guest && tab === 'myTeam')) for (const p of FULL[tab](qc)) void p.catch(swallow);
  return whenIdle(() => {
    for (const n of NEIGHBOURS[tab]) if (!(guest && n === 'myTeam')) void MAIN[n](qc).catch(swallow);
  });
}

export function tabOf(pathname: string): Tab | null {
  if (pathname.startsWith('/news')) return 'news';
  if (pathname.startsWith('/community')) return 'community';
  if (pathname.startsWith('/my-team')) return 'myTeam';
  if (pathname.startsWith('/table')) return 'table';
  if (pathname.startsWith('/live')) return 'live';
  return null;
}
