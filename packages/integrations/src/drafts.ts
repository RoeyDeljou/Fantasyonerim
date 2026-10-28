import { NewsLinksSchema, NewsSourceSchema, PodcastMetaSchema } from '@fant/shared';
import { z } from 'zod';
import type { NewsItemDraft, SkippedItem } from './types.js';

const MediaDraftSchema = z.object({
  kind: z.enum(['image', 'video']),
  sourceUrl: z.string().url(),
  posterSourceUrl: z.string().url().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  fallback: z
    .object({
      sourceUrl: z.string().url(),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
    })
    .nullable()
    .optional(),
});

/** Final gate: every draft leaving this package satisfies the `@fant/shared` News contract. */
const NewsItemDraftSchema = z.object({
  dedupeKey: z.string().min(3).max(500),
  source: NewsSourceSchema.exclude(['admin_update']),
  title: z.string().nullable(),
  text: z.string().nullable(),
  media: z.array(MediaDraftSchema),
  links: NewsLinksSchema,
  podcast: PodcastMetaSchema.nullable(),
  publishedAt: z.date().refine((d) => !Number.isNaN(d.getTime()), 'invalid date'),
  expiresAt: z
    .date()
    .refine((d) => !Number.isNaN(d.getTime()), 'invalid date')
    .nullable(),
});

export const EMPTY_LINKS = {
  spotify: null,
  apple: null,
  instagram: null,
  x: null,
  audio: null,
} as const satisfies NewsItemDraft['links'];

/** Pushes the draft to `items` if valid, otherwise records why it was skipped. Never throws. */
export function acceptDraft(
  draft: NewsItemDraft,
  externalId: string | null,
  items: NewsItemDraft[],
  skipped: SkippedItem[],
): void {
  const parsed = NewsItemDraftSchema.safeParse(draft);
  if (parsed.success) {
    items.push(draft);
  } else {
    const issue = parsed.error.issues[0];
    skipped.push({
      externalId,
      reason: `invalid item: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`,
    });
  }
}

export function parseDateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function positiveIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'number' ? value : Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
