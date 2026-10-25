import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { EMPTY_LINKS, acceptDraft, parseDateOrNull, positiveIntOrNull } from './drafts.js';
import { describeError, httpUrlOrNull, retryAfterSec, send } from './http.js';
import { htmlToPlainText } from './text.js';
import type {
  ContentSource,
  EpisodeRef,
  IntegrationContext,
  MediaDraft,
  NewsItemDraft,
  SkippedItem,
  SourceResult,
} from './types.js';
import {
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';

export interface PodcastRssConfig {
  /** e.g. https://anchor.fm/s/105778688/podcast/rss */
  rssUrl: string;
}

/** Conditional-GET validators remembered between polls (serialized into the opaque cursor). */
interface RssCursor {
  etag: string | null;
  lastModified: string | null;
}

export const PODCAST_DEDUPE_PREFIX = 'podcast:';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (_name, jpath) => jpath === 'rss.channel.item',
});

const RecordSchema = z.record(z.string(), z.unknown());
const FeedSchema = z.object({
  rss: z.object({
    channel: z.looseObject({
      item: z.array(z.unknown()).optional(),
    }),
  }),
});

/** Text content of a parsed XML node (plain string, `{ '#text': … }` with attributes, or number). */
function textOf(node: unknown): string | null {
  if (typeof node === 'string') return node.trim() === '' ? null : node.trim();
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (node !== null && typeof node === 'object') return textOf((node as Record<string, unknown>)['#text']);
  return null;
}

function attrOf(node: unknown, attr: string): string | null {
  if (Array.isArray(node)) return attrOf(node[0], attr);
  if (node === null || typeof node !== 'object') return null;
  const v = (node as Record<string, unknown>)[`@_${attr}`];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** "01:13:23", "73:23", "4403", "4403.6" → seconds; anything else → null. */
export function parseDurationSec(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:\.\d+)?$/.exec(s);
  if (m === null) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (sec >= 60 || (m[1] !== undefined && min >= 60)) return null;
  return h * 3600 + min * 60 + sec;
}

function decodeCursor(cursor: string | null): RssCursor {
  if (cursor === null) return { etag: null, lastModified: null };
  try {
    const v: unknown = JSON.parse(cursor);
    const parsed = z
      .object({ etag: z.string().nullable(), lastModified: z.string().nullable() })
      .safeParse(v);
    return parsed.success ? parsed.data : { etag: null, lastModified: null };
  } catch {
    return { etag: null, lastModified: null };
  }
}

function encodeCursor(c: RssCursor): string | null {
  return c.etag === null && c.lastModified === null ? null : JSON.stringify(c);
}

/**
 * Parses a podcast RSS document into podcast drafts. Exposed for tests and for WebSub push bodies
 * (the hub POSTs the full feed). Throws IntegrationConfigError when the document isn't an RSS feed.
 */
export function parsePodcastRss(xml: string): Pick<SourceResult, 'items' | 'skipped' | 'accountLabel'> {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new IntegrationConfigError(`The podcast feed is not valid XML: ${describeError(err)}`);
  }
  const feed = FeedSchema.safeParse(doc);
  if (!feed.success) {
    throw new IntegrationConfigError('The podcast URL did not return an RSS feed (no <rss><channel>).');
  }
  const channel = feed.data.rss.channel;
  const accountLabel = textOf(channel['title']);
  const channelImage =
    httpUrlOrNull(attrOf(channel['itunes:image'], 'href')) ??
    httpUrlOrNull(textOf(RecordSchema.safeParse(channel['image']).data?.['url']));

  const items: NewsItemDraft[] = [];
  const skipped: SkippedItem[] = [];
  for (const rawItem of channel.item ?? []) {
    const item = RecordSchema.safeParse(rawItem);
    if (!item.success) {
      skipped.push({ externalId: null, reason: 'RSS <item> is not an element' });
      continue;
    }
    const it = item.data;
    const audio = httpUrlOrNull(attrOf(it['enclosure'], 'url'));
    const guid = textOf(it['guid']) ?? textOf(it['link']) ?? audio;
    const title = textOf(it['title']);
    if (guid === null) {
      skipped.push({ externalId: title, reason: 'RSS item has no guid, link or enclosure' });
      continue;
    }
    if (title === null) {
      skipped.push({ externalId: guid, reason: 'RSS item has no title' });
      continue;
    }
    const publishedAt = parseDateOrNull(textOf(it['pubDate']));
    if (publishedAt === null) {
      skipped.push({ externalId: guid, reason: 'RSS item has a missing or invalid pubDate' });
      continue;
    }
    const html = textOf(it['content:encoded']) ?? textOf(it['description']) ?? textOf(it['itunes:summary']);
    const text = html === null ? null : htmlToPlainText(html) || null;
    const image = httpUrlOrNull(attrOf(it['itunes:image'], 'href')) ?? channelImage;
    const media: MediaDraft[] =
      image === null ? [] : [{ kind: 'image', sourceUrl: image, posterSourceUrl: null, width: null, height: null }];
    acceptDraft(
      {
        dedupeKey: `${PODCAST_DEDUPE_PREFIX}${guid}`,
        source: 'podcast',
        title,
        text,
        media,
        links: { ...EMPTY_LINKS, audio },
        podcast: {
          episodeNumber: positiveIntOrNull(textOf(it['itunes:episode'])),
          seasonNumber: positiveIntOrNull(textOf(it['itunes:season'])),
          durationSec: parseDurationSec(textOf(it['itunes:duration'])),
        },
        publishedAt,
        expiresAt: null,
      },
      guid,
      items,
      skipped,
    );
  }
  return { items, skipped, accountLabel };
}

/**
 * Polls a podcast RSS feed. Pass the previous result's `cursor` back in: it carries ETag /
 * Last-Modified, so an unchanged feed costs one tiny 304 (`notModified: true`, no items).
 */
export async function fetchPodcastFeed(
  config: PodcastRssConfig & { cursor?: string | null },
  ctx: IntegrationContext,
): Promise<SourceResult> {
  const rssUrl = httpUrlOrNull(config.rssUrl);
  if (rssUrl === null) throw new IntegrationConfigError('The podcast RSS URL is not a valid http(s) URL.');
  const previous = decodeCursor(config.cursor ?? null);
  const headers: Record<string, string> = {
    Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  };
  if (previous.etag !== null) headers['If-None-Match'] = previous.etag;
  if (previous.lastModified !== null) headers['If-Modified-Since'] = previous.lastModified;

  const res = await send(ctx, 'Podcast RSS', rssUrl, { headers });
  if (res.status === 304) {
    return {
      items: [],
      skipped: [],
      warnings: [],
      accountLabel: null,
      cursor: config.cursor ?? null,
      notModified: true,
    };
  }
  if (res.status === 429) {
    throw new IntegrationRateLimitError('The podcast host rate-limited the RSS request.', retryAfterSec(res, ctx.now()));
  }
  if (res.status === 404 || res.status === 410) {
    throw new IntegrationConfigError(`The podcast RSS URL returned HTTP ${res.status} — check the URL.`);
  }
  if (!res.ok) {
    throw new IntegrationUnavailableError(`The podcast RSS request failed with HTTP ${res.status}.`, res.status);
  }
  let xml: string;
  try {
    xml = await res.text();
  } catch (err) {
    throw new IntegrationUnavailableError(`Reading the podcast RSS failed: ${describeError(err)}`, res.status);
  }
  const parsed = parsePodcastRss(xml);
  return {
    ...parsed,
    warnings: [],
    cursor: encodeCursor({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }),
    notModified: false,
  };
}

/** ContentSource wrapper around `fetchPodcastFeed` (cursor = conditional-GET validators). */
export function createPodcastRssSource(config: PodcastRssConfig, ctx: IntegrationContext): ContentSource {
  return {
    source: 'podcast',
    fetchLatest: (cursor) => fetchPodcastFeed({ ...config, cursor }, ctx),
  };
}

/** The lookup key the Spotify/Apple resolvers need, from a podcast draft (`podcast:<guid>`). */
export function episodeRefFromDraft(draft: NewsItemDraft): EpisodeRef | null {
  if (draft.source !== 'podcast' || !draft.dedupeKey.startsWith(PODCAST_DEDUPE_PREFIX) || draft.title === null) {
    return null;
  }
  return {
    dedupeKey: draft.dedupeKey,
    guid: draft.dedupeKey.slice(PODCAST_DEDUPE_PREFIX.length),
    title: draft.title,
    publishedAt: draft.publishedAt,
    episodeNumber: draft.podcast?.episodeNumber ?? null,
  };
}
