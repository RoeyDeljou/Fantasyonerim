'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminUserSchema, AvatarResponseSchema, LeagueAvatarsSchema } from '@fant/shared';
import type { AdminUser, FplEntryId, Me, UserId } from '@fant/shared';
import { request, uploadFile } from './api';
import { avatarMap } from './avatar';
import { qk, useMe } from './queries';

/**
 * Profile photo data. Lives outside api.ts / queries.ts so only the chunks that show photos by entryId (the manager
 * sheet, the season leaderboard), the Profile screen and the admin console carry it — not every tab's first load.
 */

/** Under `league`, so the league's refresh scope reloads it and it is kept in the device cache like the table. */
export const LEAGUE_AVATARS_KEY = ['league', 'avatars'] as const;

/** entryId → profile photo (public; through the Vercel CDN on the web build, lib/cdn.ts). Guests too. */
export function useLeagueAvatars(enabled = true): ReadonlyMap<FplEntryId, string> {
  const me = useMe();
  const q = useQuery({
    queryKey: LEAGUE_AVATARS_KEY,
    queryFn: ({ signal }) => request('GET', '/v1/league/avatars', LeagueAvatarsSchema, { signal }),
    staleTime: 60_000,
    enabled,
  });
  return useMemo(() => avatarMap(q.data?.avatars ?? [], me.data), [q.data, me.data]);
}

/** After the fan's photo changed: the new Me at once, then every list that shows it reloads. */
function useApplyMe() {
  const qc = useQueryClient();
  return (user: Me) => {
    qc.setQueryData(qk.me, user);
    void qc.invalidateQueries({ queryKey: LEAGUE_AVATARS_KEY });
    void qc.invalidateQueries({ queryKey: qk.community });
  };
}

/** POST /v1/me/avatar (multipart "file", with progress). The server centre-crops it to a 256×256 JPEG. */
export function useUploadAvatar() {
  const apply = useApplyMe();
  return useMutation({
    mutationFn: ({ file, onProgress }: { file: Blob; onProgress(fraction: number): void }) =>
      uploadFile('/v1/me/avatar', file, AvatarResponseSchema, { onProgress }),
    onSuccess: (r) => apply(r.user),
  });
}

/** DELETE /v1/me/avatar — allowed while banned (it only removes the fan's own photo). */
export function useRemoveAvatar() {
  const apply = useApplyMe();
  return useMutation({
    mutationFn: () => request('DELETE', '/v1/me/avatar', AvatarResponseSchema),
    onSuccess: (r) => apply(r.user),
  });
}

/** Admin → Users: remove someone's photo (DELETE /v1/admin/users/:id/avatar) → the updated row. */
export function useAdminRemoveAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: UserId) =>
      request('DELETE', `/v1/admin/users/${encodeURIComponent(id)}/avatar`, AdminUserSchema),
    onSuccess: (user: AdminUser) => {
      qc.setQueriesData<AdminUser[]>({ queryKey: ['admin', 'users'] }, (list) =>
        list?.map((u) => (u.id === user.id ? user : u)),
      );
      void qc.invalidateQueries({ queryKey: LEAGUE_AVATARS_KEY });
      void qc.invalidateQueries({ queryKey: qk.community });
      void qc.invalidateQueries({ queryKey: ['admin', 'reports'] });
      void qc.invalidateQueries({ queryKey: qk.me }); // an admin may have removed their own photo
    },
  });
}
