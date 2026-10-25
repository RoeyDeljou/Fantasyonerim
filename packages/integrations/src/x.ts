import { z } from 'zod';
import { EMPTY_LINKS, acceptDraft, parseDateOrNull, positiveIntOrNull } from './drafts.js';
import { httpUrlOrNull, parseEnvelope, readJson, retryAfterSec, send } from './http.js';
import { oauth1Header } from './oauth1.js';
import type { OAuth1Credentials } from './oauth1.js';
import { X_MAX_WEIGHTED_LENGTH, xWeightedLength } from './x-text.js';
import type {
  ContentSource,
  IntegrationContext,
  MediaDraft,
  Publisher,
  PublishInput,
  PublishResult,
  SourceResult,
} from './types.js';
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';

export const X_API_URL = 'https://api.x.com/2';

/**
 * X is pay-per-use (each post read is billed), so reading is deliberately frugal: one request per poll,
 * `since_id` so only new posts are returned, small `max_results`, and further pages only while
 * catching up after a gap.
 */
export interface XTimelineConfig {
  bearerToken: string;
  /** Numeric user id (from `resolveXUser`). */
  userId: string;
  /** For permalinks and the admin label. Without it links use https://x.com/i/status/<id>. */
  username?: string;
  /** Previous poll's cursor (newest post id). Omit on the first poll. */
  sinceId?: string | null;
  /** 5–100, default 10. */
  maxResults?: number;
  /** Pages to follow while catching up (only with sinceId), default 3. */
  maxPages?: number;
  /** Default true. */
  excludeReplies?: boolean;
  /** Default true. */
  excludeRetweets?: boolean;
}

// ---------- errors ----------

/** Maps a non-2xx X response onto the typed integration errors. */
export function xError(res: Response, body: unknown, nowMs: number, action: string): Error {
  const detail = describeXBody(body);
  if (res.status === 401) {
    return new IntegrationAuthError(
      `X rejected the credentials while trying to ${action} — re-enter the keys.${detail}`,
    );
  }
  if (res.status === 403) {
    return new IntegrationAuthError(
      `X refused to ${action} (HTTP 403). The X API plan/credits may be missing or the app lacks this ` +
        `permission (posting needs "Read and write" and regenerated access tokens).${detail}`,
    );
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const retry = Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.ceil(reset - nowMs / 1000)) : null;
    return new IntegrationRateLimitError(
      `X rate limit reached while trying to ${action}.${detail}`,
      retry ?? retryAfterSec(res, nowMs),
    );
  }
  if (res.status === 402) {
    return new IntegrationAuthError(`X says the account has no API credits left (HTTP 402).${detail}`);
  }
  if (res.status === 404 || res.status === 400) {
    return new IntegrationConfigError(
      `X could not ${action} (HTTP ${res.status}) — check the account settings.${detail}`,
    );
  }
  return new IntegrationUnavailableError(`X failed to ${action} (HTTP ${res.status}).${detail}`, res.status);
}

function describeXBody(body: unknown): string {
  const parsed = z.object({ title: z.string().optional(), detail: z.string().optional() }).safeParse(body);
  if (!parsed.success) return '';
  const text = parsed.data.detail ?? parsed.data.title;
  return text === undefined ? '' : ` (${text.slice(0, 200)})`;
}

// ---------- user lookup ----------

const UserSchema = z.object({
  data: z.object({ id: z.string(), username: z.string(), name: z.string() }).optional(),
  errors: z.array(z.unknown()).optional(),
});

export interface XUser {
  id: string;
  username: string;
  name: string;
}

/** Accepts "fantasyonerim", "@fantasyonerim" or an x.com / twitter.com profile URL. */
export function parseXUsername(input: string): string | null {
  let s = input.trim();
  try {
    const url = new URL(s);
    if (/(^|\.)(x|twitter)\.com$/.test(url.hostname)) s = url.pathname.split('/')[1] ?? '';
  } catch {
    // not a URL
  }
  s = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
}

/** `GET /2/users/by/username/:username` → id (store it as x.settings.userId). */
export async function resolveXUser(
  input: { bearerToken: string; username: string },
  ctx: IntegrationContext,
): Promise<XUser> {
  const username = parseXUsername(input.username);
  if (username === null) throw new IntegrationConfigError(`"${input.username}" is not a valid X username.`);
  const res = await send(ctx, 'X', `${X_API_URL}/users/by/username/${username}`, {
    headers: { Authorization: `Bearer ${input.bearerToken}`, Accept: 'application/json' },
  });
  const body = await readJson(res);
  if (!res.ok) throw xError(res, body, ctx.now(), 'look up the account');
  const parsed = parseEnvelope('X', UserSchema, body, res.status);
  if (parsed.data === undefined) throw new IntegrationConfigError(`X has no account @${username}.`);
  return parsed.data;
}

// ---------- timeline ----------

const UrlEntitySchema = z.object({
  start: z.number().optional(),
  end: z.number().optional(),
  url: z.string(),
  expanded_url: z.string().optional(),
  display_url: z.string().optional(),
  media_key: z.string().optional(),
});
const EntitiesSchema = z.object({ urls: z.array(UrlEntitySchema).optional() }).optional();

const TweetSchema = z.object({
  id: z.string().regex(/^\d+$/),
  text: z.string(),
  created_at: z.string(),
  entities: EntitiesSchema,
  attachments: z.object({ media_keys: z.array(z.string()).optional() }).optional(),
  note_tweet: z.object({ text: z.string(), entities: EntitiesSchema }).optional(),
});

const MediaSchema = z.object({
  media_key: z.string(),
  type: z.enum(['photo', 'video', 'animated_gif']),
  url: z.string().optional(),
  preview_image_url: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  variants: z
    .array(z.object({ bit_rate: z.number().optional(), content_type: z.string(), url: z.string() }))
    .optional(),
});

const TimelineSchema = z.object({
  data: z.array(z.unknown()).optional(),
  includes: z.object({ media: z.array(z.unknown()).optional() }).optional(),
  meta: z
    .object({
      newest_id: z.string().optional(),
      result_count: z.number().optional(),
      next_token: z.string().optional(),
    })
    .optional(),
});

/**
 * Replaces each t.co link with its expanded URL; links that point at the post's own attached media
 * (`media_key`, or …/status/<id>/photo|video/N) are removed since the media is shown inline.
 */
export function expandXText(text: string, urls: readonly z.infer<typeof UrlEntitySchema>[]): string {
  let out = text;
  for (const u of urls) {
    const isMediaLink =
      u.media_key !== undefined || /\/status\/\d+\/(photo|video)\/\d+$/.test(u.expanded_url ?? '');
    const replacement = isMediaLink
      ? ''
      : httpUrlOrNull(u.expanded_url) === null
        ? u.url
        : (u.expanded_url ?? u.url);
    out = out.split(u.url).join(replacement);
  }
  return out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function bestVideo(m: z.infer<typeof MediaSchema>): string | null {
  const mp4 = (m.variants ?? [])
    .filter((v) => v.content_type === 'video/mp4' && httpUrlOrNull(v.url) !== null)
    .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0));
  return mp4[0]?.url ?? null;
}

function toMedia(m: z.infer<typeof MediaSchema>): MediaDraft | null {
  const width = positiveIntOrNull(m.width ?? null);
  const height = positiveIntOrNull(m.height ?? null);
  if (m.type === 'photo') {
    const url = httpUrlOrNull(m.url);
    return url === null ? null : { kind: 'image', sourceUrl: url, posterSourceUrl: null, width, height };
  }
  const video = bestVideo(m);
  const poster = httpUrlOrNull(m.preview_image_url);
  if (video !== null) return { kind: 'video', sourceUrl: video, posterSourceUrl: poster, width, height };
  // No playable variant (e.g. still processing): fall back to the preview image.
  return poster === null ? null : { kind: 'image', sourceUrl: poster, posterSourceUrl: null, width, height };
}

function maxId(a: string | null, b: string): string {
  if (a === null) return b;
  return BigInt(b) > BigInt(a) ? b : a;
}

/**
 * New original posts of the account since `sinceId` (replies and reposts excluded by default).
 * Returns the newest seen id as `cursor` (unchanged when there is nothing new).
 */
export async function fetchXPosts(config: XTimelineConfig, ctx: IntegrationContext): Promise<SourceResult> {
  const username = config.username === undefined ? null : parseXUsername(config.username);
  const sinceId = config.sinceId ?? null;
  const maxResults = String(Math.min(Math.max(config.maxResults ?? 10, 5), 100));
  const exclude = [
    ...(config.excludeReplies === false ? [] : ['replies']),
    ...(config.excludeRetweets === false ? [] : ['retweets']),
  ];
  const result: SourceResult = {
    items: [],
    skipped: [],
    warnings: [],
    accountLabel: username === null ? null : `@${username}`,
    cursor: sinceId,
    notModified: false,
  };
  let cursor = sinceId;
  let paginationToken: string | null = null;
  const pages = sinceId === null ? 1 : Math.max(config.maxPages ?? 3, 1);
  for (let page = 0; page < pages; page++) {
    const url = new URL(`${X_API_URL}/users/${encodeURIComponent(config.userId)}/tweets`);
    if (exclude.length > 0) url.searchParams.set('exclude', exclude.join(','));
    url.searchParams.set('max_results', maxResults);
    url.searchParams.set('tweet.fields', 'created_at,entities,attachments,note_tweet');
    url.searchParams.set('expansions', 'attachments.media_keys');
    url.searchParams.set('media.fields', 'type,url,preview_image_url,width,height,variants');
    if (sinceId !== null) url.searchParams.set('since_id', sinceId);
    if (paginationToken !== null) url.searchParams.set('pagination_token', paginationToken);

    const res = await send(ctx, 'X', url.toString(), {
      headers: { Authorization: `Bearer ${config.bearerToken}`, Accept: 'application/json' },
    });
    const body = await readJson(res);
    if (!res.ok) throw xError(res, body, ctx.now(), 'read the timeline');
    const parsed = parseEnvelope('X', TimelineSchema, body, res.status);

    const mediaByKey = new Map<string, z.infer<typeof MediaSchema>>();
    for (const raw of parsed.includes?.media ?? []) {
      const m = MediaSchema.safeParse(raw);
      if (m.success) mediaByKey.set(m.data.media_key, m.data);
    }
    for (const raw of parsed.data ?? []) {
      const t = TweetSchema.safeParse(raw);
      if (!t.success) {
        result.skipped.push({ externalId: null, reason: 'unrecognized X post object' });
        continue;
      }
      const tw = t.data;
      cursor = maxId(cursor, tw.id);
      const publishedAt = parseDateOrNull(tw.created_at);
      if (publishedAt === null) {
        result.skipped.push({ externalId: tw.id, reason: 'invalid created_at' });
        continue;
      }
      const long = tw.note_tweet;
      const text = long
        ? expandXText(long.text, long.entities?.urls ?? tw.entities?.urls ?? [])
        : expandXText(tw.text, tw.entities?.urls ?? []);
      const media = (tw.attachments?.media_keys ?? [])
        .map((k) => mediaByKey.get(k))
        .map((m) => (m === undefined ? null : toMedia(m)))
        .filter((m): m is MediaDraft => m !== null);
      acceptDraft(
        {
          dedupeKey: `x:${tw.id}`,
          source: 'x_post',
          title: null,
          text: text === '' ? null : text,
          media,
          links: {
            ...EMPTY_LINKS,
            x: `https://x.com/${username ?? 'i'}/status/${tw.id}`,
          },
          podcast: null,
          publishedAt,
          expiresAt: null,
        },
        tw.id,
        result.items,
        result.skipped,
      );
    }
    if (parsed.meta?.newest_id !== undefined && /^\d+$/.test(parsed.meta.newest_id)) {
      cursor = maxId(cursor, parsed.meta.newest_id);
    }
    paginationToken = parsed.meta?.next_token ?? null;
    if (paginationToken === null) break;
  }
  result.cursor = cursor;
  return result;
}

export function createXSource(
  config: Omit<XTimelineConfig, 'sinceId'>,
  ctx: IntegrationContext,
): ContentSource {
  return { source: 'x_post', fetchLatest: (cursor) => fetchXPosts({ ...config, sinceId: cursor }, ctx) };
}

// ---------- publishing ----------

export interface XPublisherConfig {
  /** "API Key" / consumer key of the X app. */
  apiKey: string;
  /** "API Key Secret" / consumer secret. */
  apiSecret: string;
  /** User access token (generated with Read and write permission). */
  accessToken: string;
  accessSecret: string;
  /** For the returned post URL. */
  username?: string;
}

export const X_MEDIA_UPLOAD_URL = `${X_API_URL}/media/upload`;
const X_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const X_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class XPostTooLongError extends Error {
  constructor(readonly weightedLength: number) {
    super(
      `The post is ${weightedLength} characters long by X's count; the limit is ${X_MAX_WEIGHTED_LENGTH}.`,
    );
    this.name = 'XPostTooLongError';
  }
}

const UploadSchema = z.object({ data: z.object({ id: z.string().min(1) }) });
const CreateSchema = z.object({ data: z.object({ id: z.string().min(1) }) });

/**
 * Posts as the account whose access token is configured (OAuth 1.0a user context). Image upload uses
 * the v2 simple upload endpoint `POST /2/media/upload` (multipart, images ≤ 5 MB; the v1.1
 * upload.twitter.com endpoint is deprecated), then `POST /2/tweets` with `media.media_ids`.
 */
export function createXPublisher(config: XPublisherConfig, ctx: IntegrationContext): Publisher {
  const creds: OAuth1Credentials = {
    consumerKey: config.apiKey,
    consumerSecret: config.apiSecret,
    token: config.accessToken,
    tokenSecret: config.accessSecret,
  };
  const auth = (method: string, url: string): string =>
    oauth1Header(creds, { method, url, timestamp: Math.floor(ctx.now() / 1000) });

  async function uploadImage(image: NonNullable<PublishInput['image']>): Promise<string> {
    if (!X_IMAGE_TYPES.has(image.mimeType)) {
      throw new IntegrationConfigError(`X accepts JPEG, PNG, WEBP or GIF images, not ${image.mimeType}.`);
    }
    if (image.bytes.byteLength > X_MAX_IMAGE_BYTES) {
      throw new IntegrationConfigError('The image is larger than X allows (5 MB).');
    }
    const form = new FormData();
    form.set('media', new Blob([image.bytes], { type: image.mimeType }), 'image');
    form.set('media_category', 'tweet_image');
    form.set('media_type', image.mimeType);
    const res = await send(
      ctx,
      'X',
      X_MEDIA_UPLOAD_URL,
      {
        method: 'POST',
        headers: { Authorization: auth('POST', X_MEDIA_UPLOAD_URL) },
        body: form,
      },
      60_000,
    );
    const body = await readJson(res);
    if (!res.ok) throw xError(res, body, ctx.now(), 'upload the image');
    return parseEnvelope('X media upload', UploadSchema, body, res.status).data.id;
  }

  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      const text = input.text.trim();
      if (text === '' && input.image === null) throw new IntegrationConfigError('Nothing to post.');
      const weighted = xWeightedLength(text);
      if (weighted > X_MAX_WEIGHTED_LENGTH) throw new XPostTooLongError(weighted);

      const mediaId = input.image === null ? null : await uploadImage(input.image);
      const url = `${X_API_URL}/tweets`;
      const payload: { text?: string; media?: { media_ids: string[] } } = {};
      if (text !== '') payload.text = text;
      if (mediaId !== null) payload.media = { media_ids: [mediaId] };
      const res = await send(ctx, 'X', url, {
        method: 'POST',
        headers: { Authorization: auth('POST', url), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (!res.ok) throw xError(res, body, ctx.now(), 'publish the post');
      const id = parseEnvelope('X create post', CreateSchema, body, res.status).data.id;
      const username = config.username === undefined ? null : parseXUsername(config.username);
      return { externalId: id, url: `https://x.com/${username ?? 'i'}/status/${id}` };
    },
  };
}
