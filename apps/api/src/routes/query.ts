import { FplEntryIdSchema, FplFixtureIdSchema, GameweekSchema } from '@fant/shared';
import { z } from 'zod';

// Query/param wrappers built only from the shared id schemas (the contract has no query DTOs).

/** `?event=` → optional Gameweek; an empty value means "not given". */
export const EventQuerySchema = z.object({ event: z.optional(GameweekSchema) });
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  event: z.optional(GameweekSchema),
});
export const EntryParamsSchema = z.object({ entryId: FplEntryIdSchema });
export const FixtureParamsSchema = z.object({ fixtureId: FplFixtureIdSchema });

/** Drops `key=` (empty) query values so optional params behave as absent. */
export function cleanQuery(query: unknown): Record<string, unknown> {
  if (typeof query !== 'object' || query === null) return {};
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined));
}
