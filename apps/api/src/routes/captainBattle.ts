import { mapWithConcurrency } from '@fant/fpl';
import {
  CaptainBattleSchema,
  FplEntryIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  type CaptainBattleRow,
  type EntryPicks,
  type FplEntryId,
  type FplPlayerId,
  type Gameweek,
  type PlayerLive,
} from '@fant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { getLatestBattle } from '../settings.js';
import { serialize } from '../validate.js';

/** Max concurrent picks fetches for entry-linked rows. */
const PICKS_CONCURRENCY = 5;

interface PendingRow {
  key: string;
  label: string;
  kind: CaptainBattleRow['kind'];
  source: CaptainBattleRow['source'];
  entryId: FplEntryId | null;
  /** Null when an entry-linked team's captain isn't known (picks hidden before the deadline, or failed). */
  playerId: FplPlayerId | null;
  multiplier: number;
}

interface Captain {
  playerId: FplPlayerId;
  multiplier: number;
}

function captainOf(picks: EntryPicks): Captain | null {
  const captain = picks.picks.find((p) => p.isCaptain);
  if (!captain) return null;
  return { playerId: captain.playerId, multiplier: captain.multiplier === 3 ? 3 : 2 };
}

export function captainBattleRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  app.get('/v1/captain-battle', async (request: FastifyRequest) => {
    const now = ctx.clock.now().toISOString();
    const battle = await getLatestBattle(ctx.prisma);
    if (!battle) return serialize(CaptainBattleSchema, { event: null, rows: [], updatedAt: now });
    const event: Gameweek = GameweekSchema.parse(battle.event);

    const viewer = await auth.resolve(request);
    const viewerEntry =
      viewer && viewer.user.entryId !== null ? FplEntryIdSchema.parse(viewer.user.entryId) : null;

    // Every team whose captain we need (linked rows + the viewer), fetched once each, in parallel (bounded).
    const linked = battle.entries.flatMap((e) =>
      e.source === 'ENTRY' && e.entryId !== null ? [FplEntryIdSchema.parse(e.entryId)] : [],
    );
    const entryIds = [...new Set(viewerEntry === null ? linked : [...linked, viewerEntry])];
    const captains = new Map<number, Captain | null>();
    await mapWithConcurrency(entryIds, PICKS_CONCURRENCY, async (entryId) => {
      try {
        captains.set(entryId, captainOf(await ctx.fpl.getEntryPicks(entryId, event)));
      } catch (err) {
        // 404 before the deadline (FPL hides picks) or any upstream error: captain unknown, row stays.
        request.log.info({ err, entryId }, 'captain battle: picks unavailable');
        captains.set(entryId, null);
      }
    });

    const rows: PendingRow[] = battle.entries.map((e) => {
      const base = {
        key: e.id,
        label: e.label,
        kind: e.kind === 'COMMUNITY' ? 'community' : 'custom',
      } as const;
      if (e.source === 'ENTRY' && e.entryId !== null) {
        const entryId = FplEntryIdSchema.parse(e.entryId);
        const captain = captains.get(entryId) ?? null;
        return {
          ...base,
          source: 'entry',
          entryId,
          playerId: captain?.playerId ?? null,
          multiplier: captain?.multiplier ?? 2,
        };
      }
      return {
        ...base,
        source: 'player',
        entryId: null,
        playerId: FplPlayerIdSchema.parse(e.playerId),
        multiplier: 2,
      };
    });

    if (viewer && viewerEntry !== null) {
      const mine = captains.get(viewerEntry) ?? null;
      // The viewer's own row is only shown when their captain is known.
      if (mine) {
        rows.push({
          key: 'me',
          label: viewer.user.name,
          kind: 'mine',
          source: 'mine',
          entryId: viewerEntry,
          playerId: mine.playerId,
          multiplier: mine.multiplier,
        });
      }
    }

    const ids = [...new Set(rows.flatMap((r) => (r.playerId === null ? [] : [r.playerId])))];
    const live = ids.length > 0 ? await ctx.fpl.getPlayersLive(ids, event) : [];
    const byId = new Map<number, PlayerLive>(live.map((p) => [p.playerId, p]));

    const result = rows
      .map((row, index) => {
        const playerLive: PlayerLive | null =
          row.playerId === null
            ? null
            : (byId.get(row.playerId) ?? {
                playerId: row.playerId,
                basePoints: 0,
                minutes: 0,
                provisionalBonus: 0,
                fixtureStatus: 'no_fixture',
              });
        return {
          index,
          row: {
            key: row.key,
            label: row.label,
            kind: row.kind,
            source: row.source,
            entryId: row.entryId,
            playerId: row.playerId,
            multiplier: row.multiplier,
            captainPoints: playerLive ? playerLive.basePoints * row.multiplier : 0,
            live: playerLive,
          },
        };
      })
      // Resolved rows by captain points (stable), unresolved rows last (stable).
      .sort((a, b) => {
        const ra = a.row.live === null ? 1 : 0;
        const rb = b.row.live === null ? 1 : 0;
        return ra - rb || b.row.captainPoints - a.row.captainPoints || a.index - b.index;
      })
      .map((r) => r.row);

    return serialize(CaptainBattleSchema, { event, rows: result, updatedAt: now }, 'CaptainBattle');
  });
}
