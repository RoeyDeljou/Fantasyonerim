import {
  CommunityCaptainResultSchema,
  FplPlayerIdSchema,
  type CommunityCaptainResult,
  type CommunityCaptainTallyRow,
  type Gameweek,
} from '@fant/shared';
import type { CommunityCaptainResult as ResultRow, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DEFAULT_CAPTAIN_LABELS } from '../league/captains.js';
import { SEASON_CAPTAINS_HOT_PREFIX } from '../league/seasonCaptains.js';
import { serialize } from '../validate.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Hot-cache key of the shared (guest) part of GET /v1/community-captain. */
export const COMMUNITY_CAPTAIN_HOT_KEY = 'community-captain:state';
/** Rows kept in the stored result (the admin card shows up to 20); fans see the first FAN_TOP. */
export const STORED_TOP = 20;
export const FAN_TOP = 5;

export interface Tally {
  total: number;
  /** Highest first; ties by player id so the order is stable. */
  rows: CommunityCaptainTallyRow[];
}

export async function tallyOf(db: Db, event: number): Promise<Tally> {
  const groups = await db.communityCaptainVote.groupBy({
    by: ['playerId'],
    // A banned account's earlier vote no longer counts.
    where: { event, user: { bannedAt: null } },
    _count: { _all: true },
  });
  const rows = groups
    .map((g) => ({ playerId: FplPlayerIdSchema.parse(g.playerId), votes: g._count._all }))
    .sort((a, b) => b.votes - a.votes || a.playerId - b.playerId);
  return { total: rows.reduce((n, r) => n + r.votes, 0), rows };
}

/** The players sharing the highest count (empty without votes). */
export function leadersOf(tally: Tally): CommunityCaptainTallyRow[] {
  const top = tally.rows[0];
  return top === undefined ? [] : tally.rows.filter((r) => r.votes === top.votes);
}

const IntArraySchema = z.array(z.number().int());
const TopSchema = z.array(z.object({ playerId: z.number().int(), votes: z.number().int() }));

/** A stored result row → the contract's result (`top` cut to `topLimit`). */
export function toResult(row: ResultRow, topLimit: number): CommunityCaptainResult {
  const status =
    row.status === 'decided' || row.status === 'tied' || row.status === 'no_votes' ? row.status : null;
  if (status === null) throw new Error(`Unknown community captain result status "${row.status}"`);
  const source = row.source === 'votes' || row.source === 'admin' ? row.source : null;
  return serialize(
    CommunityCaptainResultSchema,
    {
      status,
      source,
      winnerPlayerId: row.winnerPlayerId,
      tiedPlayerIds: IntArraySchema.catch([]).parse(row.tiedPlayerIds),
      totalVotes: row.totalVotes,
      top: TopSchema.catch([]).parse(row.top).slice(0, topLimit),
    },
    'CommunityCaptainResult',
  );
}

/** Locked, but the job hasn't tallied yet. */
export const PENDING_RESULT: CommunityCaptainResult = {
  status: 'pending',
  source: null,
  winnerPlayerId: null,
  tiedPlayerIds: [],
  totalVotes: 0,
  top: [],
};

export function resultOf(row: ResultRow | null, topLimit: number): CommunityCaptainResult {
  return row === null ? PENDING_RESULT : toResult(row, topLimit);
}

// ---------- captain battle storage ----------

export interface CommunityPick {
  /** A battle for exactly this GW exists. */
  battleExists: boolean;
  /** The community row is set by hand for this GW (a player, or linked to a team). */
  isSet: boolean;
  /** The hand-picked player (null when unset or team-linked). */
  playerId: number | null;
}

/** The community captain of the battle saved for exactly `event`. */
export async function communityPickOf(db: Db, event: number): Promise<CommunityPick> {
  const battle = await db.captainBattle.findUnique({
    where: { event },
    include: { entries: { where: { kind: 'COMMUNITY' }, orderBy: { order: 'asc' } } },
  });
  if (battle === null) return { battleExists: false, isSet: false, playerId: null };
  const row = battle.entries[0];
  if (row === undefined) return { battleExists: true, isSet: false, playerId: null };
  return {
    battleExists: true,
    isSet: row.source === 'ENTRY' || row.playerId !== null,
    playerId: row.source === 'PLAYER' ? row.playerId : null,
  };
}

/**
 * Sets the community captain's player in the captain battle saved for `event`.
 *
 * - No battle for `event` yet: it is created from the latest earlier battle, like an admin saving the editor for
 *   the new GW: the same rows in the same order with their labels and tags; team-linked rows keep their team; the
 *   FPL Lad row starts "not picked yet" (a hand-picked player belongs to the GW it was picked for, which is what the
 *   live battle's rollover shows); other hand-picked rows keep their player (the DB check requires one on a custom
 *   row). No earlier battle: just the two permanent rows.
 * - `overwrite: false` leaves a community row that is already set (a manual pick) alone and says so.
 */
export async function setCommunityPlayer(
  tx: Prisma.TransactionClient,
  event: Gameweek,
  playerId: number,
  now: Date,
  overwrite: boolean,
): Promise<{ applied: boolean; existingPlayerId: number | null }> {
  // Serialises concurrent writers for this GW (job vs admin) inside the transaction.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${7_000_000 + event})`;
  const current = await communityPickOf(tx, event);
  if (current.isSet && !overwrite) return { applied: false, existingPlayerId: current.playerId };

  const newest = await tx.captainBattle.findFirst({
    where: { event: { gt: event } },
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });
  let battle = await tx.captainBattle.findUnique({ where: { event }, include: { entries: true } });
  if (battle === null) {
    const earlier = await tx.captainBattle.findFirst({
      where: { event: { lt: event } },
      orderBy: { event: 'desc' },
      include: { entries: { orderBy: { order: 'asc' } } },
    });
    const rows = (earlier?.entries ?? []).map((e) => ({
      label: e.label,
      kind: e.kind,
      tag: e.tag,
      source: e.source,
      entryId: e.entryId,
      playerId: e.kind === 'FPL_LAD' && e.source === 'PLAYER' ? null : e.playerId,
    }));
    for (const kind of ['FPL_LAD', 'COMMUNITY'] as const) {
      if (rows.some((r) => r.kind === kind)) continue;
      rows.unshift({
        label: DEFAULT_CAPTAIN_LABELS[kind === 'COMMUNITY' ? 'community' : 'fpl_lad'],
        kind,
        tag: null,
        source: 'PLAYER',
        entryId: null,
        playerId: null,
      });
    }
    battle = await tx.captainBattle.create({
      data: {
        event,
        createdAt: now,
        // A battle created for an older GW must not become the publicly shown (latest saved) one.
        updatedAt: newest === null ? now : new Date(newest.updatedAt.getTime() - 1),
        entries: { create: rows.map((r, order) => ({ ...r, order })) },
      },
      include: { entries: true },
    });
  }

  const community = [...battle.entries].sort((a, b) => a.order - b.order).find((e) => e.kind === 'COMMUNITY');
  if (community === undefined) {
    const next = Math.max(-1, ...battle.entries.map((e) => e.order)) + 1;
    await tx.captainBattleEntry.create({
      data: {
        battleId: battle.id,
        order: next,
        label: DEFAULT_CAPTAIN_LABELS.community,
        kind: 'COMMUNITY',
        source: 'PLAYER',
        playerId,
      },
    });
  } else {
    await tx.captainBattleEntry.update({
      where: { id: community.id },
      data: { source: 'PLAYER', playerId, entryId: null },
    });
  }
  // The most recently saved battle is the one shown publicly (like the admin save), unless a newer GW has a battle:
  // a late tie-break of an older GW must not change what is shown.
  if (newest === null) {
    await tx.captainBattle.update({ where: { id: battle.id }, data: { updatedAt: now } });
  }
  return { applied: true, existingPlayerId: current.playerId };
}

/** The battle / season / vote hot responses changed. */
export function invalidateCaptainCaches(ctx: Pick<AppContext, 'hot'>): void {
  ctx.hot.invalidateConfig();
  ctx.hot.cache.invalidate(SEASON_CAPTAINS_HOT_PREFIX);
  ctx.hot.cache.invalidate(COMMUNITY_CAPTAIN_HOT_KEY);
}
