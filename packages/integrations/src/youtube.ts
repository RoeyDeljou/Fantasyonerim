import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { EMPTY_LINKS, acceptDraft, parseDateOrNull } from './drafts.js';
import { describeError, retryAfterSec, send } from './http.js';
import { matchEpisodes } from './podcast-links.js';
import type { PlatformEpisode } from './podcast-links.js';
import { episodeNumberFromTitle, normalizeTitle, titleKeys, tidyPlainText } from './text.js';
import type {
  ContentSource,
  EpisodeRef,
  IntegrationContext,
  MediaDraft,
  NewsItemDraft,
  PodcastLinkResolver,
  ResolvedPodcastLinks,
  SkippedItem,
  SourceResult,
} from './types.js';
import { IntegrationConfigError, IntegrationRateLimitError, IntegrationUnavailableError } from './types.js';

/**
 * YouTube without an API key (costs nothing, no quota):
 *   - channel id: parsed from the admin's input, or scraped once from the public channel page;
 *   - uploads: the public Atom feed (latest 15 uploads only);
 *   - Short vs regular: the feed's own `/shorts/` link, else `/shorts/<id>` answers 200 for a Short and
 *     303 → `/watch` for a regular video. Cached per id (process memory + the persisted cursor).
 */

export const YOUTUBE_BASE_URL = 'https://www.youtube.com';
/** `?channel_id=UC…` — the 15 newest uploads, newest first. No ETag/Last-Modified (cache-control 15 min). */
export const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';
export const YOUTUBE_DEDUPE_PREFIX = 'youtube:';
export const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
/** Upper bound on classification requests per poll (the feed holds 15 uploads). */
export const YOUTUBE_MAX_CLASSIFY_REQUESTS = 15;

/** Channel pages and /shorts/ are served to browsers: look like one, in Hebrew. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'User-Agent': BROWSER_USER_AGENT,
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
} as const;
const CLASSIFY_TIMEOUT_MS = 8_000;
const CLASSIFY_CONCURRENCY = 4;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
/** YouTube handles: 3–30 chars, letters (any script), digits, `_`, `-`, `.`. */
const HANDLE_PATTERN = /^[\p{L}\p{M}\p{N}._-]{3,30}$/u;
const DAY = 86_400_000;

// ---------- URLs / thumbnails ----------

export function youTubeWatchUrl(videoId: string): string {
  return `${YOUTUBE_BASE_URL}/watch?v=${videoId}`;
}

export function youTubeShortUrl(videoId: string): string {
  return `${YOUTUBE_BASE_URL}/shorts/${videoId}`;
}

/**
 * Thumbnails (checked live on the client's channel, 2026-10-28):
 *   - Shorts: `oar2.jpg` is the vertical 1080×1920 frame (`oardefault.jpg` is 404);
 *   - videos: `hq720.jpg` is 1280×720 when YouTube generated it — it is NOT generated for every upload
 *     (404 for the channel's current episode videos; `maxresdefault.jpg` too);
 *   - `hqdefault.jpg` (480×360, 4:3 letterboxed) always exists → the `fallback` for both.
 */
export function youTubeThumbnail(videoId: string, kind: YouTubeVideoKind): MediaDraft {
  const base = `https://i.ytimg.com/vi/${videoId}`;
  const fallback = { sourceUrl: `${base}/hqdefault.jpg`, width: 480, height: 360 };
  return kind === 'short'
    ? {
        kind: 'image',
        sourceUrl: `${base}/oar2.jpg`,
        posterSourceUrl: null,
        width: 1080,
        height: 1920,
        fallback,
      }
    : {
        kind: 'image',
        sourceUrl: `${base}/hq720.jpg`,
        posterSourceUrl: null,
        width: 1280,
        height: 720,
        fallback,
      };
}

/** Video id from a watch / shorts / youtu.be / embed / live URL, or null. */
export function youTubeVideoIdFromUrl(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host) || host === 'music.youtube.com') {
    const [first, second] = url.pathname.split('/').filter((p) => p !== '');
    if (first === 'watch') id = url.searchParams.get('v');
    else if (first === 'shorts' || first === 'embed' || first === 'live' || first === 'v')
      id = second ?? null;
  }
  return id !== null && YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
}

// ---------- channel input ----------

export type YouTubeChannelRef = { kind: 'id'; channelId: string } | { kind: 'handle'; handle: string };

function handleRef(raw: string): YouTubeChannelRef | null {
  let h = raw;
  try {
    h = decodeURIComponent(raw);
  } catch {
    return null;
  }
  h = h.normalize('NFC');
  return HANDLE_PATTERN.test(h) ? { kind: 'handle', handle: h } : null;
}

function toYouTubeUrl(s: string): URL | null {
  const withScheme = /^https?:\/\//i.test(s)
    ? s
    : /^(?:[a-z0-9-]+\.)*youtube\.com(?:[/?#]|$)/i.test(s)
      ? `https://${s}`
      : null;
  if (withScheme === null) return null;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Parses what an admin pastes into the YouTube settings: `@handle`, a bare handle, `UC…` id, or a
 * (www./m.)youtube.com `/@handle` or `/channel/UC…` URL (any sub-path / query, e.g.
 * `https://m.youtube.com/@Fantasyonerim?ra=m`). Legacy `/c/` and `/user/` URLs → null (ask for the handle).
 */
export function parseYouTubeChannel(input: string): YouTubeChannelRef | null {
  const s = input.trim();
  if (s === '') return null;
  if (YOUTUBE_CHANNEL_ID_PATTERN.test(s)) return { kind: 'id', channelId: s };
  if (s.startsWith('@')) return handleRef(s.slice(1));
  const url = toYouTubeUrl(s);
  if (url !== null) {
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
    const [first, second] = url.pathname.split('/').filter((p) => p !== '');
    if (first === undefined) return null;
    if (first.startsWith('@')) return handleRef(first.slice(1));
    if (first.startsWith('%40')) return handleRef(first.slice(3));
    if (first === 'channel' && second !== undefined && YOUTUBE_CHANNEL_ID_PATTERN.test(second)) {
      return { kind: 'id', channelId: second };
    }
    return null;
  }
  if (/[/\s]/.test(s)) return null;
  return handleRef(s);
}

// ---------- channel id resolution ----------

function validChannelId(candidate: string | null | undefined): string | null {
  return candidate !== null && candidate !== undefined && YOUTUBE_CHANNEL_ID_PATTERN.test(candidate)
    ? candidate
    : null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m === null ? null : (m[1] ?? m[2] ?? null);
}

function channelIdInUrl(url: string | null): string | null {
  if (url === null) return null;
  const m = /youtube\.com\/channel\/([^/?#"'\s]+)/i.exec(url);
  return validChannelId(m?.[1]);
}

/**
 * Channel id from a channel page's HTML, most specific signal first:
 *   1. `<link rel="canonical" href="…/channel/UC…">`;
 *   2. `<meta itemprop="channelId|identifier" content="UC…">` (the live page uses `identifier`), then
 *      `<meta property="og:url" content="…/channel/UC…">`;
 *   3. `"externalId":"UC…"` (the page owner, in channelMetadataRenderer), then `"channelId":"UC…"` —
 *      externalId first because featured-channel shelves list *other* channels' `channelId`s.
 * Every candidate must match `^UC[A-Za-z0-9_-]{22}$`. Pure; null when nothing valid is found.
 */
export function extractYouTubeChannelId(html: string): string | null {
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    if ((attr(tag, 'rel') ?? '').toLowerCase() !== 'canonical') continue;
    const id = channelIdInUrl(attr(tag, 'href'));
    if (id !== null) return id;
  }
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const itemprop of ['channelid', 'identifier']) {
    for (const tag of metas) {
      if ((attr(tag, 'itemprop') ?? '').toLowerCase() !== itemprop) continue;
      const id = validChannelId(attr(tag, 'content'));
      if (id !== null) return id;
    }
  }
  for (const tag of metas) {
    if ((attr(tag, 'property') ?? '').toLowerCase() !== 'og:url') continue;
    const id = channelIdInUrl(attr(tag, 'content'));
    if (id !== null) return id;
  }
  for (const key of ['externalId', 'channelId']) {
    for (const m of html.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g'))) {
      const id = validChannelId(m[1]);
      if (id !== null) return id;
    }
  }
  return null;
}

function isConsentHost(url: string | null): boolean {
  if (url === null || url === '') return false;
  try {
    return new URL(url, YOUTUBE_BASE_URL).hostname.toLowerCase() === 'consent.youtube.com';
  } catch {
    return false;
  }
}

const CONSENT_MESSAGE =
  'YouTube answered with its cookie-consent page (consent.youtube.com) instead of the channel — this ' +
  'happens for servers in the EU/UK. Enter the channel id (UC…, from youtube.com/channel/UC…) instead of the handle.';

/** True when YouTube redirected (or would redirect) this response to its consent page. */
function isConsentResponse(res: Response): boolean {
  return (
    isConsentHost(res.url) ||
    (res.status >= 300 && res.status < 400 && isConsentHost(res.headers.get('location')))
  );
}

/**
 * Fetches `https://www.youtube.com/@<handle>` and extracts the channel id (see `extractYouTubeChannelId`).
 * 404 → IntegrationConfigError (no such handle) · 429 → IntegrationRateLimitError · consent page, 5xx,
 * network, or no id on the page → IntegrationUnavailableError.
 */
export async function resolveYouTubeChannelId(handle: string, ctx: IntegrationContext): Promise<string> {
  const ref = handleRef(handle.trim().replace(/^@/, ''));
  if (ref === null || ref.kind !== 'handle') {
    throw new IntegrationConfigError(`"${handle}" is not a valid YouTube handle.`);
  }
  const res = await send(ctx, 'YouTube', `${YOUTUBE_BASE_URL}/@${encodeURIComponent(ref.handle)}`, {
    headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  if (isConsentResponse(res)) throw new IntegrationUnavailableError(CONSENT_MESSAGE, res.status);
  if (res.status === 404 || res.status === 410) {
    throw new IntegrationConfigError(`YouTube has no channel @${ref.handle} — check the handle.`);
  }
  if (res.status === 429) {
    throw new IntegrationRateLimitError(
      'YouTube rate-limited the channel lookup.',
      retryAfterSec(res, ctx.now()),
    );
  }
  if (!res.ok) {
    throw new IntegrationUnavailableError(
      `YouTube channel lookup failed with HTTP ${res.status}.`,
      res.status,
    );
  }
  let html: string;
  try {
    html = await res.text();
  } catch (err) {
    throw new IntegrationUnavailableError(
      `Reading the YouTube channel page failed: ${describeError(err)}`,
      res.status,
    );
  }
  const id = extractYouTubeChannelId(html);
  if (id !== null) return id;
  if (/consent\.youtube\.com/i.test(html)) throw new IntegrationUnavailableError(CONSENT_MESSAGE, res.status);
  throw new IntegrationUnavailableError(
    `Could not find the channel id on youtube.com/@${ref.handle}. Enter the channel id (UC…) instead.`,
    res.status,
  );
}

/**
 * Settings → channel id, what apps/api calls when the admin saves `channel`: parses the input and only
 * fetches the channel page for a handle. Unparseable input → IntegrationConfigError.
 */
export async function resolveYouTubeChannel(
  input: string,
  ctx: IntegrationContext,
): Promise<{ channelId: string; handle: string | null }> {
  const ref = parseYouTubeChannel(input);
  if (ref === null) {
    throw new IntegrationConfigError(
      'Enter the YouTube channel as @handle, a youtube.com/@handle or youtube.com/channel/UC… link, or the UC… id.',
    );
  }
  if (ref.kind === 'id') return { channelId: ref.channelId, handle: null };
  return { channelId: await resolveYouTubeChannelId(ref.handle, ctx), handle: ref.handle };
}

// ---------- Atom feed ----------

export type YouTubeVideoKind = 'short' | 'video';

/** One upload from the Atom feed. */
export interface YouTubeVideo {
  videoId: string;
  title: string;
  /** media:description, tidied plain text; null when empty. */
  description: string | null;
  publishedAt: Date;
  /** What the feed's `<link rel="alternate">` says: `/shorts/` → 'short', `/watch` → 'video', else null. */
  feedKind: YouTubeVideoKind | null;
  views: number | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (_name, jpath) => jpath === 'feed.entry' || jpath === 'feed.entry.link' || jpath === 'feed.link',
});

const RecordSchema = z.record(z.string(), z.unknown());
const FeedSchema = z.object({
  feed: z.looseObject({ entry: z.array(z.unknown()).optional() }),
});
const VideoSchema = z.object({
  videoId: z.string().regex(YOUTUBE_VIDEO_ID_PATTERN),
  title: z.string().min(1),
  description: z.string().nullable(),
  publishedAt: z.date(),
  feedKind: z.enum(['short', 'video']).nullable(),
  views: z.number().int().nonnegative().nullable(),
});

function textOf(node: unknown): string | null {
  if (typeof node === 'string') return node.trim() === '' ? null : node.trim();
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (node !== null && typeof node === 'object') return textOf((node as Record<string, unknown>)['#text']);
  return null;
}

function attrOf(node: unknown, name: string): string | null {
  if (Array.isArray(node)) return attrOf(node[0], name);
  if (node === null || typeof node !== 'object') return null;
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function feedKindOf(links: unknown): YouTubeVideoKind | null {
  const list = Array.isArray(links) ? links : [links];
  for (const link of list) {
    const rel = attrOf(link, 'rel');
    if (rel !== null && rel !== 'alternate') continue;
    const href = attrOf(link, 'href') ?? '';
    if (/youtube\.com\/shorts\//i.test(href)) return 'short';
    if (/youtube\.com\/watch\?/i.test(href)) return 'video';
  }
  return null;
}

/**
 * Parses a YouTube Atom feed. Exposed for tests (and WebSub push bodies, which carry the same entries).
 * Throws IntegrationConfigError when the document isn't an Atom `<feed>`; bad entries land in `skipped`.
 */
export function parseYouTubeFeed(xml: string): {
  videos: YouTubeVideo[];
  skipped: SkippedItem[];
  channelTitle: string | null;
} {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new IntegrationConfigError(`The YouTube feed is not valid XML: ${describeError(err)}`);
  }
  const feed = FeedSchema.safeParse(doc);
  if (!feed.success) throw new IntegrationConfigError('YouTube did not return an Atom feed (no <feed>).');
  const videos: YouTubeVideo[] = [];
  const skipped: SkippedItem[] = [];
  for (const raw of feed.data.feed.entry ?? []) {
    const entry = RecordSchema.safeParse(raw);
    if (!entry.success) {
      skipped.push({ externalId: null, reason: 'YouTube <entry> is not an element' });
      continue;
    }
    const e = entry.data;
    const group = RecordSchema.safeParse(e['media:group']).data ?? {};
    const community = RecordSchema.safeParse(group['media:community']).data ?? {};
    const viewsRaw = attrOf(community['media:statistics'], 'views');
    const videoId = textOf(e['yt:videoId']);
    const parsed = VideoSchema.safeParse({
      videoId,
      title: textOf(e['title']) ?? textOf(group['media:title']),
      description: tidyPlainText(textOf(group['media:description'])),
      publishedAt: parseDateOrNull(textOf(e['published'])),
      feedKind: feedKindOf(e['link']),
      views: viewsRaw !== null && /^\d+$/.test(viewsRaw) ? Number(viewsRaw) : null,
    });
    if (parsed.success) {
      videos.push(parsed.data);
    } else {
      const issue = parsed.error.issues[0];
      skipped.push({
        externalId: videoId,
        reason: `invalid YouTube entry: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`,
      });
    }
  }
  return { videos, skipped, channelTitle: textOf(feed.data.feed['title']) };
}

/** Feed fetch result; `notModified` only when a validator from `cursor` got a 304. */
interface FeedFetch {
  notModified: boolean;
  videos: YouTubeVideo[];
  skipped: SkippedItem[];
  channelTitle: string | null;
  etag: string | null;
  lastModified: string | null;
}

function requireChannelId(channelId: string): string {
  const id = channelId.trim();
  if (!YOUTUBE_CHANNEL_ID_PATTERN.test(id)) {
    throw new IntegrationConfigError('The YouTube channel id must look like UC… (24 characters).');
  }
  return id;
}

/** GETs the channel's Atom feed (conditional when validators are known). Throws only typed errors. */
export async function fetchYouTubeFeed(
  config: { channelId: string; etag?: string | null; lastModified?: string | null },
  ctx: IntegrationContext,
): Promise<FeedFetch> {
  const channelId = requireChannelId(config.channelId);
  const headers: Record<string, string> = {
    Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.5',
  };
  if (config.etag !== undefined && config.etag !== null) headers['If-None-Match'] = config.etag;
  if (config.lastModified !== undefined && config.lastModified !== null)
    headers['If-Modified-Since'] = config.lastModified;
  const res = await send(ctx, 'YouTube', `${YOUTUBE_FEED_URL}?channel_id=${channelId}`, { headers });
  const empty = { videos: [], skipped: [], channelTitle: null };
  if (res.status === 304) {
    return {
      notModified: true,
      ...empty,
      etag: config.etag ?? null,
      lastModified: config.lastModified ?? null,
    };
  }
  if (isConsentResponse(res)) throw new IntegrationUnavailableError(CONSENT_MESSAGE, res.status);
  if (res.status === 429) {
    throw new IntegrationRateLimitError(
      'YouTube rate-limited the feed request.',
      retryAfterSec(res, ctx.now()),
    );
  }
  if (res.status === 404 || res.status === 410) {
    throw new IntegrationConfigError(
      `YouTube has no feed for channel ${channelId} — check the channel. (If it is right, YouTube's feed ` +
        'sometimes 404s for a few minutes; the next poll retries.)',
    );
  }
  if (!res.ok) {
    throw new IntegrationUnavailableError(
      `The YouTube feed request failed with HTTP ${res.status}.`,
      res.status,
    );
  }
  let xml: string;
  try {
    xml = await res.text();
  } catch (err) {
    throw new IntegrationUnavailableError(
      `Reading the YouTube feed failed: ${describeError(err)}`,
      res.status,
    );
  }
  return {
    notModified: false,
    ...parseYouTubeFeed(xml),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

// ---------- Short vs regular ----------

/** Per-process classification cache, shared by every source/resolver unless one is injected. */
export type YouTubeKindCache = Map<string, YouTubeVideoKind>;
const MAX_CACHE_ENTRIES = 5_000;
const sharedKindCache: YouTubeKindCache = new Map();

/** Test helper / memory valve: forgets every cached Short-vs-regular classification. */
export function clearYouTubeKindCache(): void {
  sharedKindCache.clear();
}

function remember(cache: YouTubeKindCache, id: string, kind: YouTubeVideoKind): void {
  cache.delete(id);
  cache.set(id, kind);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface ClassifiedYouTubeVideo extends YouTubeVideo {
  kind: YouTubeVideoKind;
  /** False when classification failed and `kind` is the 'video' fallback (retried on the next poll). */
  kindKnown: boolean;
}

/**
 * `HEAD /shorts/<id>` without following redirects: 200 → Short, 3xx to `/watch` → regular video,
 * anything else (consent redirect, 404, network error) → null. Never throws.
 */
export async function probeYouTubeShort(
  videoId: string,
  ctx: IntegrationContext,
): Promise<YouTubeVideoKind | null> {
  try {
    const res = await send(
      ctx,
      'YouTube',
      youTubeShortUrl(videoId),
      { method: 'HEAD', redirect: 'manual', headers: BROWSER_HEADERS },
      CLASSIFY_TIMEOUT_MS,
    );
    if (res.status === 200) return 'short';
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location === null) return null;
      const target = new URL(location, YOUTUBE_BASE_URL);
      return YOUTUBE_HOSTS.has(target.hostname.toLowerCase()) && target.pathname === '/watch'
        ? 'video'
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Classifies every video, cheapest signal first: cache → `known` (persisted cursor) → the feed's own
 * `/shorts/` link → `HEAD /shorts/<id>` (at most YOUTUBE_MAX_CLASSIFY_REQUESTS, 4 in parallel). When the
 * probe fails, a `/watch` feed link is trusted if the same feed marks other entries as `/shorts/` (so the
 * feed demonstrably distinguishes them); otherwise the video falls back to 'video' with `kindKnown: false`.
 */
export async function classifyYouTubeVideos(
  videos: readonly YouTubeVideo[],
  ctx: IntegrationContext,
  options: { cache?: YouTubeKindCache; known?: Readonly<Record<string, YouTubeVideoKind>> } = {},
): Promise<{ videos: ClassifiedYouTubeVideo[]; requests: number }> {
  const cache = options.cache ?? sharedKindCache;
  const known = options.known ?? {};
  const feedDistinguishes = videos.some((v) => v.feedKind === 'short');
  const result = new Map<string, { kind: YouTubeVideoKind; kindKnown: boolean }>();
  const toProbe: YouTubeVideo[] = [];
  for (const v of videos) {
    const cached = cache.get(v.videoId) ?? known[v.videoId];
    if (cached !== undefined) {
      remember(cache, v.videoId, cached);
      result.set(v.videoId, { kind: cached, kindKnown: true });
    } else if (v.feedKind === 'short') {
      remember(cache, v.videoId, 'short');
      result.set(v.videoId, { kind: 'short', kindKnown: true });
    } else {
      toProbe.push(v);
    }
  }
  const probing = toProbe.slice(0, YOUTUBE_MAX_CLASSIFY_REQUESTS);
  for (let i = 0; i < probing.length; i += CLASSIFY_CONCURRENCY) {
    const batch = probing.slice(i, i + CLASSIFY_CONCURRENCY);
    const kinds = await Promise.all(batch.map((v) => probeYouTubeShort(v.videoId, ctx)));
    batch.forEach((v, j) => {
      const probed = kinds[j] ?? null;
      const kind = probed ?? (feedDistinguishes && v.feedKind === 'video' ? 'video' : null);
      if (kind !== null) {
        remember(cache, v.videoId, kind);
        result.set(v.videoId, { kind, kindKnown: true });
      }
    });
  }
  return {
    videos: videos.map((v) => ({ ...v, ...(result.get(v.videoId) ?? { kind: 'video', kindKnown: false }) })),
    requests: probing.length,
  };
}

// ---------- drafts / source ----------

const TRAILING_HASHTAGS = /(?:\s*#[\p{L}\p{M}\p{N}_]+)+\s*$/u;

/** "כשפודן בכושר 🔥 #fantasy #fpl" → { title: "כשפודן בכושר 🔥", hashtags: ["#fantasy", "#fpl"] }. */
export function splitTrailingHashtags(title: string): { title: string; hashtags: string[] } {
  const m = TRAILING_HASHTAGS.exec(title);
  if (m === null) return { title: title.trim(), hashtags: [] };
  const rest = title.slice(0, m.index).trim();
  if (rest === '') return { title: title.trim(), hashtags: [] };
  return { title: rest, hashtags: m[0].trim().split(/\s+/u) };
}

/**
 * The News draft for one classified video. Shorts: trailing hashtags are cut from the title (display)
 * and appended to the text unless the description already has them.
 */
export function youTubeDraft(video: ClassifiedYouTubeVideo): NewsItemDraft {
  const isShort = video.kind === 'short';
  let title = video.title;
  let text = video.description;
  if (isShort) {
    const split = splitTrailingHashtags(video.title);
    title = split.title;
    const missing = split.hashtags.filter((tag) => !(text ?? '').includes(tag));
    if (missing.length > 0) text = text === null ? missing.join(' ') : `${text}\n\n${missing.join(' ')}`;
  }
  return {
    dedupeKey: `${YOUTUBE_DEDUPE_PREFIX}${video.videoId}`,
    source: isShort ? 'youtube_short' : 'youtube_video',
    title,
    text,
    media: [youTubeThumbnail(video.videoId, video.kind)],
    links: {
      ...EMPTY_LINKS,
      youtube: isShort ? youTubeShortUrl(video.videoId) : youTubeWatchUrl(video.videoId),
    },
    podcast: null,
    publishedAt: video.publishedAt,
    expiresAt: null,
  };
}

const KindSchema = z.enum(['short', 'video']);
const CursorSchema = z.object({
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  kinds: z.record(z.string(), KindSchema),
});
type YouTubeCursor = z.infer<typeof CursorSchema>;

function decodeCursor(cursor: string | null): YouTubeCursor {
  const empty: YouTubeCursor = { etag: null, lastModified: null, kinds: {} };
  if (cursor === null) return empty;
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(cursor));
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
}

export interface YouTubeSourceConfig {
  /** UC… id (resolve it once with `resolveYouTubeChannel` when the admin saves the setting). */
  channelId: string;
  /** Defaults to the shared per-process cache. */
  kindCache?: YouTubeKindCache;
}

/**
 * Shorts + regular uploads of a channel as News drafts (`youtube_short` / `youtube_video`,
 * dedupe `youtube:<videoId>`). The cursor persists conditional-GET validators *and* the classification
 * of the feed's videos, so after the first poll an unchanged feed costs one feed GET and 0 probes, even
 * across restarts. `source` is nominally 'youtube_video'; drafts carry their real source.
 *
 * Full-episode videos come out as `youtube_video` too: apps/api skips them with `isEpisodeVideo` (they
 * appear as the episode's `links.youtube` instead).
 */
export function createYouTubeSource(config: YouTubeSourceConfig, ctx: IntegrationContext): ContentSource {
  return {
    source: 'youtube_video',
    async fetchLatest(cursor): Promise<SourceResult> {
      const previous = decodeCursor(cursor);
      const feed = await fetchYouTubeFeed(
        { channelId: config.channelId, etag: previous.etag, lastModified: previous.lastModified },
        ctx,
      );
      if (feed.notModified) {
        return { items: [], skipped: [], warnings: [], accountLabel: null, cursor, notModified: true };
      }
      const classified = await classifyYouTubeVideos(feed.videos, ctx, {
        ...(config.kindCache === undefined ? {} : { cache: config.kindCache }),
        known: previous.kinds,
      });
      const items: NewsItemDraft[] = [];
      const skipped = [...feed.skipped];
      const kinds: Record<string, YouTubeVideoKind> = {};
      let unknown = 0;
      for (const video of classified.videos) {
        if (video.kindKnown) kinds[video.videoId] = video.kind;
        else unknown += 1;
        acceptDraft(youTubeDraft(video), video.videoId, items, skipped);
      }
      const warnings =
        unknown === 0
          ? []
          : [
              `Could not tell whether ${unknown} YouTube upload(s) are Shorts; listed as regular videos for now ` +
                '(re-checked on the next poll).',
            ];
      const next: YouTubeCursor = { etag: feed.etag, lastModified: feed.lastModified, kinds };
      return {
        items,
        skipped,
        warnings,
        accountLabel: feed.channelTitle,
        cursor: JSON.stringify(next),
        notModified: false,
      };
    },
  };
}

// ---------- episode linking ----------

/** What matching needs from a video (build it from a draft with `youTubeVideoRefFromDraft`). */
export interface YouTubeVideoRef {
  videoId: string;
  title: string;
  publishedAt: Date;
  isShort: boolean;
}

/** An RSS episode plus the YouTube link it already carries (`links.youtube`), if any. */
export interface YouTubeEpisodeRef extends EpisodeRef {
  youtube?: string | null;
}

export interface YouTubeMatchOptions {
  /** How far apart episode and video may be published for number / title-containment matches. Default 7 days. */
  maxDateDistanceMs?: number;
}

export function youTubeVideoRefFromDraft(draft: NewsItemDraft): YouTubeVideoRef | null {
  if (draft.source !== 'youtube_short' && draft.source !== 'youtube_video') return null;
  if (!draft.dedupeKey.startsWith(YOUTUBE_DEDUPE_PREFIX)) return null;
  const videoId = draft.dedupeKey.slice(YOUTUBE_DEDUPE_PREFIX.length);
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  return {
    videoId,
    title: draft.title ?? '',
    publishedAt: draft.publishedAt,
    isShort: draft.source === 'youtube_short',
  };
}

/**
 * Matches RSS episodes to (non-Short) YouTube videos. Returns episode dedupeKey → videoId.
 *   1. `matchEpisodes` (normalized title — never across conflicting episode numbers — then episode number — RSS itunes:episode or "פרק NN" in the RSS
 *      title — vs "פרק NN" anywhere in the video title, within `maxDateDistanceMs`). Date-only matching is
 *      off: a wrong match would hide an unrelated video.
 *   2. title containment: one normalized title (without the "פרק NN -" prefix, ≥ 2 words) contained in
 *      the other, no conflicting episode number, within the window, unique on both sides.
 * Shorts never match. Each video is used at most once.
 */
export function matchYouTubeEpisodes(
  episodes: readonly EpisodeRef[],
  videos: readonly YouTubeVideoRef[],
  options: YouTubeMatchOptions = {},
): Map<string, string> {
  const window = options.maxDateDistanceMs ?? 7 * DAY;
  const refs = episodes.map((e) => ({
    ...e,
    episodeNumber: e.episodeNumber ?? episodeNumberFromTitle(e.title),
  }));
  const regular = videos.filter((v) => !v.isShort);
  const candidates: PlatformEpisode[] = regular.map((v) => ({
    url: v.videoId,
    title: v.title,
    publishedAt: v.publishedAt,
    guid: null,
    dayPrecision: false,
  }));
  const result = matchEpisodes(refs, candidates, window, {
    allowDateOnly: false,
    rejectConflictingNumbers: true,
  });

  const used = new Set(result.values());
  const strippedKey = (title: string): string | null => {
    const keys = titleKeys(title);
    const key = keys[keys.length - 1] ?? '';
    return key.split(' ').length >= 2 ? key : null;
  };
  const contains = (a: string, b: string): boolean => ` ${a} `.includes(` ${b} `);
  const pairs: { ref: string; video: string }[] = [];
  for (const ref of refs) {
    if (result.has(ref.dedupeKey)) continue;
    const refKey = strippedKey(ref.title);
    if (refKey === null) continue;
    for (const v of regular) {
      if (used.has(v.videoId) || Math.abs(v.publishedAt.getTime() - ref.publishedAt.getTime()) > window)
        continue;
      const n = episodeNumberFromTitle(v.title);
      if (n !== null && ref.episodeNumber !== null && n !== ref.episodeNumber) continue;
      const videoKey = strippedKey(v.title);
      const videoFull = normalizeTitle(v.title);
      if (
        contains(videoFull, refKey) ||
        (videoKey !== null && contains(normalizeTitle(ref.title), videoKey))
      ) {
        pairs.push({ ref: ref.dedupeKey, video: v.videoId });
      }
    }
  }
  for (const p of pairs) {
    const unique =
      pairs.filter((q) => q.ref === p.ref).length === 1 &&
      pairs.filter((q) => q.video === p.video).length === 1;
    if (unique) result.set(p.ref, p.video);
  }
  return result;
}

/**
 * True when this video is (or would be matched as) an episode's YouTube video, so apps/api must not
 * publish it as its own `youtube_video` item. Shorts → always false. An episode whose `youtube` link
 * points at this video → true; episodes already linked to a *different* video are left out of matching
 * (so a "highlights" upload of an already-linked episode stays its own item). Pure.
 */
export function isEpisodeVideo(
  video: YouTubeVideoRef,
  episodes: readonly YouTubeEpisodeRef[],
  options: YouTubeMatchOptions = {},
): boolean {
  if (video.isShort) return false;
  const unlinked: YouTubeEpisodeRef[] = [];
  for (const ep of episodes) {
    const linkedId = youTubeVideoIdFromUrl(ep.youtube);
    if (linkedId === video.videoId) return true;
    if (linkedId === null) unlinked.push(ep);
  }
  return matchYouTubeEpisodes(unlinked, [video], options).size > 0;
}

export interface YouTubeLinkResolverConfig extends YouTubeMatchOptions {
  channelId: string;
  kindCache?: YouTubeKindCache;
}

/**
 * Podcast link resolver (platform 'youtube'): reads the channel feed (newest 15 uploads only), classifies
 * (normally 0 requests: shared cache / the feed's `/shorts/` links) and matches episodes to videos with
 * `matchYouTubeEpisodes`. Only videos *known* to be regular are matched — never a Short, nor a video
 * whose classification failed. Links are `https://www.youtube.com/watch?v=<id>`.
 */
export function createYouTubeLinkResolver(
  config: YouTubeLinkResolverConfig,
  ctx: IntegrationContext,
): PodcastLinkResolver {
  return {
    platform: 'youtube',
    async resolve(episodes): Promise<ResolvedPodcastLinks> {
      if (episodes.length === 0) return new Map();
      const feed = await fetchYouTubeFeed({ channelId: config.channelId }, ctx);
      const { videos } = await classifyYouTubeVideos(
        feed.videos,
        ctx,
        config.kindCache === undefined ? {} : { cache: config.kindCache },
      );
      const refs: YouTubeVideoRef[] = videos
        .filter((v) => v.kindKnown && v.kind === 'video')
        .map((v) => ({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, isShort: false }));
      const matched = matchYouTubeEpisodes(episodes, refs, config);
      return new Map([...matched].map(([key, id]) => [key, { youtube: youTubeWatchUrl(id) }]));
    },
  };
}
