'use client';

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AdminCommunityCaptainSchema,
  CommunityCaptainStateSchema,
  type AdminCommunityCaptain,
  type AdminCommunityCaptainResolveBody,
  type CommunityCaptainVoteBody,
  type Gameweek,
} from '@fant/shared';
import { request } from './api';
import { isGuest } from './guest';
import { jittered } from './jitter';
import { needsResultPoll, RESULT_POLL_MS } from './captainVote';
import { IDLE_POLL_MS, qk, useMe } from './queries';

/**
 * "My Community Captain" data. Lives outside api.ts / queries.ts so only the lazy chunks that use it (the Community
 * sub-tab, the admin card) carry it, not the main bundle every tab loads.
 */

export const CAPTAIN_VOTE_KEY = 'community-captain';

/** Everything the vote screens cache: the refresh scope and the post-vote invalidation name this prefix. */
export const CAPTAIN_VOTE_SCOPE = [[CAPTAIN_VOTE_KEY]] as const;

/** Keyed by viewer: the state carries the viewer's own pick, so one account's copy is never shown to another. */
export const captainVoteKey = (viewer: string) => [CAPTAIN_VOTE_KEY, 'state', viewer] as const;
export const adminCaptainVoteKey = (event: Gameweek | null) =>
  ['admin', CAPTAIN_VOTE_KEY, event ?? 'default'] as const;

/** GET /v1/community-captain — waits until the viewer is known (signed-in id, 'guest', or 'anon' if /me failed). */
export function useCaptainVote(enabled = true) {
  const me = useMe();
  const viewer = isGuest() ? 'guest' : (me.data?.id ?? (me.isError ? 'anon' : null));
  return {
    viewer,
    query: useQuery({
      queryKey: captainVoteKey(viewer ?? 'pending'),
      queryFn:
        enabled && viewer !== null
          ? ({ signal }) => request('GET', '/v1/community-captain', CommunityCaptainStateSchema, { signal })
          : skipToken,
      staleTime: 20_000,
      // A locked vote the server hasn't tallied yet: look again every ~30 s. Otherwise slow (new voters, the
      // window opening); a deadline passing on screen triggers its own refetch (screens/CaptainVote.tsx).
      refetchInterval: (q) => jittered(needsResultPoll(q.state.data) ? RESULT_POLL_MS : IDLE_POLL_MS),
      refetchIntervalInBackground: false,
    }),
  };
}

/** PUT /v1/community-captain — the answer is the new state, which replaces the cached one. */
export function useSaveCaptainVote(viewer: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CommunityCaptainVoteBody) =>
      request('PUT', '/v1/community-captain', CommunityCaptainStateSchema, { body }),
    onSuccess: (state) => {
      if (viewer !== null) qc.setQueryData(captainVoteKey(viewer), state);
    },
    onError: () => {
      // The server is the authority: a 4xx ("voting closed", a new gameweek) or a banned account → reload both.
      void qc.invalidateQueries({ queryKey: [CAPTAIN_VOTE_KEY] });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

/** GET /v1/admin/community-captain[?event=] — `null` = the server's default (the vote being run now). */
export function useAdminCaptainVote(event: Gameweek | null | 'skip') {
  return useQuery({
    queryKey: adminCaptainVoteKey(event === 'skip' ? null : event),
    queryFn:
      event === 'skip'
        ? skipToken
        : ({ signal }) =>
            request('GET', '/v1/admin/community-captain', AdminCommunityCaptainSchema, {
              signal,
              query: { event: event ?? undefined },
            }),
    // Live tally while the vote is open.
    refetchInterval: (q) => jittered(q.state.data?.status === 'open' ? 30_000 : IDLE_POLL_MS),
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
}

/** An unparsed body: the resolve answer isn't relied on, the card re-reads the tally afterwards. */
const anyBody = { parse: (d: unknown): unknown => d };

/** POST /v1/admin/community-captain/resolve — break a tie / pick by hand: sets the battle's community captain. */
export function useResolveCaptainVote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: AdminCommunityCaptainResolveBody): Promise<AdminCommunityCaptain | null> => {
      const res = await request('POST', '/v1/admin/community-captain/resolve', anyBody, { body });
      const parsed = AdminCommunityCaptainSchema.safeParse(res);
      return parsed.success ? parsed.data : null;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', CAPTAIN_VOTE_KEY] });
      void qc.invalidateQueries({ queryKey: [CAPTAIN_VOTE_KEY] });
      void qc.invalidateQueries({ queryKey: qk.captainBattle });
      void qc.invalidateQueries({ queryKey: qk.adminCaptainBattle });
    },
  });
}
