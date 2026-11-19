import { removePref } from '../prefs';

/**
 * Where the FPL Lad sign-in that their /chat iframe hands us (lib/assistant/fplLadBridge.ts) is kept on this device.
 * Its own tiny module so the session code (lib/session.tsx) can clear it on sign-out / account deletion without
 * pulling the bridge into the main chunk.
 */
export const FPL_LAD_AUTH_KEY = 'fant.alfie.auth';

/** Forgets the stored FPL Lad sign-in (a shared phone's next user doesn't land in someone else's Alfie). */
export function clearFplLadAuth(): void {
  removePref(FPL_LAD_AUTH_KEY);
}
