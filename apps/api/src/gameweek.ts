import type { FplService } from '@fant/fpl';
import type { Gameweek } from '@fant/shared';
import { notFound } from './errors.js';

/** `?event=` default: the current GW, or the next one before the season's first deadline. */
export async function resolveEvent(fpl: FplService, event: Gameweek | undefined): Promise<Gameweek> {
  if (event !== undefined) return event;
  const bootstrap = await fpl.getBootstrap();
  const resolved = bootstrap.currentEvent ?? bootstrap.nextEvent;
  if (resolved === null) throw notFound('There is no current or upcoming gameweek');
  return resolved;
}
