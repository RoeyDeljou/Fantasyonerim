'use client';

import { useMemo } from 'react';
import {
  QueryClient,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AdminSettings,
  Bootstrap,
  CaptainBattleConfig,
  Fixture,
  FplEntryId,
  FplPlayerId,
  FplTeamId,
  Gameweek,
  Me,
  PlTeam,
  Player,
  UpdateMeBody,
  AdminNewsBody,
  AdminPushBody,
  IntegrationId,
  IntegrationList,
  IntegrationStatus,
  IntegrationUpdateBody,
  NewsItemId,
  NewsPage,
  NotificationPrefs,
} from '@fant/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { api, isApiError } from './api';
import type { CreateAdminBody } from './api';

export const LIVE_POLL_MS = 30_000;
export const IDLE_POLL_MS = 5 * 60_000;

export const qk = {
  config: ['config'] as const,
  me: ['me'] as const,
  recoveryCode: ['me', 'recovery-code'] as const,
  bootstrap: ['fpl', 'bootstrap'] as const,
  fixtures: (event: Gameweek | null) => ['fpl', 'fixtures', event ?? 'none'] as const,
  entry: (id: FplEntryId) => ['fpl', 'entry', id] as const,
  picks: (id: FplEntryId, event: Gameweek | null) => ['fpl', 'picks', id, event ?? 'current'] as const,
  entryLive: (id: FplEntryId, event: Gameweek | null) => ['fpl', 'live', id, event ?? 'current'] as const,
  standings: ['league', 'standings'] as const,
  liveLeague: ['league', 'live'] as const,
  captainBattle: ['captain-battle'] as const,
  adminSettings: ['admin', 'settings'] as const,
  adminCaptainBattle: ['admin', 'captain-battle'] as const,
  admins: ['admin', 'admins'] as const,
  news: ['news', 'feed'] as const,
  newsHead: ['news', 'head'] as const,
  stories: ['news', 'stories'] as const,
  newsItem: (id: NewsItemId) => ['news', 'item', id] as const,
  notificationPrefs: ['me', 'notification-prefs'] as const,
  integrations: ['admin', 'integrations'] as const,
};

export const NEWS_PAGE_SIZE = 15;
/** "New posts" check while the News tab is visible. */
export const NEWS_HEAD_POLL_MS = 2 * 60_000;
export const STORIES_POLL_MS = 5 * 60_000;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/** True while any fixture in the list is being played. */
export function anyLive(fixtures: readonly Fixture[] | undefined): boolean {
  return !!fixtures?.some((f) => f.status === 'live');
}

// ---------- public / FPL ----------

export function useConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: ({ signal }) => api.config({ signal }),
    staleTime: 5 * 60_000,
  });
}

export function useBootstrap() {
  return useQuery({
    queryKey: qk.bootstrap,
    queryFn: ({ signal }) => api.bootstrap({ signal }),
    staleTime: 10 * 60_000,
  });
}

export interface FplIndex {
  players: Map<FplPlayerId, Player>;
  teams: Map<FplTeamId, PlTeam>;
  bootstrap: Bootstrap;
}

/** Bootstrap with O(1) lookups by player and team id. */
export function useFplIndex() {
  const q = useBootstrap();
  const index = useMemo<FplIndex | undefined>(() => {
    if (!q.data) return undefined;
    return {
      players: new Map(q.data.players.map((p) => [p.id, p])),
      teams: new Map(q.data.teams.map((t) => [t.id, t])),
      bootstrap: q.data,
    };
  }, [q.data]);
  return { ...q, index };
}

/**
 * Fixtures of one GW (`null` = not known yet → idle). Always pass the GW explicitly: without `?event=` the
 * API returns the whole season. Polls 30 s while a match is live, 5 min otherwise; paused when hidden.
 */
export function useFixtures(event: Gameweek | null) {
  return useQuery({
    queryKey: qk.fixtures(event),
    queryFn: event === null ? skipToken : ({ signal }) => api.fixtures(event, { signal }),
    refetchInterval: (q) => (anyLive(q.state.data) ? LIVE_POLL_MS : IDLE_POLL_MS),
    refetchIntervalInBackground: false,
  });
}

/** Fixtures of the current GW (from bootstrap). */
export function useCurrentFixtures() {
  const bootstrap = useBootstrap();
  return useFixtures(bootstrap.data?.currentEvent ?? null);
}

/** Poll interval for live screens, driven by the current GW's fixtures. */
export function useLivePollInterval(): { interval: number; isLive: boolean } {
  const fixtures = useCurrentFixtures();
  const isLive = anyLive(fixtures.data);
  return { interval: isLive ? LIVE_POLL_MS : IDLE_POLL_MS, isLive };
}

export function useEntry(id: FplEntryId | null) {
  return useQuery({
    queryKey: id ? qk.entry(id) : ['fpl', 'entry', 'none'],
    queryFn: id ? ({ signal }) => api.entry(id, { signal }) : skipToken,
    staleTime: 60_000,
  });
}

export function usePicks(id: FplEntryId | null, event: Gameweek | null, enabled = true) {
  return useQuery({
    queryKey: id ? qk.picks(id, event) : ['fpl', 'picks', 'none'],
    queryFn: id && enabled ? ({ signal }) => api.picks(id, event ?? undefined, { signal }) : skipToken,
    staleTime: 60_000,
  });
}

export function useEntryLive(id: FplEntryId | null, event: Gameweek | null, refetchInterval: number | false) {
  return useQuery({
    queryKey: id ? qk.entryLive(id, event) : ['fpl', 'live', 'none'],
    queryFn: id ? ({ signal }) => api.entryLive(id, event ?? undefined, { signal }) : skipToken,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}

/** League queries only run once /v1/config says a league is set (avoids 404s on a fresh install). */
export function useStandings(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.standings,
    queryFn: enabled ? ({ pageParam, signal }) => api.standings(pageParam, { signal }) : skipToken,
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasNext ? last.page + 1 : undefined),
    staleTime: 60_000,
  });
}

export function useLiveLeague(refetchInterval: number, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.liveLeague,
    queryFn: enabled ? ({ pageParam, signal }) => api.liveLeague(pageParam, { signal }) : skipToken,
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasNext ? last.page + 1 : undefined),
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}

export function useCaptainBattle(refetchInterval: number) {
  return useQuery({
    queryKey: qk.captainBattle,
    queryFn: ({ signal }) => api.captainBattle({ signal }),
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}

// ---------- me ----------

export function useMe(enabled = true) {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.me({ signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useRecoveryCode(enabled: boolean) {
  return useQuery({
    queryKey: qk.recoveryCode,
    queryFn: ({ signal }) => api.recoveryCode({ signal }),
    enabled,
    staleTime: Infinity,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => api.updateMe(body),
    onSuccess: (me: Me) => qc.setQueryData(qk.me, me),
  });
}

// ---------- admin ----------

export function useAdminSettings(enabled: boolean) {
  return useQuery({
    queryKey: qk.adminSettings,
    queryFn: ({ signal }) => api.admin.settings({ signal }),
    enabled,
  });
}

export function useSaveAdminSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminSettings) => api.admin.saveSettings(body),
    onSuccess: (s) => {
      qc.setQueryData(qk.adminSettings, s);
      void qc.invalidateQueries({ queryKey: qk.config });
      void qc.invalidateQueries({ queryKey: ['league'] });
    },
  });
}

export function useAdminCaptainBattle(enabled: boolean) {
  return useQuery({
    queryKey: qk.adminCaptainBattle,
    queryFn: ({ signal }) => api.admin.captainBattle({ signal }),
    enabled,
  });
}

export function useSaveAdminCaptainBattle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CaptainBattleConfig) => api.admin.saveCaptainBattle(body),
    onSuccess: (c) => {
      qc.setQueryData(qk.adminCaptainBattle, c);
      void qc.invalidateQueries({ queryKey: qk.captainBattle });
      void qc.invalidateQueries({ queryKey: qk.config });
    },
  });
}

export function useAdmins(enabled: boolean) {
  return useQuery({ queryKey: qk.admins, queryFn: ({ signal }) => api.admin.admins({ signal }), enabled });
}

export function useCreateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAdminBody) => api.admin.createAdmin(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.admins }),
  });
}

// ---------- news ----------

/** The feed: cursor-paginated, newest first. Refetches on focus; the "new posts" pill uses `useNewsHead`. */
export function useNewsFeed() {
  return useInfiniteQuery({
    queryKey: qk.news,
    queryFn: ({ pageParam, signal }) => api.news(pageParam, NEWS_PAGE_SIZE, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: NewsPage) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });
}

/** Light poll of the first page (paused while hidden) — compared with the feed to offer "new posts". */
export function useNewsHead(enabled: boolean) {
  return useQuery({
    queryKey: qk.newsHead,
    queryFn: ({ signal }) => api.news(undefined, 5, { signal }),
    enabled,
    refetchInterval: NEWS_HEAD_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

export function useStories() {
  return useQuery({
    queryKey: qk.stories,
    queryFn: ({ signal }) => api.stories({ signal }),
    refetchInterval: STORIES_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

export function useNewsItem(id: NewsItemId | null) {
  return useQuery({
    queryKey: id ? qk.newsItem(id) : ['news', 'item', 'none'],
    queryFn: id ? ({ signal }) => api.newsItem(id, { signal }) : skipToken,
    staleTime: 5 * 60_000,
  });
}

/** Admin: hide an item. Removed from every cached page right away. */
export function useHideNews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: NewsItemId) => api.admin.hideNews(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<InfiniteData<NewsPage, string | undefined>>(qk.news, (data) =>
        data
          ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== id) })) }
          : data,
      );
      qc.removeQueries({ queryKey: qk.newsItem(id) });
      void qc.invalidateQueries({ queryKey: ['news'] });
    },
  });
}

export function usePostNews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminNewsBody) => api.admin.postNews(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['news'] }),
  });
}

export function useAdminPush() {
  return useMutation({ mutationFn: (body: AdminPushBody) => api.admin.push(body) });
}

// ---------- notification prefs ----------

export function useNotificationPrefs(enabled: boolean) {
  return useQuery({
    queryKey: qk.notificationPrefs,
    queryFn: ({ signal }) => api.notificationPrefs({ signal }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Optimistic: the toggle flips immediately and rolls back on failure. */
export function useSaveNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPrefs) => api.saveNotificationPrefs(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.notificationPrefs });
      const previous = qc.getQueryData<NotificationPrefs>(qk.notificationPrefs);
      qc.setQueryData(qk.notificationPrefs, body);
      return { previous };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.notificationPrefs, ctx.previous);
    },
    onSuccess: (prefs) => qc.setQueryData(qk.notificationPrefs, prefs),
  });
}

// ---------- admin: integrations ----------

export function useIntegrations(enabled: boolean) {
  return useQuery({
    queryKey: qk.integrations,
    queryFn: ({ signal }) => api.admin.integrations({ signal }),
    enabled,
    staleTime: 15_000,
  });
}

function replaceIntegration(list: IntegrationList | undefined, next: IntegrationStatus) {
  if (!list) return list;
  return { integrations: list.integrations.map((i) => (i.id === next.id ? next : i)) };
}

export function useUpdateIntegration(id: IntegrationId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IntegrationUpdateBody) => api.admin.updateIntegration(id, body),
    onSuccess: (s) => qc.setQueryData<IntegrationList>(qk.integrations, (l) => replaceIntegration(l, s)),
  });
}

export function useSyncIntegration(id: IntegrationId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.admin.syncIntegration(id),
    onSuccess: (s) => {
      qc.setQueryData<IntegrationList>(qk.integrations, (l) => replaceIntegration(l, s));
      void qc.invalidateQueries({ queryKey: ['news'] });
    },
  });
}

export function useDisconnectInstagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.admin.disconnectInstagram(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.integrations }),
  });
}
