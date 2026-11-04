import type { FplService } from '@fant/fpl';
import type { FplLeagueId } from '@fant/shared';

/**
 * Managers who joined the league after FPL's last standings update ("new entries"): FPL lists them separately
 * and only ranks them after the next GW update. FplService shares the read with standings page 1 (cached, 2 min);
 * an FplService without the method (it is optional) has no new entries.
 */
export async function leagueNewEntryIds(
  fpl: FplService,
  leagueId: FplLeagueId,
): Promise<ReadonlySet<number>> {
  return new Set((await fpl.getLeagueNewEntries?.(leagueId)) ?? []);
}
