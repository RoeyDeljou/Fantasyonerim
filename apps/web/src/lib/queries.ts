'use client';

import { useMemo } from 'react';
import {
  QueryClient,
  keepPreviousData,
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
  Comment,
  CommentId,
  CommentPage,
  CommunityPage,
  CommunityPost,
  CreatePostBody,
  HiddenNewsList,
  PostId,
  ReportBody,
  ReportGroup,
  UserId,
  AdminUser,
  BroadcastBody,
  ChangePasswordBody,
} from '@fant/shared';
import type { InfiniteData, QueryClient as QC } from '@tanstack/react-query';
import { api, isApiError, isBannedError } from './api';
import type { CreateAdminBody, ResolveAction } from './api';

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
  community: ['community'] as const,
  communityFeeds: ['community', 'feed'] as const,
  communityFeed: (authorId: UserId | null) => ['community', 'feed', authorId ?? 'all'] as const,
  communityHead: ['community', 'head'] as const,
  post: (id: PostId) => ['community', 'post', id] as const,
  comments: (id: PostId) => ['community', 'comments', id] as const,
  adminReports: ['admin', 'reports'] as const,
  adminUsers: (query: string) => ['admin', 'users', query] as const,
  hiddenNews: ['admin', 'news', 'hidden'] as const,
  broadcastTargets: ['admin', 'broadcast', 'targets'] as const,
  broadcasts: ['admin', 'broadcast', 'history'] as const,
};

export const COMMUNITY_PAGE_SIZE = 20;
/** "New posts" check while the Community tab is visible. */
export const COMMUNITY_HEAD_POLL_MS = 60_000;

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
      void qc.invalidateQueries({ queryKey: qk.hiddenNews });
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

// ---------- community ----------

type FeedData = InfiniteData<CommunityPage, string | undefined>;
type CommentsData = InfiniteData<CommentPage, string | undefined>;

/** Newest first, cursor-paginated. `authorId` = one author's posts (Profile → My posts). */
export function useCommunityFeed(authorId: UserId | null = null, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.communityFeed(authorId),
    queryFn: enabled
      ? ({ pageParam, signal }) =>
          api.community.posts(
            { cursor: pageParam, limit: COMMUNITY_PAGE_SIZE, authorId: authorId ?? undefined },
            { signal },
          )
      : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CommunityPage) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

/** Light poll of the newest posts (paused while hidden) — compared with the feed to offer "new posts". */
export function useCommunityHead(enabled: boolean) {
  return useQuery({
    queryKey: qk.communityHead,
    queryFn: ({ signal }) => api.community.posts({ limit: 5 }, { signal }),
    enabled,
    refetchInterval: COMMUNITY_HEAD_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

export function usePost(id: PostId | null) {
  return useQuery({
    queryKey: id ? qk.post(id) : ['community', 'post', 'none'],
    queryFn: id ? ({ signal }) => api.community.post(id, { signal }) : skipToken,
    staleTime: 30_000,
  });
}

/** Oldest first (conversation order); the next page holds newer comments. */
export function useComments(postId: PostId | null) {
  return useInfiniteQuery({
    queryKey: postId ? qk.comments(postId) : ['community', 'comments', 'none'],
    queryFn: postId
      ? ({ pageParam, signal }) => api.community.comments(postId, pageParam, { signal })
      : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CommentPage) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

/** Applies `fn` to the post wherever it is cached (every feed page + the single-post query). */
function patchPost(qc: QC, id: PostId, fn: (p: CommunityPost) => CommunityPost | null) {
  qc.setQueriesData<FeedData>({ queryKey: qk.communityFeeds }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            items: pg.items.flatMap((p) => {
              if (p.id !== id) return [p];
              const next = fn(p);
              return next ? [next] : [];
            }),
          })),
        }
      : data,
  );
  const single = qc.getQueryData<CommunityPost>(qk.post(id));
  if (single) {
    const next = fn(single);
    if (next) qc.setQueryData(qk.post(id), next);
  }
}

function findPost(qc: QC, id: PostId): CommunityPost | undefined {
  const single = qc.getQueryData<CommunityPost>(qk.post(id));
  if (single) return single;
  for (const [, data] of qc.getQueriesData<FeedData>({ queryKey: qk.communityFeeds })) {
    const hit = data?.pages.flatMap((p) => p.items).find((p) => p.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** A 403 on a Community write = the account was banned (or unbanned) since `me` was fetched → refresh it. */
function trackBan(qc: QC, error: unknown) {
  if (isBannedError(error)) void qc.invalidateQueries({ queryKey: qk.me, exact: true });
}

export function useCreatePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePostBody) => api.community.create(body),
    onError: (e) => trackBan(qc, e),
    onSuccess: (post) => {
      qc.setQueryData(qk.post(post.id), post);
      // Put it on top of the main feed right away, then reconcile.
      qc.setQueryData<FeedData>(qk.communityFeed(null), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((pg, i) =>
                i === 0 ? { ...pg, items: [post, ...pg.items.filter((p) => p.id !== post.id)] } : pg,
              ),
            }
          : data,
      );
      void qc.invalidateQueries({ queryKey: qk.communityFeed(post.author.id) });
      void qc.invalidateQueries({ queryKey: qk.communityHead });
    },
  });
}

export function useDeletePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: PostId) => api.community.remove(id),
    onSuccess: (_v, id) => {
      patchPost(qc, id, () => null);
      qc.removeQueries({ queryKey: qk.post(id) });
      qc.removeQueries({ queryKey: qk.comments(id) });
      void qc.invalidateQueries({ queryKey: qk.communityHead });
    },
  });
}

/** Optimistic like / unlike; rolls back on failure, then takes the server's counts. */
export function useLikePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, liked }: { id: PostId; liked: boolean }) => api.community.like(id, liked),
    onMutate: ({ id, liked }) => {
      const previous = findPost(qc, id);
      patchPost(qc, id, (p) =>
        p.likedByMe === liked
          ? p
          : { ...p, likedByMe: liked, likeCount: Math.max(0, p.likeCount + (liked ? 1 : -1)) },
      );
      return { previous };
    },
    onError: (e, { id }, ctx) => {
      trackBan(qc, e);
      const prev = ctx?.previous;
      if (prev) patchPost(qc, id, (p) => ({ ...p, likedByMe: prev.likedByMe, likeCount: prev.likeCount }));
    },
    onSuccess: (r, { id }) => {
      patchPost(qc, id, (p) => ({ ...p, likedByMe: r.likedByMe, likeCount: r.likeCount }));
    },
  });
}

export function useCreateComment(postId: PostId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.community.comment(postId, { text }),
    onError: (e) => trackBan(qc, e),
    onSuccess: (comment: Comment) => {
      patchPost(qc, postId, (p) => ({ ...p, commentCount: p.commentCount + 1 }));
      // Oldest first: a new comment belongs on the last page — append it if that page is loaded.
      qc.setQueryData<CommentsData>(qk.comments(postId), (data) => {
        if (!data) return data;
        const last = data.pages[data.pages.length - 1];
        if (!last || last.nextCursor) return data;
        return {
          ...data,
          pages: data.pages.map((pg, i) =>
            i === data.pages.length - 1 ? { ...pg, items: [...pg.items, comment] } : pg,
          ),
        };
      });
    },
  });
}

export function useDeleteComment(postId: PostId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: CommentId) => api.community.removeComment(id),
    onSuccess: (_v, id) => {
      patchPost(qc, postId, (p) => ({ ...p, commentCount: Math.max(0, p.commentCount - 1) }));
      qc.setQueryData<CommentsData>(qk.comments(postId), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((pg) => ({ ...pg, items: pg.items.filter((c) => c.id !== id) })),
            }
          : data,
      );
    },
  });
}

export type ReportTarget = { kind: 'post'; id: PostId } | { kind: 'comment'; id: CommentId };

export function useReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ target, body }: { target: ReportTarget; body: ReportBody }) =>
      target.kind === 'post'
        ? api.community.reportPost(target.id, body)
        : api.community.reportComment(target.id, body),
    onError: (e) => trackBan(qc, e),
  });
}

// ---------- admin: moderation ----------

export function useAdminReports(enabled: boolean) {
  return useQuery({
    queryKey: qk.adminReports,
    queryFn: ({ signal }) => api.admin.reports({ signal }),
    enabled,
    staleTime: 15_000,
  });
}

export function useResolveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ group, action }: { group: ReportGroup; action: ResolveAction }) =>
      api.admin.resolveReport(group.targetId, action),
    onSuccess: (_v, { group, action }) => {
      qc.setQueryData<ReportGroup[]>(qk.adminReports, (list) =>
        list?.filter((g) => g.targetId !== group.targetId),
      );
      if (action === 'remove') {
        if (group.target.kind === 'post') {
          patchPost(qc, group.target.post.id, () => null);
          qc.removeQueries({ queryKey: qk.post(group.target.post.id) });
        } else {
          void qc.invalidateQueries({ queryKey: qk.comments(group.target.comment.postId) });
          void qc.invalidateQueries({ queryKey: qk.post(group.target.comment.postId) });
        }
        void qc.invalidateQueries({ queryKey: qk.community });
      }
    },
  });
}

export function useAdminUsers(query: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.adminUsers(query),
    queryFn: ({ signal }) => api.admin.users(query, { signal }),
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useBanUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: UserId; reason: string | null }) =>
      reason === null ? api.admin.unban(id) : api.admin.ban(id, reason),
    onSuccess: (_v, { id, reason }) => {
      qc.setQueriesData<AdminUser[]>({ queryKey: ['admin', 'users'] }, (list) =>
        list?.map((u) =>
          u.id === id
            ? { ...u, bannedAt: reason === null ? null : new Date().toISOString(), banReason: reason }
            : u,
        ),
      );
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useHiddenNews(enabled: boolean) {
  return useQuery({
    queryKey: qk.hiddenNews,
    queryFn: ({ signal }) => api.admin.hiddenNews({ signal }),
    enabled,
    staleTime: 15_000,
  });
}

export function useRestoreNews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: NewsItemId) => api.admin.restoreNews(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<HiddenNewsList>(qk.hiddenNews, (l) =>
        l ? { items: l.items.filter((h) => h.item.id !== id) } : l,
      );
      void qc.invalidateQueries({ queryKey: ['news'] });
    },
  });
}

// ---------- Phase 4: live updates (broadcast) + admin account ----------

export function useBroadcastTargets(enabled: boolean) {
  return useQuery({
    queryKey: qk.broadcastTargets,
    queryFn: ({ signal }) => api.admin.broadcastTargets({ signal }),
    enabled,
    // Availability changes rarely (keys set, first subscriber) — refresh when the admin comes back to the tab.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useBroadcastHistory(enabled: boolean) {
  return useQuery({
    queryKey: qk.broadcasts,
    queryFn: ({ signal }) => api.admin.broadcasts({ signal }),
    enabled,
  });
}

export function useSendBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BroadcastBody) => api.admin.broadcast(body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.broadcasts });
      void qc.invalidateQueries({ queryKey: ['news'] });
    },
  });
}

export function useChangePassword() {
  return useMutation({ mutationFn: (body: ChangePasswordBody) => api.admin.changePassword(body) });
}
