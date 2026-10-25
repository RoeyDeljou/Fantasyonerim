import { FplLeagueIdSchema, LeagueStandingsSchema, LiveLeagueSchema, type FplLeagueId } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { resolveEvent } from '../gameweek.js';
import { getSettings } from '../settings.js';
import { parseInput, serialize } from '../validate.js';
import { PageQuerySchema, cleanQuery } from './query.js';

export function leagueRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function configuredLeague(): Promise<FplLeagueId> {
    const settings = await getSettings(ctx.prisma);
    if (settings.leagueId === null) {
      throw notFound('No league has been configured yet. An admin can set it in the admin console.');
    }
    return FplLeagueIdSchema.parse(settings.leagueId);
  }

  app.get('/v1/league/standings', async (request) => {
    const { page } = parseInput(PageQuerySchema, cleanQuery(request.query));
    const leagueId = await configuredLeague();
    return serialize(
      LeagueStandingsSchema,
      await ctx.fpl.getLeagueStandings(leagueId, page),
      'LeagueStandings',
    );
  });

  app.get('/v1/league/live', async (request) => {
    const query = parseInput(PageQuerySchema, cleanQuery(request.query));
    const leagueId = await configuredLeague();
    const event = await resolveEvent(ctx.fpl, query.event);
    return serialize(
      LiveLeagueSchema,
      await ctx.fpl.getLiveLeague(leagueId, event, query.page),
      'LiveLeague',
    );
  });
}
