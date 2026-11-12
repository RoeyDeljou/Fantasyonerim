import type { FplEntryId } from '@fant/shared';

/**
 * Profile photos — the pure rules (no React, no network), shared by the Profile photo card, the league avatar map
 * and their tests. The hooks live in avatarApi.ts.
 */

/** Same limit as the API (POST /v1/me/avatar: JPEG / PNG / WebP / HEIC ≤ 10 MB). */
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
/** What the file picker offers: any image (camera or library on iOS / Android), plus HEIC by extension. */
export const AVATAR_ACCEPT = 'image/*,.heic,.heif';
const HEIC = /\.(heic|heif)$/i;

/** Why a photo was not saved — each maps to one message in the `profilePhoto` section. */
export type AvatarProblem = 'type' | 'size' | 'rateLimited' | 'banned' | 'network' | 'generic';

/** Client-side pre-check before anything is uploaded (the server checks again). */
export function checkAvatarFile(file: { type: string; name: string; size: number }): AvatarProblem | null {
  if (!file.type.startsWith('image/') && !HEIC.test(file.name)) return 'type';
  if (file.size > AVATAR_MAX_BYTES) return 'size';
  return null;
}

/** A failed upload / remove → which message to show (413 / 415 / 429 / 403 / network / anything else). */
export function avatarProblem(e: unknown): AvatarProblem {
  if (typeof e !== 'object' || e === null || !('status' in e) || !('code' in e)) return 'generic';
  const { status, code } = e as { status: unknown; code: unknown };
  if (status === 413 || code === 'payload_too_large') return 'size';
  if (status === 415 || code === 'unsupported_media_type') return 'type';
  if (status === 429 || code === 'rate_limited') return 'rateLimited';
  if (status === 403) return 'banned';
  if (code === 'network') return 'network';
  return 'generic';
}

/**
 * entryId → photo URL from GET /v1/league/avatars. The signed-in fan's own entry always follows their `Me`
 * (`avatarUrl` set: that photo, null: no photo), so a change shows at once instead of after the 60 s cache.
 */
export function avatarMap(
  avatars: readonly { entryId: FplEntryId; url: string }[],
  me: { entryId: FplEntryId | null; avatarUrl: string | null } | undefined,
): ReadonlyMap<FplEntryId, string> {
  const map = new Map<FplEntryId, string>(avatars.map((a) => [a.entryId, a.url]));
  if (me && me.entryId !== null) {
    if (me.avatarUrl) map.set(me.entryId, me.avatarUrl);
    else map.delete(me.entryId);
  }
  return map;
}
