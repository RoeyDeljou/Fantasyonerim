import { RoundupCoreSchema } from '@fant/fpl';
import {
  CLIENT_HOSTS,
  GameweekSchema,
  RoundupCaptainSchema,
  SeasonCaptainsSchema,
  type FplEntryId,
  type FplLeagueId,
  type SeasonCaptainRow,
  type SeasonCaptains,
} from '@fant/shared';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { serialize } from '../validate.js';
import { FPL_LAD_LABEL, type PermanentKind } from './captains.js';

/**
 * The first GW (inclusive) that counts towards the season Captain Battle. Client decision (Nov 2026): the competition
 * starts at GW10, because the community and FPL Lad captains only have data from there, so everybody competes on equal
 * ground. Earlier stored roundups are ignored for teams and special captains alike. To change the start of the
 * competition, edit this (the in-memory hot copy is rebuilt on restart / within a minute).
 */
export const SEASON_CAPTAINS_FROM_EVENT = GameweekSchema.parse(10);

/** Hot-cache key prefix of the season leaderboard (dropped when a roundup is stored or the config changes). */
export const SEASON_CAPTAINS_HOT_PREFIX = 'league:season-captains:';

/** Rows stored by builder versions below this have the FPL Lad captain as `community` and no tags. */
const FPL_LAD_KIND_VERSION = 3;

/** Team ID → which podcast host owns it. */
const HOST_BY_ENTRY = new Map<number, 'dor' | 'itay'>(
  (['dor', 'itay'] as const).map((h) => [Number(CLIENT_HOSTS[h].fplEntryId), h]),
);

const CaptainPointsSchema = z.record(z.string(), z.number().int());
const CaptainRowsSchema = z.array(RoundupCaptainSchema);

interface Tally {
  name: string;
  subtitle: string | null;
  tag: string | null;
  entryId: FplEntryId | null;
  points: number;
  gameweeks: number;
}

/**
 * Season Captain Battle ("קרב קפטנים עונתי"): total captain points over every stored official-GW roundup of
 * `leagueId`, from the database only (no FPL calls). A member's GW captain points = base points of the table row's
 * `captainPlayerId` (from the stored `captainPoints` map) × 3 on Triple Captain, else × 2; a row without a captain
 * counts 0 and not as a GW. The community and FPL Lad captains sum the `captainPoints` of their stored captain rows
 * (rows with a player only count as a GW) and are left out with no counted GW. Rows that no longer parse are skipped.
 * Ranks are competition ranks (1, 2, 2, 4) over points desc, then name.
 */
export async function computeSeasonCaptains(
  prisma: PrismaClient,
  leagueId: FplLeagueId | null,
  now: Date,
): Promise<SeasonCaptains> {
  const updatedAt = now.toISOString();
  if (leagueId === null) {
    return serialize(
      SeasonCaptainsSchema,
      { status: 'unavailable', league: null, throughEvent: null, rows: [], updatedAt },
      'SeasonCaptains',
    );
  }
  const stored = await prisma.gameweekRoundup.findMany({
    where: { leagueId, event: { gte: SEASON_CAPTAINS_FROM_EVENT } },
    orderBy: { event: 'asc' },
    select: {
      event: true,
      leagueName: true,
      data: true,
      captains: true,
      captainPoints: true,
      buildVersion: true,
    },
  });

  const managers = new Map<number, Tally>();
  const specials = new Map<PermanentKind, Tally>();
  let throughEvent: number | null = null;
  let leagueName: string | null = null;

  for (const row of stored) {
    const core = RoundupCoreSchema.safeParse(row.data);
    const captains = CaptainRowsSchema.safeParse(row.captains);
    const basePoints = CaptainPointsSchema.safeParse(row.captainPoints);
    if (!core.success || !captains.success || !basePoints.success) continue;
    throughEvent = row.event; // ascending: the last usable row is the highest GW
    leagueName = row.leagueName;

    for (const t of core.data.table) {
      const tally = managers.get(t.entryId) ?? {
        name: t.entryName,
        subtitle: t.managerName,
        tag: null,
        entryId: t.entryId,
        points: 0,
        gameweeks: 0,
      };
      tally.name = t.entryName;
      tally.subtitle = t.managerName;
      if (t.captainPlayerId !== null) {
        tally.points += (basePoints.data[String(t.captainPlayerId)] ?? 0) * (t.chip === '3xc' ? 3 : 2);
        tally.gameweeks += 1;
      }
      managers.set(t.entryId, tally);
    }

    for (const c of captains.data) {
      // Before v3 the FPL Lad captain was stored as a community row.
      const kind =
        c.kind === 'community' && row.buildVersion < FPL_LAD_KIND_VERSION && FPL_LAD_LABEL.test(c.label)
          ? 'fpl_lad'
          : c.kind;
      if (kind !== 'community' && kind !== 'fpl_lad') continue;
      const tally = specials.get(kind) ?? {
        name: c.label,
        subtitle: null,
        tag: null,
        entryId: null,
        points: 0,
        gameweeks: 0,
      };
      tally.name = c.label;
      tally.tag = c.tag;
      if (c.playerId !== null) {
        tally.points += c.captainPoints;
        tally.gameweeks += 1;
      }
      specials.set(kind, tally);
    }
  }

  if (throughEvent === null) {
    return serialize(
      SeasonCaptainsSchema,
      {
        status: 'building',
        league: null,
        throughEvent: null,
        fromEvent: SEASON_CAPTAINS_FROM_EVENT,
        rows: [],
        updatedAt,
      },
      'SeasonCaptains',
    );
  }

  const unranked: Omit<SeasonCaptainRow, 'rank'>[] = [
    ...[...managers].map(([entryId, t]) => ({
      kind: 'manager' as const,
      key: String(entryId),
      entryId: t.entryId,
      name: t.name,
      subtitle: t.subtitle,
      tag: null,
      host: HOST_BY_ENTRY.get(entryId) ?? null,
      points: t.points,
      gameweeks: t.gameweeks,
    })),
    ...[...specials]
      .filter(([, t]) => t.gameweeks > 0)
      .map(([kind, t]) => ({
        kind,
        key: kind,
        entryId: null,
        name: t.name,
        subtitle: null,
        tag: t.tag,
        host: null,
        points: t.points,
        gameweeks: t.gameweeks,
      })),
  ].sort((a, b) => b.points - a.points || cmp(a.name, b.name) || cmp(a.key, b.key));

  // Competition ranking: equal points share the rank of the first of them.
  const rows = unranked.map((row, i) => ({
    ...row,
    rank: i > 0 && unranked[i - 1]?.points === row.points ? 0 : i + 1,
  }));
  rows.forEach((row, i) => {
    if (row.rank === 0) row.rank = rows[i - 1]?.rank ?? 1;
  });

  return serialize(
    SeasonCaptainsSchema,
    {
      status: 'ready',
      league: { id: leagueId, name: leagueName ?? '' },
      throughEvent,
      fromEvent: SEASON_CAPTAINS_FROM_EVENT,
      rows,
      updatedAt,
    },
    'SeasonCaptains',
  );
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
