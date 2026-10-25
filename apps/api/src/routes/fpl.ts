import {
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { resolveEvent } from '../gameweek.js';
import { parseInput, serialize } from '../validate.js';
import { EntryParamsSchema, EventQuerySchema, cleanQuery } from './query.js';

/** Thin proxy over FplService (which owns caching). The browser never calls FPL directly. */
export function fplRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { fpl } = ctx;

  app.get('/v1/fpl/bootstrap', async () => serialize(BootstrapSchema, await fpl.getBootstrap(), 'Bootstrap'));

  app.get('/v1/fpl/fixtures', async (request) => {
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const event = await resolveEvent(fpl, query.event);
    return serialize(z.array(FixtureSchema), await fpl.getFixtures(event), 'Fixture[]');
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
