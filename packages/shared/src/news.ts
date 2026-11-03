import * as z from 'zod/mini';
import { NewsItemIdSchema } from './ids.js';

/**
 * Phase 2 contract: the automatic News feed, push notifications and the admin integrations console.
 */

// ---------- news feed ----------
export const NewsSourceSchema = z.enum([
  'podcast',
  'instagram_post',
  'instagram_story',
  'x_post',
  'admin_update',
  /** A YouTube Short (vertical, ≤ 60 s). */
  'youtube_short',
  /** A regular YouTube upload that isn't a podcast episode (episodes get a YouTube link on their card instead). */
  'youtube_video',
]);
export type NewsSource = z.infer<typeof NewsSourceSchema>;

export const NewsMediaSchema = z.object({
  kind: z.enum(['image', 'video']),
  /** Re-hosted by apps/api (Instagram CDN URLs expire) — always safe to render. */
  url: z.string().check(z.url()),
  /** Video poster / thumbnail. */
  posterUrl: z.nullable(z.string().check(z.url())),
  width: z.nullable(z.number().check(z.int(), z.positive())),
  height: z.nullable(z.number().check(z.int(), z.positive())),
  /**
   * Smaller re-encoded copies of an image (e.g. 320 / 640 px wide) for `srcset`, smallest first. Absent for videos
   * and for images that are already small. `url` stays the full-size original.
   */
  variants: z.optional(
    z.array(z.object({ url: z.string().check(z.url()), width: z.number().check(z.int(), z.positive()) })),
  ),
});
export type NewsMedia = z.infer<typeof NewsMediaSchema>;

export const NewsLinksSchema = z.object({
  spotify: z.nullable(z.string().check(z.url())),
  apple: z.nullable(z.string().check(z.url())),
  instagram: z.nullable(z.string().check(z.url())),
  x: z.nullable(z.string().check(z.url())),
  /** Watch on YouTube: the matching video for an episode, or the video/short itself. */
  youtube: z.optional(z.nullable(z.string().check(z.url()))),
  /** Direct audio enclosure from the podcast RSS. Stored only — never played in the app (client decision). */
  audio: z.nullable(z.string().check(z.url())),
  /** Generic link (admin updates), rendered as an "open link" button. */
  web: z.optional(z.nullable(z.string().check(z.url()))),
});
export type NewsLinks = z.infer<typeof NewsLinksSchema>;

export const PodcastMetaSchema = z.object({
  episodeNumber: z.nullable(z.number().check(z.int(), z.positive())),
  seasonNumber: z.nullable(z.number().check(z.int(), z.positive())),
  durationSec: z.nullable(z.number().check(z.int(), z.nonnegative())),
});
export type PodcastMeta = z.infer<typeof PodcastMetaSchema>;

export const NewsItemSchema = z.object({
  id: NewsItemIdSchema,
  source: NewsSourceSchema,
  /** Episode title; null for posts/tweets. */
  title: z.nullable(z.string()),
  /** Plain text (caption / tweet / episode description with HTML stripped). Line breaks preserved. */
  text: z.nullable(z.string()),
  media: z.array(NewsMediaSchema),
  links: NewsLinksSchema,
  podcast: z.nullable(PodcastMetaSchema),
  publishedAt: z.string().check(z.iso.datetime({ offset: true })),
  /** Instagram stories only: publishedAt + 24 h. */
  expiresAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

/** GET /v1/news?cursor=&limit= — newest first, stories excluded (they live in the stories bar). */
export const NewsPageSchema = z.object({
  items: z.array(NewsItemSchema),
  nextCursor: z.nullable(z.string()),
});
export type NewsPage = z.infer<typeof NewsPageSchema>;

/**
 * News feed filter chips. Each maps to one or more sources:
 * episodes → podcast · shorts → youtube_short · videos → youtube_video · instagram → instagram_post ·
 * x → x_post · updates → admin_update. (Stories never appear in the feed, so they have no filter.)
 */
export const NewsFilterSchema = z.enum(['episodes', 'shorts', 'videos', 'instagram', 'x', 'updates']);
export type NewsFilter = z.infer<typeof NewsFilterSchema>;

export const NEWS_FILTER_SOURCES: Readonly<Record<NewsFilter, readonly NewsSource[]>> = {
  episodes: ['podcast'],
  shorts: ['youtube_short'],
  videos: ['youtube_video'],
  instagram: ['instagram_post'],
  x: ['x_post'],
  updates: ['admin_update'],
};

export const NewsPageQuerySchema = z.object({
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(50)), 20),
  /** Omitted = everything (the "All" chip). The cursor is only valid for the filter it was issued with. */
  filter: z.optional(NewsFilterSchema),
});

/** GET /v1/news/filters — the filters that currently have at least one visible item, in display order. */
export const NewsFiltersSchema = z.object({ filters: z.array(NewsFilterSchema) });
export type NewsFilters = z.infer<typeof NewsFiltersSchema>;

/** GET /v1/news/stories — unexpired Instagram stories, oldest first (Instagram order). */
export const StoriesSchema = z.object({ items: z.array(NewsItemSchema) });
export type Stories = z.infer<typeof StoriesSchema>;

// ---------- push notifications ----------
export const NotificationPrefsSchema = z.object({
  /** New podcast episode, Instagram post/story, X post. */
  news: z.boolean(),
  /** FPL deadline reminders + gameweek summaries. */
  fpl: z.boolean(),
  /** Admin live broadcasts (e.g. goal alerts). */
  live: z.boolean(),
  /** Replies/comments on your community posts (Phase 3). */
  community: z.boolean(),
  /**
   * Your moments in the podcast's league: after each GW (top scorer, first place, climbed 3+, top 3 / top 10) and live
   * big moments during a GW (moved into first place, jumped 5+ places). Defaults to on; optional on input.
   */
  league: z._default(z.boolean(), true),
  /** Live alerts during a gameweek: your captain scored or assisted. Defaults to on; optional on input. */
  captain: z._default(z.boolean(), true),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** GET /v1/push/vapid-public-key */
export const VapidKeySchema = z.object({ publicKey: z.string().check(z.minLength(20)) });

/** POST /v1/push/subscriptions — the browser's PushSubscription.toJSON(). Idempotent by endpoint. */
export const WebPushSubscriptionBodySchema = z.object({
  endpoint: z.string().check(z.url(), z.maxLength(2000)),
  expirationTime: z.optional(z.nullable(z.number())),
  keys: z.object({
    p256dh: z.string().check(z.minLength(10), z.maxLength(200)),
    auth: z.string().check(z.minLength(4), z.maxLength(100)),
  }),
});
export type WebPushSubscriptionBody = z.infer<typeof WebPushSubscriptionBodySchema>;

/** DELETE /v1/push/subscriptions */
export const DeleteWebPushSubscriptionBodySchema = z.object({
  endpoint: z.string().check(z.url(), z.maxLength(2000)),
});

/** POST /v1/push/devices — reserved for the Capacitor shells (FCM / APNs tokens). */
export const NativePushDeviceBodySchema = z.object({
  platform: z.enum(['fcm', 'apns']),
  token: z.string().check(z.minLength(10), z.maxLength(4096)),
});

/** What the service worker receives in `event.data.json()`. */
export const PushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  /** App-relative URL to open on click, e.g. "/news/?item=abc". */
  url: z.string(),
  /** Collapses notifications of the same kind (e.g. "deadline-9"). */
  tag: z.nullable(z.string()),
  icon: z.nullable(z.string()),
  image: z.nullable(z.string().check(z.url())),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/** POST /v1/admin/push — manual broadcast to every subscribed user. */
export const AdminPushBodySchema = z.object({
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(80)),
  body: z.string().check(z.trim(), z.minLength(1), z.maxLength(300)),
  url: z._default(z.string().check(z.startsWith('/'), z.maxLength(300)), '/news/'),
});
export type AdminPushBody = z.infer<typeof AdminPushBodySchema>;

export const AdminPushResultSchema = z.object({
  recipients: z.number().check(z.int()),
  delivered: z.number().check(z.int()),
});
export type AdminPushResult = z.infer<typeof AdminPushResultSchema>;

/** Per-device outcome of one send: accepted by the push service, dead (404/410 → removed), or failed. */
export const PushDeliveryStatsSchema = z.object({
  devices: z.number().check(z.int(), z.nonnegative()),
  delivered: z.number().check(z.int(), z.nonnegative()),
  gone: z.number().check(z.int(), z.nonnegative()),
  failed: z.number().check(z.int(), z.nonnegative()),
});
export type PushDeliveryStats = z.infer<typeof PushDeliveryStatsSchema>;

/** POST /v1/push/test — sends a test notification to the caller's own devices only (rate-limited). */
export const PushTestResultSchema = PushDeliveryStatsSchema;
export type PushTestResult = z.infer<typeof PushTestResultSchema>;

export const PushServiceSchema = z.enum(['apple', 'google', 'mozilla', 'microsoft', 'other']);
export type PushService = z.infer<typeof PushServiceSchema>;

/** GET /v1/admin/push/health — no endpoints or user data, counts only. */
export const AdminPushHealthSchema = z.object({
  /** Users with at least one subscribed device. */
  users: z.number().check(z.int(), z.nonnegative()),
  devices: z.array(
    z.object({ service: PushServiceSchema, count: z.number().check(z.int(), z.nonnegative()) }),
  ),
  /** Most recent notification batches, newest first (at most 10). */
  recent: z.array(
    z.extend(PushDeliveryStatsSchema, {
      at: z.string().check(z.iso.datetime({ offset: true })),
      /** e.g. "news", "deadline", "admin", "test", "live". */
      kind: z.string(),
      /** HTTP status codes of failures, e.g. [403], for diagnosis. */
      failureCodes: z.array(z.number().check(z.int())),
    }),
  ),
});
export type AdminPushHealth = z.infer<typeof AdminPushHealthSchema>;

// ---------- admin: integrations ----------
export const IntegrationIdSchema = z.enum(['podcast_rss', 'spotify', 'apple', 'instagram', 'x', 'youtube']);
export type IntegrationId = z.infer<typeof IntegrationIdSchema>;

export const IntegrationStatusSchema = z.object({
  id: IntegrationIdSchema,
  enabled: z.boolean(),
  /** All required settings/credentials are present. */
  configured: z.boolean(),
  /** X API is pay-per-use: the console shows "paid feature — contact creator". */
  paidFeature: z.boolean(),
  /** Human label of the connected account/show, e.g. "@fantasyonerim" or the podcast title. */
  accountLabel: z.nullable(z.string()),
  /** Non-secret settings, echoed back for the form. Secrets are never returned (only `hasSecret`). */
  settings: z.record(z.string(), z.nullable(z.string())),
  hasSecret: z.boolean(),
  /** Which secret keys are stored (names only, never values), e.g. ["clientId", "clientSecret"]. */
  secretKeys: z.array(z.string()),
  lastRunAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  lastSuccessAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  lastError: z.nullable(z.string()),
  itemsImported: z.number().check(z.int(), z.nonnegative()),
  /** Instagram only: when the stored token needs reconnecting (null = never expires). */
  tokenExpiresAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  /** Instagram only: Meta data-access expiry (re-consent date), null if not reported. */
  dataAccessExpiresAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const IntegrationListSchema = z.object({ integrations: z.array(IntegrationStatusSchema) });
export type IntegrationList = z.infer<typeof IntegrationListSchema>;

/** PUT /v1/admin/integrations/:id — each integration validates its own keys server-side. */
export const IntegrationUpdateBodySchema = z.object({
  enabled: z.boolean(),
  /**
   * Non-secret settings. podcast_rss: rssUrl · spotify: showId · apple: podcastId · x: username (userId resolved
   * server-side) · youtube: channel (handle, channel URL or UC… id; channelId resolved server-side) · instagram: set by OAuth (igUserId, username, pageId).
   */
  settings: z.record(z.string(), z.nullable(z.string().check(z.trim(), z.maxLength(500)))),
  /**
   * Secret settings, write-only. spotify: clientId, clientSecret · x: bearerToken, apiKey, apiSecret,
   * accessToken, accessSecret. Omitted keys keep their stored value; null clears it.
   */
  secrets: z.optional(z.record(z.string(), z.nullable(z.string().check(z.trim(), z.maxLength(2000))))),
});
export type IntegrationUpdateBody = z.infer<typeof IntegrationUpdateBodySchema>;

/** GET /v1/admin/integrations/instagram/connect-url → open in the browser to start Meta OAuth. */
export const OAuthStartSchema = z.object({ url: z.string().check(z.url()) });

// ---------- admin: manual news (fallback only) ----------
export const AdminNewsBodySchema = z.object({
  title: z.nullable(z.string().check(z.trim(), z.maxLength(120))),
  text: z.string().check(z.trim(), z.minLength(1), z.maxLength(2000)),
  links: z.optional(z.partial(NewsLinksSchema)),
});
export type AdminNewsBody = z.infer<typeof AdminNewsBodySchema>;

/** GET /v1/admin/news/hidden — items an admin hid, newest hidden first; POST /v1/admin/news/:id/restore → 204. */
export const HiddenNewsListSchema = z.object({
  items: z.array(
    z.object({ item: NewsItemSchema, hiddenAt: z.string().check(z.iso.datetime({ offset: true })) }),
  ),
});
export type HiddenNewsList = z.infer<typeof HiddenNewsListSchema>;

/** POST /internal/jobs/tick (external cron). */
export const JobsTickResponseSchema = z.object({ ran: z.array(z.string()) });
