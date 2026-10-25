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
} from '@fant/shared';
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
};

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

export function useStandings() {
  return useInfiniteQuery({
    queryKey: qk.standings,
    queryFn: ({ pageParam, signal }) => api.standings(pageParam, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasNext ? last.page + 1 : undefined),
    staleTime: 60_000,
  });
}

export function useLiveLeague(refetchInterval: number) {
  return useInfiniteQuery({
    queryKey: qk.liveLeague,
    queryFn: ({ pageParam, signal }) => api.liveLeague(pageParam, { signal }),
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
