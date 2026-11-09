'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import { SeasonCaptainsSchema } from '@fant/shared';
import { request } from './api';
import { jittered } from './jitter';
import { qk, ROUNDUP_BUILDING_POLL_MS } from './queries';

/**
 * Season Captain Battle data. Lives outside api.ts / queries.ts so that only the lazy season chunk
 * (screens/SeasonCaptains.tsx) carries it, not the main bundle every tab loads.
 */
export function useSeasonCaptains(enabled: boolean) {
  return useQuery({
    queryKey: qk.seasonCaptains,
    // Public (no viewer key). Re-checked every minute while it is still being built.
    queryFn: enabled
      ? ({ signal }) => request('GET', '/v1/league/season-captains', SeasonCaptainsSchema, { signal })
      : skipToken,
    staleTime: (q) => (q.state.data?.status === 'ready' ? 10 * 60_000 : 30_000),
    refetchInterval: (q) =>
      q.state.data?.status === 'building' ? jittered(ROUNDUP_BUILDING_POLL_MS) : false,
    refetchIntervalInBackground: false,
  });
}
