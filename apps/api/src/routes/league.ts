import { FplEntryIdSchema, LeaguePositionSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { resolveEvent } from '../gameweek.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import { parseInput, serialize } from '../validate.js';
import { PageQuerySchema, cleanQuery } from './query.js';

export { STANDINGS_PICKS_CONCURRENCY } from '../perf/hotData.js';

/**
 * The podcast league's standings and live table. Every page is computed once per TTL for everybody (ctx.hot)
 * and kept warm by the pre-warmer while a fixture is live; requests send the shared, precompressed body.
 */
export function leagueRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  async function configuredLeague() {
    const leagueId = await ctx.hot.leagueId();
    if (leagueId === null) {
      throw notFound('No league has been configured yet. An admin can set it in the admin console.');
    }
    return leagueId;
  }

  app.get('/v1/league/standings', async (request, reply) => {
    const { page } = parseInput(PageQuerySchema, cleanQuery(request.query));
    const leagueId = await configuredLeague();
    const { body } = await ctx.hot.standings(leagueId, page);
    return sendHot(request, reply, body, CACHE_CONTROL.fpl);
  });

  app.get('/v1/league/live', async (request, reply) => {
    const query = parseInput(PageQuerySchema, cleanQuery(request.query));
    const leagueId = await configuredLeague();
    const event = await resolveEvent(ctx.fpl, query.event);
    const { body } = await ctx.hot.liveLeague(leagueId, event, query.page);
    return sendHot(request, reply, body, CACHE_CONTROL.live);
  });

  // "Find my team": the standings page (also the live table's page) and official rank of the signed-in user's
  // team. One shared entry → page index per league (ctx.hot.leaguePosition), so everybody asking costs one scan.
  app.get('/v1/league/position', async (request, reply) => {
    const { user } = await auth.requireUser(request);
    reply.header('cache-control', CACHE_CONTROL.private);
    if (user.entryId === null) {
      return serialize(LeaguePositionSchema, { entryId: null, page: null, rank: null }, 'LeaguePosition');
    }
    const entryId = FplEntryIdSchema.parse(user.entryId);
    const leagueId = await configuredLeague();
    const position = await ctx.hot.leaguePosition(leagueId, entryId);
    return serialize(
      LeaguePositionSchema,
      { entryId, page: position?.page ?? null, rank: position?.rank ?? null },
      'LeaguePosition',
    );
  });
}
