/**
 * Pure helpers for the captain badge ("tag") shown over a captain row (components/team/CaptainCard.tsx) and the
 * admin editor's tag placeholder. No React, so they are unit-tested directly (captains.test.ts).
 */

export type CaptainRowKind = 'community' | 'fpl_lad' | 'custom' | 'mine';
export type CaptainRowSource = 'player' | 'entry' | 'mine';

/** The two permanent special captains: always in the battle and on the season leaderboard. */
export const PERMANENT_KINDS = ['community', 'fpl_lad'] as const;
export type PermanentKind = (typeof PERMANENT_KINDS)[number];

export function isPermanentKind(kind: string): kind is PermanentKind {
  return kind === 'community' || kind === 'fpl_lad';
}

export const MAX_TAG_LENGTH = 24;

export interface CaptainBadgeLabels {
  mine: string;
  community: string;
  linkedTeam: string;
}

/** What to draw: `text` (null = none) and whether the FPL Lad logo goes right before it. */
export interface CaptainBadge {
  text: string | null;
  logo: boolean;
}

/** The admin's tag when set (blank = not set), else null. */
export function customTag(tag: string | null | undefined): string | null {
  const v = tag?.trim();
  return v ? v : null;
}

/**
 * The badge of a captain row. A set tag wins over the default; the default is "My captain" for the viewer's own
 * row, "Community", "FPL team" for a team-linked row, nothing for a hand-picked player, and for FPL Lad the logo
 * alone. The FPL Lad logo is part of that row's badge whatever the text.
 */
export function captainBadge(
  row: { kind: CaptainRowKind; source?: CaptainRowSource | undefined; tag?: string | null | undefined },
  labels: CaptainBadgeLabels,
): CaptainBadge {
  const logo = row.kind === 'fpl_lad';
  const tag = row.kind === 'mine' ? null : customTag(row.tag);
  if (tag !== null) return { text: tag, logo };
  return { text: defaultTagText(row.kind, row.source, labels), logo };
}

/** The default badge text (null = none: FPL Lad shows its logo alone, a hand-picked custom player shows nothing). */
export function defaultTagText(
  kind: CaptainRowKind,
  source: CaptainRowSource | undefined,
  labels: CaptainBadgeLabels,
): string | null {
  if (kind === 'mine') return labels.mine;
  if (kind === 'community') return labels.community;
  if (kind === 'fpl_lad') return null;
  return source === 'entry' ? labels.linkedTeam : null;
}

/** Tag text to send to the API: trimmed, capped, blank = null (the default). */
export function normalizeTag(tag: string): string | null {
  return customTag(tag.slice(0, MAX_TAG_LENGTH));
}
