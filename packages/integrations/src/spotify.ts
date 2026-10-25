import { z } from 'zod';
import { httpUrlOrNull, parseEnvelope, readJson, retryAfterSec, send } from './http.js';
import { matchEpisodes } from './podcast-links.js';
import type { PlatformEpisode } from './podcast-links.js';
import type { IntegrationContext, PodcastLinkResolver, ResolvedPodcastLinks } from './types.js';
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';

export interface SpotifyLinkResolverConfig {
  /** Bare show id or a show URL/URI — normalized with `parseSpotifyShowId`. */
  showId: string;
  clientId: string;
  clientSecret: string;
  /** Default "IL": episodes are only listed for a market. */
  market?: string;
  /** Safety cap on pages of 50 (default 6 = 300 episodes). */
  maxPages?: number;
}

export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const PAGE_SIZE = 50;
const DAY = 86_400_000;

/**
 * Accepts `https://open.spotify.com/show/<id>?si=…`, `https://open.spotify.com/intl-he/show/<id>`,
 * `spotify:show:<id>` or a bare 22-char base62 id. Returns null for anything else.
 */
export function parseSpotifyShowId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  const uri = /^spotify:show:([A-Za-z0-9]{22})$/.exec(s);
  if (uri?.[1] !== undefined) return uri[1];
  try {
    const url = new URL(s);
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
    const m = /\/show\/([A-Za-z0-9]{22})(?:\/|$)/.exec(url.pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive(),
});

const EpisodePageSchema = z.object({
  items: z.array(z.unknown()),
  next: z.string().nullable(),
  total: z.number().optional(),
});

const EpisodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  release_date: z.string(),
  release_date_precision: z.enum(['year', 'month', 'day']).optional(),
  external_urls: z.object({ spotify: z.string().url().optional() }).optional(),
});

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export function createSpotifyLinkResolver(
  config: SpotifyLinkResolverConfig,
  ctx: IntegrationContext,
): PodcastLinkResolver {
  let token: CachedToken | null = null;

  async function getToken(): Promise<string> {
    if (token !== null && token.expiresAtMs > ctx.now()) return token.value;
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
    const res = await send(ctx, 'Spotify', SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new IntegrationAuthError('Spotify rejected the Client ID / Client Secret — re-enter them.');
    }
    if (res.status === 429) {
      throw new IntegrationRateLimitError(
        'Spotify token endpoint rate-limited.',
        retryAfterSec(res, ctx.now()),
      );
    }
    if (!res.ok)
      throw new IntegrationUnavailableError(`Spotify token request failed (HTTP ${res.status}).`, res.status);
    const body = parseEnvelope('Spotify token', TokenSchema, await readJson(res), res.status);
    // Refresh one minute early so a token never expires mid-poll.
    token = { value: body.access_token, expiresAtMs: ctx.now() + Math.max(0, body.expires_in - 60) * 1000 };
    return token.value;
  }

  async function getPage(url: string, retried = false): Promise<z.infer<typeof EpisodePageSchema>> {
    const res = await send(ctx, 'Spotify', url, {
      headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
    });
    if (res.status === 401 && !retried) {
      token = null; // revoked/expired early — get a fresh one once
      return getPage(url, true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationAuthError(
        `Spotify refused the request (HTTP ${res.status}). Check the app credentials and that the app is not restricted.`,
      );
    }
    if (res.status === 404 || res.status === 400) {
      throw new IntegrationConfigError('Spotify does not know this show id — paste the show URL again.');
    }
    if (res.status === 429) {
      throw new IntegrationRateLimitError('Spotify API rate limit reached.', retryAfterSec(res, ctx.now()));
    }
    if (!res.ok)
      throw new IntegrationUnavailableError(`Spotify API failed (HTTP ${res.status}).`, res.status);
    return parseEnvelope('Spotify episodes', EpisodePageSchema, await readJson(res), res.status);
  }

  return {
    platform: 'spotify',
    async resolve(episodes): Promise<ResolvedPodcastLinks> {
      if (episodes.length === 0) return new Map();
      const showId = parseSpotifyShowId(config.showId);
      if (showId === null) {
        throw new IntegrationConfigError('Spotify show must be a show URL (open.spotify.com/show/…) or id.');
      }
      const oldestWanted = Math.min(...episodes.map((e) => e.publishedAt.getTime())) - 3 * DAY;
      const market = config.market ?? 'IL';
      const maxPages = config.maxPages ?? 6;
      let next: string | null =
        `${SPOTIFY_API_URL}/shows/${showId}/episodes?market=${encodeURIComponent(market)}&limit=${PAGE_SIZE}&offset=0`;
      const candidates: PlatformEpisode[] = [];
      for (let page = 0; next !== null && page < maxPages; page++) {
        const body = await getPage(next);
        let oldestOnPage = Number.POSITIVE_INFINITY;
        for (const raw of body.items) {
          const ep = EpisodeSchema.safeParse(raw); // Spotify returns `null` items for unavailable episodes
          if (!ep.success) continue;
          const precision = ep.data.release_date_precision ?? 'day';
          const publishedAt = new Date(`${ep.data.release_date}${precision === 'day' ? 'T00:00:00Z' : ''}`);
          if (Number.isNaN(publishedAt.getTime())) continue;
          oldestOnPage = Math.min(oldestOnPage, publishedAt.getTime());
          const url = httpUrlOrNull(`https://open.spotify.com/episode/${encodeURIComponent(ep.data.id)}`);
          if (url === null) continue;
          candidates.push({
            url,
            title: ep.data.name,
            publishedAt,
            guid: null,
            dayPrecision: precision === 'day',
          });
        }
        // Newest first: once a page is older than every episode we need, stop paging.
        next = oldestOnPage < oldestWanted ? null : body.next;
      }
      const matched = matchEpisodes(episodes, candidates);
      return new Map([...matched].map(([key, spotify]) => [key, { spotify }]));
    },
  };
}
