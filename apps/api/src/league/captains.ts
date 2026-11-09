import type { CaptainBattleEntryInput, CaptainBattleEntryKind as SharedKind } from '@fant/shared';
import type { CaptainBattleEntryKind as DbKind, PrismaClient } from '@prisma/client';

/**
 * The captain battle's two PERMANENT special captains: the community's and FPL Lad's. Every battle has exactly one
 * row of each (hand-picked, so it follows the per-GW semantics of player rows); anything else the admin adds is
 * `custom`. They are always shown (a virtual "not picked yet" row when the saved battle has none) and they rank in
 * the season leaderboard next to the league's members.
 */
export const PERMANENT_KINDS = ['community', 'fpl_lad'] as const;
export type PermanentKind = (typeof PERMANENT_KINDS)[number];

/** Default row labels, used for a permanent captain the admin never saved. */
export const DEFAULT_CAPTAIN_LABELS: Readonly<Record<PermanentKind, string>> = {
  community: 'קפטן הקהילה',
  fpl_lad: 'הקפטן של FPL Lad',
};

/** "FPL Lad", "FPL-Lad", "fplLad": the label the legacy FPL Lad row was saved under (as kind COMMUNITY). */
export const FPL_LAD_LABEL = /fpl\s*-?\s*lad/i;

export function kindFromDb(kind: DbKind): SharedKind {
  return kind === 'COMMUNITY' ? 'community' : kind === 'FPL_LAD' ? 'fpl_lad' : 'custom';
}

export function kindToDb(kind: SharedKind): DbKind {
  return kind === 'community' ? 'COMMUNITY' : kind === 'fpl_lad' ? 'FPL_LAD' : 'CUSTOM';
}

/**
 * The entries with the two permanent captains guaranteed: a missing community / fpl_lad row is added first, with the
 * default label and no player yet ("not picked yet"). Saved rows keep their order.
 */
export function withPermanentEntries<T extends { kind: SharedKind }>(
  entries: readonly T[],
): (T | CaptainBattleEntryInput)[] {
  const missing = PERMANENT_KINDS.filter((k) => !entries.some((e) => e.kind === k)).map(
    (kind): CaptainBattleEntryInput => ({
      label: DEFAULT_CAPTAIN_LABELS[kind],
      kind,
      tag: null,
      source: 'player',
      playerId: null,
    }),
  );
  return [...missing, ...entries];
}

/** Empty / whitespace-only → null (the client shows its default badge). */
export const cleanTag = (tag: string | null | undefined): string | null => {
  const t = tag?.trim() ?? '';
  return t === '' ? null : t;
};

/**
 * Idempotent upgrade of saved battles to the permanent-captain model, run at boot (after the server is listening):
 *  1. an entry labelled like "FPL Lad" whose kind isn't FPL_LAD becomes FPL_LAD (production had it saved as
 *     COMMUNITY, which is why it wore the community badge);
 *  2. a battle can hold one COMMUNITY and one FPL_LAD row: of duplicates the first by `order` stays, the rest become
 *     CUSTOM.
 * Only changed rows are written, so a second run is a no-op. Returns the number of entries changed.
 */
export async function upgradeCaptainKinds(prisma: PrismaClient): Promise<number> {
  const battles = await prisma.captainBattle.findMany({
    select: {
      id: true,
      entries: {
        select: { id: true, label: true, kind: true, source: true, playerId: true },
        orderBy: { order: 'asc' },
      },
    },
  });
  let changed = 0;
  for (const battle of battles) {
    const seen = new Set<DbKind>();
    const updates: { id: string; kind: DbKind }[] = [];
    const removals: string[] = [];
    for (const entry of battle.entries) {
      let kind: DbKind = FPL_LAD_LABEL.test(entry.label) ? 'FPL_LAD' : entry.kind;
      if (kind !== 'CUSTOM') {
        if (seen.has(kind)) kind = 'CUSTOM';
        else seen.add(kind);
      }
      if (kind === entry.kind) continue;
      // A duplicate permanent row with no player cannot become CUSTOM (a custom row needs a player): drop it.
      if (kind === 'CUSTOM' && entry.source === 'PLAYER' && entry.playerId === null) removals.push(entry.id);
      else updates.push({ id: entry.id, kind });
    }
    if (updates.length + removals.length === 0) continue;
    await prisma.$transaction([
      ...updates.map((u) =>
        prisma.captainBattleEntry.update({ where: { id: u.id }, data: { kind: u.kind } }),
      ),
      prisma.captainBattleEntry.deleteMany({ where: { id: { in: removals } } }),
    ]);
    changed += updates.length + removals.length;
  }
  return changed;
}
