import {
  GameweekRoundupSchema,
  type Chip,
  type EntryPicks,
  type FplEntryId,
  type FplPlayerId,
  type Gameweek,
  type RoundupBench,
  type RoundupKing,
  type RoundupMover,
  type RoundupPlayerPoints,
  type RoundupRow,
  type RoundupTransfer,
  type RoundupTransferPick,
} from '@fant/shared';
import * as zm from 'zod/mini';
import type { EntryHistory, EntryHistoryEvent, EntryTransfer, EventPoints } from './dto.js';

/**
 * Gameweek Roundup ("סיכום מחזור") builder — pure and deterministic: no I/O, no clock, no randomness.
 * Same input → same output, so the API can build it once per official GW and store it.
 *
 * Rules (verified against FPL's real classic standings of league 4611, GW9 + GW10, all 171 members, and the
 * "Second Chance" league 2430021 with start_event 6 — see README "Gameweek Roundup"):
 *
 * - League total after GW g = Σ (GW points − transfer cost) over the member's history rows with
 *   startEvent ≤ event ≤ g. (FPL's overall `total_points` is NOT the league total when startEvent > 1.)
 * - A member is in GW g's table only if their history has a row for g (a team created later is left out of
 *   earlier GWs). lastRank is computed the same way for g − 1 over the members with a row for g − 1; it is
 *   null for everybody when g is the league's first GW, and for a member without a row for g − 1.
 * - Ranking: total desc, then FEWER transfers made (Σ history `event_transfers` over startEvent…g; FPL
 *   doesn't count Wildcard / Free Hit transfers there), and teams equal on both share the rank
 *   ("1, 2, 2, 4"). Display order among equals = the order of `members` (pass FPL's standings order).
 * - Movement = lastRank − rank. Biggest climb / drop by places; ties → higher GW points, then table order.
 *   Null when nobody moved that way.
 * - eventPoints = the GW's points AFTER the transfer cost (so lastTotal + eventPoints = total). NB: FPL's
 *   standings `event_total` shows points BEFORE the hit; transferCost is on every row for the UI.
 * - King = highest eventPoints (ties → higher total, then table order). topPlayers = up to 4 counted
 *   players (multiplier > 0) with points × multiplier, desc (ties → slot). benchBoostPoints only on BB.
 * - Captain = whoever FPL gave the armband to: the pick with multiplier ≥ 2 (the vice when the captain didn't
 *   play); the picked captain when nobody got it (captain and vice both blanked); null without picks.
 * - Bench = highest history `points_on_bench` among teams without a Bench Boost (> 0, else null); ties →
 *   table order. players = bench slots 12–15 in bench order with their GW points.
 * - Transfers on a row = the GW's NET transfers: chains are collapsed (A→B then B→C = A→C; A→B then
 *   B→A disappears), oldest first. Wildcard / Free Hit rows list their real (net) transfers too.
 * - Best / worst transfer: every net transfer of the GW EXCEPT on Wildcard / Free Hit GWs (a rebuilt squad's
 *   out→in pairing is arbitrary, and Free Hit transfers are reverted). gain = in − out (FPL GW points,
 *   no multiplier, hits not counted). Best = max gain (ties → higher in-points, then table order); worst =
 *   min gain (ties → lower in-points, then table order). Both null when there is no such transfer.
 * - League average = mean eventPoints of the table, one decimal. World = FPL's `average_entry_score`.
 * - Every section is null / empty when its data is missing.
 *
 * FPL picks for a finished GW already reflect auto-subs (the sub is moved into the XI slot, the starter to the
 * bench with multiplier 0) and the vice's promotion (captain 0, vice 2/3): Σ points × multiplier = the GW's
 * gross points for every member we checked, so this builder reads the picks as-is.
 */

/** Everything in GameweekRoundup except the API-owned fields. */
export const RoundupCoreSchema = zm.omit(GameweekRoundupSchema, {
  status: true,
  events: true,
  league: true,
  captains: true,
  builtAt: true,
});
export type RoundupCore = zm.infer<typeof RoundupCoreSchema>;

export interface RoundupMemberInput {
  entryId: FplEntryId;
  entryName: string;
  managerName: string;
  /** `getEntryHistory`. null (unknown / failed) → the member is left out of the table. */
  history: EntryHistory | null;
  /** `getEntryTransfers` (whole season; only this GW's are read). null → no transfers shown. */
  transfers: readonly EntryTransfer[] | null;
  /** `getEntryPicks(entryId, event)`. null → no captain / top players / bench players for this member. */
  picks: EntryPicks | null;
}

export interface RoundupInput {
  event: Gameweek;
  /** League members in FPL's standings order (the final tie-break). */
  members: readonly RoundupMemberInput[];
  /** `getEventPoints(event)`: every player's GW points. */
  playerPoints: EventPoints;
  /** FPL's world average for the GW (`Bootstrap.events[].averageScore`). */
  worldAverage: number | null;
  /** The league's first GW (`getLeagueInfo().startEvent`). Default 1. */
  startEvent?: Gameweek;
}

interface Standing {
  index: number;
  total: number;
  transfers: number;
}

interface Member {
  input: RoundupMemberInput;
  index: number;
  row: EntryHistoryEvent;
  chip: Chip | null;
  /** Net transfers of the GW, oldest first. */
  transfers: RoundupTransfer[];
}

const TRANSFER_CHIPS: ReadonlySet<Chip> = new Set<Chip>(['wildcard', 'freehit']);

export function buildGameweekRoundup(input: RoundupInput): RoundupCore {
  const event = input.event as number;
  const startEvent = (input.startEvent as number | undefined) ?? 1;
  const pts = (id: FplPlayerId): number => input.playerPoints.get(id)?.points ?? 0;

  const current = standingsAt(input.members, event, startEvent);
  const previous = event - 1 >= startEvent ? standingsAt(input.members, event - 1, startEvent) : null;

  const members: Member[] = [];
  input.members.forEach((m, index) => {
    if (!current.has(index) || !m.history) return;
    const row = m.history.events.find((e) => (e.event as number) === event);
    if (!row) return;
    members.push({
      input: m,
      index,
      row,
      chip: m.picks?.activeChip ?? m.history.chips.find((c) => (c.event as number) === event)?.chip ?? null,
      transfers: netTransfers((m.transfers ?? []).filter((t) => (t.event as number) === event)),
    });
  });

  const ranks = rank(current);
  const lastRanks = previous ? rank(previous) : null;
  members.sort((a, b) => compareStanding(current.get(a.index), current.get(b.index)));

  const team = (m: Member) => ({
    entryId: m.input.entryId,
    entryName: m.input.entryName,
    managerName: m.input.managerName,
  });

  const table: RoundupRow[] = members.map((m) => ({
    ...team(m),
    rank: ranks.get(m.index) as number,
    lastRank: lastRanks?.get(m.index) ?? null,
    eventPoints: m.row.points,
    total: (current.get(m.index) as Standing).total,
    captainPlayerId: captainOf(m.input.picks),
    chip: m.chip,
    transfers: m.transfers,
    transferCost: m.row.transfersCost,
  }));
  const rowOf = new Map(members.map((m, i) => [m, table[i] as RoundupRow]));

  // ----- king -----
  let king: RoundupKing | null = null;
  const kingMember = best(members, (a, b) => {
    const ra = rowOf.get(a) as RoundupRow;
    const rb = rowOf.get(b) as RoundupRow;
    return rb.eventPoints - ra.eventPoints || rb.total - ra.total;
  });
  if (kingMember) {
    const row = rowOf.get(kingMember) as RoundupRow;
    const picks = kingMember.input.picks;
    const counted = (picks?.picks ?? [])
      .filter((p) => p.multiplier > 0)
      .map((p) => ({ playerId: p.playerId, points: pts(p.playerId) * p.multiplier, slot: p.slot }))
      .sort((a, b) => b.points - a.points || a.slot - b.slot);
    king = {
      ...team(kingMember),
      points: row.eventPoints,
      captainPlayerId: row.captainPlayerId,
      chip: row.chip,
      topPlayers: counted.slice(0, 4).map(({ playerId, points }) => ({ playerId, points })),
      benchBoostPoints:
        row.chip === 'bboost' && picks
          ? picks.picks.filter((p) => p.slot > 11).reduce((s, p) => s + pts(p.playerId) * p.multiplier, 0)
          : null,
    };
  }

  // ----- movers -----
  const mover = (direction: 1 | -1): RoundupMover | null => {
    const moved = table
      .map((r) => ({ r, places: r.lastRank === null ? 0 : (r.lastRank - r.rank) * direction }))
      .filter((x) => x.places > 0);
    const top = best(moved, (a, b) => b.places - a.places || b.r.eventPoints - a.r.eventPoints);
    if (!top) return null;
    const { entryId, entryName, managerName, eventPoints } = top.r;
    return { entryId, entryName, managerName, places: top.places, eventPoints };
  };

  // ----- bench -----
  let benchPoints: RoundupBench | null = null;
  const benchMember = best(
    members.filter((m) => m.chip !== 'bboost' && m.row.pointsOnBench > 0),
    (a, b) => b.row.pointsOnBench - a.row.pointsOnBench,
  );
  if (benchMember) {
    benchPoints = {
      ...team(benchMember),
      points: benchMember.row.pointsOnBench,
      players: (benchMember.input.picks?.picks ?? [])
        .filter((p) => p.slot > 11)
        .sort((a, b) => a.slot - b.slot)
        .map((p): RoundupPlayerPoints => ({ playerId: p.playerId, points: pts(p.playerId) })),
    };
  }

  // ----- transfers -----
  const candidates: RoundupTransferPick[] = [];
  for (const m of members) {
    if (m.chip !== null && TRANSFER_CHIPS.has(m.chip)) continue;
    for (const t of m.transfers) {
      const inPts = pts(t.playerIn);
      const outPts = pts(t.playerOut);
      candidates.push({
        ...team(m),
        playerOut: { playerId: t.playerOut, points: outPts },
        playerIn: { playerId: t.playerIn, points: inPts },
        gain: inPts - outPts,
        transferCost: m.row.transfersCost,
      });
    }
  }
  const bestTransfer = best(candidates, (a, b) => b.gain - a.gain || b.playerIn.points - a.playerIn.points);
  const worstTransfer = best(candidates, (a, b) => a.gain - b.gain || a.playerIn.points - b.playerIn.points);

  const leagueAverage =
    table.length > 0
      ? Math.round((table.reduce((s, r) => s + r.eventPoints, 0) / table.length) * 10) / 10
      : null;
  const worldAverage = input.worldAverage === null ? null : Math.round(input.worldAverage);

  return RoundupCoreSchema.parse({
    event: input.event,
    participants: table.length > 0 ? table.length : null,
    averages:
      leagueAverage === null && worldAverage === null ? null : { league: leagueAverage, world: worldAverage },
    king,
    table,
    biggestClimb: mover(1),
    biggestDrop: mover(-1),
    benchPoints,
    bestTransfer: bestTransfer ?? null,
    worstTransfer: worstTransfer ?? null,
  } satisfies RoundupCore);
}

/** Members with a history row for `gw` → their league total and transfer count after it. */
function standingsAt(
  members: readonly RoundupMemberInput[],
  gw: number,
  startEvent: number,
): Map<number, Standing> {
  const out = new Map<number, Standing>();
  if (gw < startEvent) return out;
  members.forEach((m, index) => {
    const events = m.history?.events ?? [];
    if (!events.some((e) => (e.event as number) === gw)) return;
    let total = 0;
    let transfers = 0;
    for (const e of events) {
      const n = e.event as number;
      if (n < startEvent || n > gw) continue;
      total += e.points;
      transfers += e.transfersMade;
    }
    out.set(index, { index, total, transfers });
  });
  return out;
}

function compareStanding(a: Standing | undefined, b: Standing | undefined): number {
  if (!a || !b) return 0;
  return b.total - a.total || a.transfers - b.transfers || a.index - b.index;
}

/** Competition ranking ("1, 2, 2, 4"): equal total AND equal transfer count share a rank. */
function rank(standings: ReadonlyMap<number, Standing>): Map<number, number> {
  const sorted = [...standings.values()].sort(compareStanding);
  const out = new Map<number, number>();
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    const same = prev !== undefined && prev.total === s.total && prev.transfers === s.transfers;
    out.set(s.index, same ? (out.get(prev.index) as number) : i + 1);
  });
  return out;
}

/** First element under `compare`; stable, so ties fall back to the array's order. */
function best<T>(items: readonly T[], compare: (a: T, b: T) => number): T | undefined {
  let top: T | undefined;
  for (const item of items) if (top === undefined || compare(item, top) < 0) top = item;
  return top;
}

/** The armband as FPL applied it (multiplier ≥ 2), else the picked captain. */
function captainOf(picks: EntryPicks | null): FplPlayerId | null {
  if (!picks) return null;
  const effective = picks.picks.find((p) => p.multiplier >= 2);
  if (effective) return effective.playerId;
  return picks.picks.find((p) => p.isCaptain)?.playerId ?? null;
}

/**
 * Collapses one GW's transfers (oldest first) into the net out → in list: a player bought and sold in the
 * same GW drops out of the chain (A→B, B→C = A→C) and a reversed transfer disappears (A→B, B→A).
 */
export function netTransfers(transfers: readonly EntryTransfer[]): RoundupTransfer[] {
  const pairs: RoundupTransfer[] = transfers.map((t) => ({ playerOut: t.playerOut, playerIn: t.playerIn }));
  // Merge any x, y where x buys the player y sells: x.out → y.in (kept at the earlier position).
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < pairs.length && !merged; i++) {
      for (let j = 0; j < pairs.length && !merged; j++) {
        const x = pairs[i] as RoundupTransfer;
        const y = pairs[j] as RoundupTransfer;
        if (i === j || x.playerIn !== y.playerOut) continue;
        const net = { playerOut: x.playerOut, playerIn: y.playerIn };
        const [first, second] = i < j ? [i, j] : [j, i];
        pairs.splice(second, 1);
        if (net.playerOut === net.playerIn) pairs.splice(first, 1);
        else pairs[first] = net;
        merged = true;
      }
    }
  }
  return pairs;
}
