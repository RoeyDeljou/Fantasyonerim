import { mapWithConcurrency } from '@fant/fpl';
import {
  FplLeagueIdSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  type Chip,
  type FplEntryId,
  type FplLeagueId,
  type Gameweek,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { resolveEvent } from '../gameweek.js';
import { getSettings } from '../settings.js';
import { parseInput, serialize } from '../validate.js';
import { PageQuerySchema, cleanQuery } from './query.js';

/** Picks lookups in flight at once for one standings page (≤ 50 rows; FplService caches each). */
export const STANDINGS_PICKS_CONCURRENCY = 5;

export function leagueRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function configuredLeague(): Promise<FplLeagueId> {
    const settings = await getSettings(ctx.prisma);
    if (settings.leagueId === null) {
      throw notFound('No league has been configured yet. An admin can set it in the admin console.');
    }
    return FplLeagueIdSchema.parse(settings.leagueId);
  }

  /**
   * The chip each entry played in the current (= last started) GW, from FplService's cached picks — only for
   * the rows on this page, a few at a time. Best-effort: a failed lookup is `null` for that row, never a failed
   * page; before the season's first deadline every row is `null`.
   */
  async function chipsFor(entryIds: readonly FplEntryId[]): Promise<(Chip | null)[]> {
    let event: Gameweek | null;
    try {
      event = (await ctx.fpl.getBootstrap()).currentEvent;
    } catch {
      return entryIds.map(() => null);
    }
    if (event === null) return entryIds.map(() => null);
    const gw = event;
    return mapWithConcurrency(entryIds, STANDINGS_PICKS_CONCURRENCY, async (entryId) => {
      try {
        return (await ctx.fpl.getEntryPicks(entryId, gw)).activeChip;
      } catch {
        return null;
      }
    });
  }

  app.get('/v1/league/standings', async (request) => {
    const { page } = parseInput(PageQuerySchema, cleanQuery(request.query));
    const leagueId = await configuredLeague();
    const standings = await ctx.fpl.getLeagueStandings(leagueId, page);
    const chips = await chipsFor(standings.rows.map((r) => r.entryId));
    return serialize(
      LeagueStandingsSchema,
      { ...standings, rows: standings.rows.map((r, i) => ({ ...r, activeChip: chips[i] ?? null })) },
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
