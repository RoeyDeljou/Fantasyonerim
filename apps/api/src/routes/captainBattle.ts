import {
  CaptainBattleSchema,
  FplEntryIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  type CaptainBattleRow,
  type FplPlayerId,
  type Gameweek,
  type PlayerLive,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { getLatestBattle } from '../settings.js';
import { serialize } from '../validate.js';

interface PendingRow {
  key: string;
  label: string;
  kind: CaptainBattleRow['kind'];
  playerId: FplPlayerId;
  multiplier: number;
}

export function captainBattleRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  /** The signed-in viewer's own captain for `event`, or null (no team, or picks unavailable). */
  async function mineRow(
    request: Parameters<Auth['resolve']>[0],
    event: Gameweek,
  ): Promise<PendingRow | null> {
    const viewer = await auth.resolve(request);
    if (!viewer || viewer.user.entryId === null) return null;
    try {
      const picks = await ctx.fpl.getEntryPicks(FplEntryIdSchema.parse(viewer.user.entryId), event);
      const captain = picks.picks.find((p) => p.isCaptain);
      if (!captain) return null;
      return {
        key: 'me',
        label: viewer.user.name,
        kind: 'mine',
        playerId: captain.playerId,
        multiplier: captain.multiplier === 3 ? 3 : 2,
      };
    } catch (err) {
      // A failing picks fetch must not take the whole battle down — just omit the row.
      request.log.warn({ err }, 'captain battle: could not load viewer picks');
      return null;
    }
  }

  app.get('/v1/captain-battle', async (request) => {
    const now = ctx.clock.now().toISOString();
    const battle = await getLatestBattle(ctx.prisma);
    if (!battle) return serialize(CaptainBattleSchema, { event: null, rows: [], updatedAt: now });

    const event = GameweekSchema.parse(battle.event);
    const rows: PendingRow[] = battle.entries.map((e) => ({
      key: e.id,
      label: e.label,
      kind: e.kind === 'COMMUNITY' ? 'community' : 'custom',
      playerId: FplPlayerIdSchema.parse(e.playerId),
      multiplier: 2,
    }));
    const mine = await mineRow(request, event);
    if (mine) rows.push(mine);

    const ids = [...new Set(rows.map((r) => r.playerId))];
    const live = ids.length > 0 ? await ctx.fpl.getPlayersLive(ids, event) : [];
    const byId = new Map<number, PlayerLive>(live.map((p) => [p.playerId, p]));

    const result = rows
      .map((row, index) => {
        const playerLive: PlayerLive = byId.get(row.playerId) ?? {
          playerId: row.playerId,
          basePoints: 0,
          minutes: 0,
          provisionalBonus: 0,
          fixtureStatus: 'no_fixture',
        };
        return {
          index,
          row: {
            key: row.key,
            label: row.label,
            kind: row.kind,
            playerId: row.playerId,
            multiplier: row.multiplier,
            captainPoints: playerLive.basePoints * row.multiplier,
            live: playerLive,
          },
        };
      })
      .sort((a, b) => b.row.captainPoints - a.row.captainPoints || a.index - b.index)
      .map((r) => r.row);

    return serialize(CaptainBattleSchema, { event, rows: result, updatedAt: now }, 'CaptainBattle');
  });
}
