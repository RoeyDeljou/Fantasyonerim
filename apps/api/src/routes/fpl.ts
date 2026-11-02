import {
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureDetailSchema,
  FixtureSchema,
  type FixtureStatus,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { resolveEvent } from '../gameweek.js';
import { parseInput, serialize } from '../validate.js';
import { EntryParamsSchema, EventQuerySchema, FixtureParamsSchema, cleanQuery } from './query.js';

/**
 * Match sheet caching by fixture state: seconds while the ball is rolling (live, or finished but bonus not yet
 * confirmed), a minute before kick-off (it can start any moment), long once FPL marks it finished (final).
 */
export const FIXTURE_DETAIL_CACHE_CONTROL: Record<FixtureStatus, string> = {
  live: 'public, max-age=15, stale-while-revalidate=15',
  finished_provisional: 'public, max-age=15, stale-while-revalidate=15',
  not_started: 'public, max-age=60, stale-while-revalidate=30',
  finished: 'public, max-age=600, stale-while-revalidate=600',
};

/** Thin proxy over FplService (which owns caching). The browser never calls FPL directly. */
export function fplRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { fpl } = ctx;

  app.get('/v1/fpl/bootstrap', async () => serialize(BootstrapSchema, await fpl.getBootstrap(), 'Bootstrap'));

  app.get('/v1/fpl/fixtures', async (request) => {
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    return serialize(z.array(FixtureSchema), await fpl.getFixtures(event), 'Fixture[]');
  });

  app.get('/v1/fpl/fixtures/:fixtureId', async (request, reply) => {
    const { fixtureId } = parseInput(FixtureParamsSchema, request.params);
    // Unknown fixture → FplNotFoundError → 404 (error handler).
    const detail = serialize(FixtureDetailSchema, await fpl.getFixtureDetail(fixtureId), 'FixtureDetail');
    reply.header('cache-control', FIXTURE_DETAIL_CACHE_CONTROL[detail.fixture.status]);
    return detail;
  });

  app.get('/v1/fpl/entries/:entryId', async (request) => {
    const { entryId } = parseInput(EntryParamsSchema, request.params);
    return serialize(EntrySummarySchema, await fpl.getEntry(entryId), 'EntrySummary');
  });

  app.get('/v1/fpl/entries/:entryId/picks', async (request) => {
    const { entryId } = parseInput(EntryParamsSchema, request.params);
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    return serialize(EntryPicksSchema, await fpl.getEntryPicks(entryId, event), 'EntryPicks');
  });

  app.get('/v1/fpl/entries/:entryId/live', async (request) => {
    const { entryId } = parseInput(EntryParamsSchema, request.params);
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    return serialize(EntryLiveSchema, await fpl.getEntryLive(entryId, event), 'EntryLive');
  });
}
