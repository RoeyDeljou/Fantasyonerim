import {
  NewsItemSchema,
  NewsLinksSchema,
  PodcastMetaSchema,
  type NewsItem,
  type NewsLinks,
} from '@fant/shared';
import type { NewsItem as NewsItemRow, NewsMedia } from '@prisma/client';
import { serialize } from '../validate.js';

export type NewsItemWithMedia = NewsItemRow & { media: NewsMedia[] };

export const EMPTY_LINKS: NewsLinks = { spotify: null, apple: null, instagram: null, x: null, audio: null };

export function readLinks(json: unknown): NewsLinks {
  const parsed = NewsLinksSchema.partial().safeParse(json);
  return parsed.success ? { ...EMPTY_LINKS, ...parsed.data } : { ...EMPTY_LINKS };
}

export function toNewsItem(row: NewsItemWithMedia): NewsItem {
  const podcast = row.podcast === null ? null : PodcastMetaSchema.safeParse(row.podcast);
  return serialize(
    NewsItemSchema,
    {
      id: row.id,
      source: row.source,
      title: row.title,
      text: row.text,
      media: [...row.media]
        .sort((a, b) => a.order - b.order)
        .map((m) => ({
          kind: m.kind,
          url: m.url,
          posterUrl: m.posterUrl,
          width: m.width,
          height: m.height,
        })),
      links: readLinks(row.links),
      podcast: podcast === null || !podcast.success ? null : podcast.data,
      publishedAt: row.publishedAt.toISOString(),
      expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    },
    'NewsItem',
  );
}
