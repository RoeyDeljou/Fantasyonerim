import type { NewsLinks, NewsSource, PodcastMeta } from '@fant/shared';

/**
 * Contracts for every external content platform. apps/api depends only on these types and the
 * factory functions exported from this package — never on a platform's raw response shape.
 *
 * This package never reads env vars, the database or local disk: credentials, `fetch` and the
 * clock are passed in by the caller.
 */

export interface IntegrationContext {
  fetch: typeof fetch;
  /** ms since epoch */
  now: () => number;
}

/** Media as found on the platform. apps/api downloads `sourceUrl` and re-hosts it (CDN URLs expire). */
export interface MediaDraft {
  kind: 'image' | 'video';
  sourceUrl: string;
  posterSourceUrl: string | null;
  width: number | null;
  height: number | null;
  /**
   * A smaller rendition that always exists, to re-host when `sourceUrl` can't be downloaded (YouTube:
   * `oar2.jpg` / `hq720.jpg` are not generated for every upload; `hqdefault.jpg` always is).
   */
  fallback?: MediaFallback | null;
}

export interface MediaFallback {
  sourceUrl: string;
  width: number | null;
  height: number | null;
}

export interface NewsItemDraft {
  /**
   * Stable idempotency key: `<source>:<platform id>`, e.g. `podcast:<rss guid>`, `instagram:<media id>`,
   * `x:<tweet id>`. Re-polling the same content must yield the same key.
   */
  dedupeKey: string;
  source: Exclude<NewsSource, 'admin_update'>;
  title: string | null;
  /** Plain text; HTML stripped, entities decoded, line breaks kept. */
  text: string | null;
  media: MediaDraft[];
  links: NewsLinks;
  podcast: PodcastMeta | null;
  publishedAt: Date;
  /** Stories only. */
  expiresAt: Date | null;
}

export interface SkippedItem {
  externalId: string | null;
  reason: string;
}

export interface SourceResult {
  items: NewsItemDraft[];
  /** Items present on the platform but unusable (malformed, no media URL, …). Never thrown. */
  skipped: SkippedItem[];
  /** Non-fatal problems worth showing in the admin console (e.g. "Spotify link lookup failed: …"). */
  warnings: string[];
  /** e.g. podcast title or "@handle", shown in the admin console. */
  accountLabel: string | null;
  /**
   * Opaque value to persist and pass back on the next poll (RSS: ETag/Last-Modified, X: newest post id).
   * `null` = this source keeps no cursor.
   */
  cursor: string | null;
  /** True when the platform said nothing changed since `cursor` (HTTP 304). `items` is then empty. */
  notModified: boolean;
}

/**
 * Every inbound platform implements this. Re-polling is idempotent: the caller upserts by `dedupeKey`.
 * `fetchLatest` throws only the typed errors below (auth / rate limit / unavailable / config); a single
 * bad item is reported in `skipped`, never thrown.
 */
export interface ContentSource {
  readonly source: NewsItemDraft['source'];
  fetchLatest(cursor: string | null): Promise<SourceResult>;
}

/** Typed failures so apps/api can show actionable errors in the admin console. */
export class IntegrationAuthError extends Error {
  /** Token expired / revoked / wrong credentials — admin must reconnect or re-enter keys. */
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationAuthError';
  }
}

export class IntegrationRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = 'IntegrationRateLimitError';
  }
}

/** The settings are wrong (feed URL 404 / not RSS, unknown user or account id) — admin must fix them. */
export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConfigError';
  }
}

export type IntegrationError =
  IntegrationAuthError | IntegrationRateLimitError | IntegrationUnavailableError | IntegrationConfigError;

export class IntegrationUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'IntegrationUnavailableError';
  }
}

/** An episode as known from the RSS feed, used to look up its Spotify/Apple links. */
export interface EpisodeRef {
  dedupeKey: string;
  guid: string;
  title: string;
  publishedAt: Date;
  episodeNumber: number | null;
}

/** Platforms that can add a link to an RSS episode. */
export type PodcastLinkPlatform = 'spotify' | 'apple' | 'youtube';

/** Links found by resolvers, keyed by `EpisodeRef.dedupeKey`. */
export type ResolvedPodcastLinks = Map<string, Partial<Record<PodcastLinkPlatform, string>>>;

/**
 * Resolves platform links for episodes. Spotify/Apple may list an episode minutes–hours after RSS;
 * YouTube (the full-episode video) can come even later.
 */
export interface PodcastLinkResolver {
  readonly platform: PodcastLinkPlatform;
  /** Keyed by `EpisodeRef.dedupeKey`; episodes not (yet) listed on the platform are simply absent. */
  resolve(episodes: readonly EpisodeRef[]): Promise<ResolvedPodcastLinks>;
}

/** Outbound: post text (+ optional image bytes) to a platform. Used for X and WhatsApp. */
export interface PublishInput {
  text: string;
  image: { bytes: Uint8Array; mimeType: string } | null;
}
export interface PublishResult {
  externalId: string;
  url: string | null;
}
export interface Publisher {
  publish(input: PublishInput): Promise<PublishResult>;
}
