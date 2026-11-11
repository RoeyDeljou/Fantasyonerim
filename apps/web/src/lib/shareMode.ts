import type { CommunityCaptainState } from '@fant/shared';

/**
 * The share sheet's two pictures (screens/admin/ShareCaptains.tsx): the Captain Battle poster of the saved selection,
 * or the "come and vote" invitation. Pure helpers, unit-tested in shareMode.test.ts.
 */
export type ShareMode = 'battle' | 'vote';

/** Why the vote invitation can't be shared (null = it can). `gw` is the number the reason text names. */
export type VoteShareBlock =
  | { kind: 'not_open'; gw: number | null }
  | { kind: 'locked'; gw: number | null }
  | { kind: 'no_event' }
  /** The vote state hasn't loaded (or failed to). */
  | { kind: 'unavailable' };

export interface ShareModeInfo {
  /** The mode a sheet opens in when nobody asked for one: the vote while it is open, else the battle. */
  defaultMode: ShareMode;
  voteBlocked: VoteShareBlock | null;
}

export function shareModeInfo(
  state: Pick<CommunityCaptainState, 'status' | 'event' | 'opensAfterEvent'> | undefined,
): ShareModeInfo {
  if (!state) return { defaultMode: 'battle', voteBlocked: { kind: 'unavailable' } };
  if (state.event === null) return { defaultMode: 'battle', voteBlocked: { kind: 'no_event' } };
  if (state.status === 'open') return { defaultMode: 'vote', voteBlocked: null };
  if (state.status === 'not_open') {
    return { defaultMode: 'battle', voteBlocked: { kind: 'not_open', gw: state.opensAfterEvent } };
  }
  return { defaultMode: 'battle', voteBlocked: { kind: 'locked', gw: state.event } };
}

/** The mode actually shown: what the admin picked, else what the entry point asked for, else the default; never a blocked vote. */
export function effectiveShareMode(
  info: ShareModeInfo,
  picked: ShareMode | null,
  requested: ShareMode | undefined,
): ShareMode {
  const wanted = picked ?? requested ?? info.defaultMode;
  return wanted === 'vote' && info.voteBlocked ? 'battle' : wanted;
}

export interface VoteCaptionTemplates {
  /** "… {gw} … {when}" */
  withDeadline: string;
  /** "… {gw} …" */
  withoutDeadline: string;
}

/** The post text that goes with the vote poster (the link travels in the share `url`). */
export function voteCaption(t: VoteCaptionTemplates, gw: number, when: string | null): string {
  return (when ? t.withDeadline : t.withoutDeadline)
    .replace('{gw}', String(gw))
    .replace('{when}', when ?? '');
}
