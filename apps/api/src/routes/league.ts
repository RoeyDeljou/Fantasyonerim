import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { resolveEvent } from '../gameweek.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import { parseInput } from '../validate.js';
import { PageQuerySchema, cleanQuery } from './query.js';

export { STANDINGS_PICKS_CONCURRENCY } from '../perf/hotData.js';

/**
 * The podcast league's standings and live table. Every page is computed once per TTL for everybody (ctx.hot)
 * and kept warm by the pre-warmer while a fixture is live; requests send the shared, precompressed body.
 */
export function leagueRoutes(app: FastifyInstance, ctx: AppContext): void {
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
}
