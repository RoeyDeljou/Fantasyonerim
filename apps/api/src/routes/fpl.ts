import {
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  type Fixture,
  type FixtureStatus,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { resolveEvent } from '../gameweek.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
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

/** Fixture list caching: seconds while anything is in play, a minute otherwise. */
export function fixturesCacheControl(fixtures: readonly Fixture[]): string {
  return fixtures.some((f) => f.status === 'live' || f.status === 'finished_provisional')
    ? FIXTURE_DETAIL_CACHE_CONTROL.live
    : FIXTURE_DETAIL_CACHE_CONTROL.not_started;
}

/**
 * Thin proxy over FplService (which owns FPL caching). Shared data (bootstrap, fixtures, match sheets) is
 * serialized + compressed once per change for everybody (ctx.hot); per-entry data is built per request from
 * FplService's shared caches and gets an ETag (304) from the conditional-GET hook.
 */
export function fplRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { fpl, hot } = ctx;

  app.get('/v1/fpl/bootstrap', async (request, reply) => {
    const { body } = await hot.bootstrap();
    return sendHot(request, reply, body, CACHE_CONTROL.bootstrap);
  });

  app.get('/v1/fpl/fixtures', async (request, reply) => {
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    const { value, body } = await hot.fixtures(event);
    return sendHot(request, reply, body, fixturesCacheControl(value));
  });

  app.get('/v1/fpl/fixtures/:fixtureId', async (request, reply) => {
    const { fixtureId } = parseInput(FixtureParamsSchema, request.params);
    // Unknown fixture → FplNotFoundError → 404 (error handler).
    const { value, body } = await hot.fixtureDetail(fixtureId);
    return sendHot(request, reply, body, FIXTURE_DETAIL_CACHE_CONTROL[value.fixture.status]);
  });

  app.get('/v1/fpl/entries/:entryId', async (request, reply) => {
    const { entryId } = parseInput(EntryParamsSchema, request.params);
    reply.header('cache-control', CACHE_CONTROL.fpl);
    return serialize(EntrySummarySchema, await fpl.getEntry(entryId), 'EntrySummary');
  });

  app.get('/v1/fpl/entries/:entryId/picks', async (request, reply) => {
    const { entryId } = parseInput(EntryParamsSchema, request.params);
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    reply.header('cache-control', CACHE_CONTROL.fpl);
    return serialize(EntryPicksSchema, await fpl.getEntryPicks(entryId, event), 'EntryPicks');
  });

  // My Team live: the shared GW context (FplService) + this entry's cached picks — cheap per request.
  app.get('/v1/fpl/entries/:entryId/live', async (request, reply) => {
    const { entryId } = parseInput(EntryParamsSchema, request.params);
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    reply.header('cache-control', CACHE_CONTROL.live);
    return serialize(EntryLiveSchema, await fpl.getEntryLive(entryId, event), 'EntryLive');
  });
}
