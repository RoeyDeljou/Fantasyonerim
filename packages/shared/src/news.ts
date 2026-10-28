import { z } from 'zod';
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
  url: z.string().url(),
  /** Video poster / thumbnail. */
  posterUrl: z.string().url().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type NewsMedia = z.infer<typeof NewsMediaSchema>;

export const NewsLinksSchema = z.object({
  spotify: z.string().url().nullable(),
  apple: z.string().url().nullable(),
  instagram: z.string().url().nullable(),
  x: z.string().url().nullable(),
  /** Watch on YouTube: the matching video for an episode, or the video/short itself. */
  youtube: z.string().url().nullable().optional(),
  /** Direct audio enclosure from the podcast RSS. Stored only — never played in the app (client decision). */
  audio: z.string().url().nullable(),
  /** Generic link (admin updates), rendered as an "open link" button. */
  web: z.string().url().nullable().optional(),
});
export type NewsLinks = z.infer<typeof NewsLinksSchema>;

export const PodcastMetaSchema = z.object({
  episodeNumber: z.number().int().positive().nullable(),
  seasonNumber: z.number().int().positive().nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
});
export type PodcastMeta = z.infer<typeof PodcastMetaSchema>;

export const NewsItemSchema = z.object({
  id: NewsItemIdSchema,
  source: NewsSourceSchema,
  /** Episode title; null for posts/tweets. */
  title: z.string().nullable(),
  /** Plain text (caption / tweet / episode description with HTML stripped). Line breaks preserved. */
  text: z.string().nullable(),
  media: z.array(NewsMediaSchema),
  links: NewsLinksSchema,
  podcast: PodcastMetaSchema.nullable(),
  publishedAt: z.string().datetime({ offset: true }),
  /** Instagram stories only: publishedAt + 24 h. */
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

/** GET /v1/news?cursor=&limit= — newest first, stories excluded (they live in the stories bar). */
export const NewsPageSchema = z.object({
  items: z.array(NewsItemSchema),
  nextCursor: z.string().nullable(),
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
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Omitted = everything (the "All" chip). The cursor is only valid for the filter it was issued with. */
  filter: NewsFilterSchema.optional(),
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
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** GET /v1/push/vapid-public-key */
export const VapidKeySchema = z.object({ publicKey: z.string().min(20) });

/** POST /v1/push/subscriptions — the browser's PushSubscription.toJSON(). Idempotent by endpoint. */
export const WebPushSubscriptionBodySchema = z.object({
  endpoint: z.string().url().max(2000),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});
export type WebPushSubscriptionBody = z.infer<typeof WebPushSubscriptionBodySchema>;

/** DELETE /v1/push/subscriptions */
export const DeleteWebPushSubscriptionBodySchema = z.object({ endpoint: z.string().url().max(2000) });

/** POST /v1/push/devices — reserved for the Capacitor shells (FCM / APNs tokens). */
export const NativePushDeviceBodySchema = z.object({
  platform: z.enum(['fcm', 'apns']),
  token: z.string().min(10).max(4096),
});

/** What the service worker receives in `event.data.json()`. */
export const PushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  /** App-relative URL to open on click, e.g. "/news/?item=abc". */
  url: z.string(),
  /** Collapses notifications of the same kind (e.g. "deadline-9"). */
  tag: z.string().nullable(),
  icon: z.string().nullable(),
  image: z.string().url().nullable(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/** POST /v1/admin/push — manual broadcast to every subscribed user. */
export const AdminPushBodySchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(300),
  url: z.string().startsWith('/').max(300).default('/news/'),
});
export type AdminPushBody = z.infer<typeof AdminPushBodySchema>;

export const AdminPushResultSchema = z.object({ recipients: z.number().int(), delivered: z.number().int() });
export type AdminPushResult = z.infer<typeof AdminPushResultSchema>;

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
  accountLabel: z.string().nullable(),
  /** Non-secret settings, echoed back for the form. Secrets are never returned (only `hasSecret`). */
  settings: z.record(z.string(), z.string().nullable()),
  hasSecret: z.boolean(),
  /** Which secret keys are stored (names only, never values), e.g. ["clientId", "clientSecret"]. */
  secretKeys: z.array(z.string()),
  lastRunAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().nullable(),
  itemsImported: z.number().int().nonnegative(),
  /** Instagram only: when the stored token needs reconnecting (null = never expires). */
  tokenExpiresAt: z.string().datetime({ offset: true }).nullable(),
  /** Instagram only: Meta data-access expiry (re-consent date), null if not reported. */
  dataAccessExpiresAt: z.string().datetime({ offset: true }).nullable(),
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
  settings: z.record(z.string(), z.string().trim().max(500).nullable()),
  /**
   * Secret settings, write-only. spotify: clientId, clientSecret · x: bearerToken, apiKey, apiSecret,
   * accessToken, accessSecret. Omitted keys keep their stored value; null clears it.
   */
  secrets: z.record(z.string(), z.string().trim().max(2000).nullable()).optional(),
});
export type IntegrationUpdateBody = z.infer<typeof IntegrationUpdateBodySchema>;

/** GET /v1/admin/integrations/instagram/connect-url → open in the browser to start Meta OAuth. */
export const OAuthStartSchema = z.object({ url: z.string().url() });

// ---------- admin: manual news (fallback only) ----------
export const AdminNewsBodySchema = z.object({
  title: z.string().trim().max(120).nullable(),
  text: z.string().trim().min(1).max(2000),
  links: NewsLinksSchema.partial().optional(),
});
export type AdminNewsBody = z.infer<typeof AdminNewsBodySchema>;

/** GET /v1/admin/news/hidden — items an admin hid, newest hidden first; POST /v1/admin/news/:id/restore → 204. */
export const HiddenNewsListSchema = z.object({
  items: z.array(z.object({ item: NewsItemSchema, hiddenAt: z.string().datetime({ offset: true }) })),
});
export type HiddenNewsList = z.infer<typeof HiddenNewsListSchema>;

/** POST /internal/jobs/tick (external cron). */
export const JobsTickResponseSchema = z.object({ ran: z.array(z.string()) });
