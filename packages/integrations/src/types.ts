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
  skipped: SkippedItem[];
  /** e.g. podcast title or "@handle", shown in the admin console. */
  accountLabel: string | null;
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

/** Resolves platform links for episodes. Spotify/Apple may list an episode minutes–hours after RSS. */
export interface PodcastLinkResolver {
  resolve(episodes: readonly EpisodeRef[]): Promise<Map<string, { spotify?: string; apple?: string }>>;
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
