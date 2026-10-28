import {
  NewsItemSchema,
  NewsLinksSchema,
  PodcastMetaSchema,
  type NewsItem,
  type NewsLinks,
} from '@fant/shared';
import type { NewsItem as NewsItemRow, NewsMedia } from '@prisma/client';
import { mapMediaUrl, type MediaUrlMapper } from '../media/publicUrl.js';
import { serialize } from '../validate.js';

export type NewsItemWithMedia = NewsItemRow & { media: NewsMedia[] };

export const EMPTY_LINKS: NewsLinks = {
  spotify: null,
  apple: null,
  instagram: null,
  x: null,
  youtube: null,
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
    // Episodes' "Watch on YouTube" video / the YouTube item itself; null when unknown.
    youtube: l.youtube ?? null,
  };
}

/** `mediaUrl` maps stored media URLs to client URLs (ctx.mediaUrl). */
export function toNewsItem(row: NewsItemWithMedia, mediaUrl: MediaUrlMapper): NewsItem {
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
          url: mediaUrl(m.url),
          posterUrl: mapMediaUrl(mediaUrl, m.posterUrl),
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
