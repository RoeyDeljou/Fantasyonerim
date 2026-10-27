'use client';

import { useMe } from './queries';

export { isBannedError } from './api';

/**
 * Banned accounts can read but not write. `Me.canPost` is the source of truth; a 403 on a Community write
 * means it changed since `/v1/me` was fetched, so the mutation hooks refetch `me` (see `trackBan` in queries).
 */
/** True while the signed-in account is suspended from posting. */
export function useBanned(): boolean {
  const me = useMe();
  return me.data?.canPost === false;
}
