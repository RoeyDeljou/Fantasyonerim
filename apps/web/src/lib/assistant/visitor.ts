import { readPref, writePref } from '../prefs';
import { visitorTokenOf } from './fplLad';

/**
 * FPL Lad's returning-visitor token ("identity" event of their script, lib/assistant/fplLad.ts), kept in OUR
 * first-party storage and handed back on init. Safari partitions a third-party script's/iframe's storage per site,
 * so without this Alfie would forget an iPhone visitor between visits. The token identifies the device, not the
 * account, so it survives sign-out; it is never sent anywhere except FPL Lad's own script.
 */
const KEY = 'fant.alfie.visitor';

export function readVisitorToken(): string | undefined {
  return visitorTokenOf({ visitorToken: readPref(KEY) }) ?? undefined;
}

export function saveVisitorToken(token: string): void {
  if (visitorTokenOf({ visitorToken: token })) writePref(KEY, token);
}
