import {
  CaptainBattleSchema,
  FplEntryIdSchema,
  FplPlayerIdSchema,
  type CaptainBattle,
  type CaptainBattleRow,
  type FplEntryId,
  type Gameweek,
} from '@fant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth, AuthContext } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import { captainOf, emptyPlayerLive, sortBattleRows } from '../perf/hotData.js';
import { serialize } from '../validate.js';

/**
 * The captain battle. Everything but the viewer's own row is computed once per TTL for everybody (ctx.hot:
 * the battle, its GW, the team-linked rows' captains and live points). A signed-in viewer with a team adds
 * one row per request, from FplService's cached picks and the shared live GW data.
 */
export function captainBattleRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  async function viewerRow(
    shared: CaptainBattle,
    viewer: AuthContext,
    entryId: FplEntryId,
    event: Gameweek,
    request: FastifyRequest,
  ): Promise<CaptainBattleRow | null> {
    let captain: ReturnType<typeof captainOf>;
    // The viewer's team is already a row of the battle: same captain, no second picks lookup.
    const linked = shared.rows.find((r) => r.source === 'entry' && r.entryId === entryId);
    if (linked !== undefined) {
      captain =
        linked.playerId === null ? null : { playerId: linked.playerId, multiplier: linked.multiplier };
    } else {
      try {
        captain = captainOf(await ctx.fpl.getEntryPicks(entryId, event));
      } catch (err) {
        // 404 before the deadline (FPL hides picks) or any upstream error: no "mine" row.
        request.log.info({ err, entryId }, 'captain battle: picks unavailable');
        return null;
      }
    }
    // The viewer's own row is only shown when their captain is known.
    if (captain === null) return null;
    const playerId = FplPlayerIdSchema.parse(captain.playerId);
    const [live] = await ctx.fpl.getPlayersLive([playerId], event);
    const playerLive = live ?? emptyPlayerLive(playerId);
    return {
      key: 'me',
      label: viewer.user.name,
      kind: 'mine',
      tag: null,
      source: 'mine',
      entryId,
      playerId,
      multiplier: captain.multiplier,
      captainPoints: playerLive.basePoints * captain.multiplier,
      live: playerLive,
    };
  }

  app.get('/v1/captain-battle', async (request, reply) => {
    const shared = await ctx.hot.captainBattle();
    const viewer = await auth.resolve(request);
    const viewerEntry =
      viewer && viewer.user.entryId !== null ? FplEntryIdSchema.parse(viewer.user.entryId) : null;
    if (viewer === null || viewerEntry === null || shared.value.event === null) {
      return sendHot(request, reply, shared.body, CACHE_CONTROL.live);
    }
    const mine = await viewerRow(shared.value, viewer, viewerEntry, shared.value.event, request);
    if (mine === null) return sendHot(request, reply, shared.body, CACHE_CONTROL.private);
    reply.header('cache-control', CACHE_CONTROL.private).header('vary', 'authorization');
    return serialize(
      CaptainBattleSchema,
      { ...shared.value, rows: sortBattleRows([...shared.value.rows, mine]) },
      'CaptainBattle',
    );
  });
}
