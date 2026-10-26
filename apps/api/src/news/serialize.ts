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

export const EMPTY_LINKS: NewsLinks = {
  spotify: null,
  apple: null,
  instagram: null,
  x: null,
  audio: null,
  web: null,
};

export function readLinks(json: unknown): NewsLinks {
  const parsed = NewsLinksSchema.partial().safeParse(json);
  if (!parsed.success) return { ...EMPTY_LINKS };
  const l = parsed.data;
  return {
    spotify: l.spotify ?? null,
    apple: l.apple ?? null,
    instagram: l.instagram ?? null,
    x: l.x ?? null,
    audio: l.audio ?? null,
    web: l.web ?? null,
  };
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
