import { z } from 'zod';
import { httpUrlOrNull, parseEnvelope, readJson, retryAfterSec, send } from './http.js';
import { matchEpisodes } from './podcast-links.js';
import type { PlatformEpisode } from './podcast-links.js';
import type { IntegrationContext, PodcastLinkResolver, ResolvedPodcastLinks } from './types.js';
import { IntegrationConfigError, IntegrationRateLimitError, IntegrationUnavailableError } from './types.js';

export interface AppleLinkResolverConfig {
  /** Apple Podcasts show id, e.g. "1819558192" (the number after `/id` in the show URL). */
  podcastId: string;
  /** Storefront for the lookup, default "us" (every storefront lists the show). */
  country?: string;
}

/** Free, keyless; returns at most 200 episodes (newest first). */
export const APPLE_LOOKUP_URL = 'https://itunes.apple.com/lookup';

const LookupSchema = z.object({
  resultCount: z.number(),
  results: z.array(z.unknown()),
});

const EpisodeSchema = z.object({
  wrapperType: z.literal('podcastEpisode'),
  trackName: z.string().min(1),
  trackViewUrl: z.string().url(),
  releaseDate: z.string(),
  episodeGuid: z.string().optional(),
});

/** Accepts "1819558192", "id1819558192" or any Apple Podcasts show URL. */
export function parseApplePodcastId(input: string): string | null {
  const s = input.trim();
  if (/^\d{5,15}$/.test(s)) return s;
  const m = /(?:^|[/=])id(\d{5,15})(?:\D|$)/.exec(s);
  return m?.[1] ?? null;
}

/** Drops Apple's affiliate/tracking `uo` parameter; keeps `i=<episode>`. */
function cleanAppleUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('uo');
    return u.toString();
  } catch {
    return url;
  }
}

export function createAppleLinkResolver(
  config: AppleLinkResolverConfig,
  ctx: IntegrationContext,
): PodcastLinkResolver {
  return {
    platform: 'apple',
    async resolve(episodes): Promise<ResolvedPodcastLinks> {
      if (episodes.length === 0) return new Map();
      const id = parseApplePodcastId(config.podcastId);
      if (id === null) throw new IntegrationConfigError('The Apple Podcasts id must be the numeric show id.');
      const url = new URL(APPLE_LOOKUP_URL);
      url.searchParams.set('id', id);
      url.searchParams.set('entity', 'podcastEpisode');
      url.searchParams.set('limit', '200');
      if (config.country !== undefined) url.searchParams.set('country', config.country);

      const res = await send(ctx, 'Apple Podcasts', url.toString(), {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 429 || res.status === 403) {
        throw new IntegrationRateLimitError(
          'Apple Podcasts lookup was rate-limited.',
          retryAfterSec(res, ctx.now()),
        );
      }
      if (!res.ok) {
        throw new IntegrationUnavailableError(
          `Apple Podcasts lookup failed with HTTP ${res.status}.`,
          res.status,
        );
      }
      const body = parseEnvelope('Apple Podcasts', LookupSchema, await readJson(res), res.status);
      if (body.resultCount === 0) {
        throw new IntegrationConfigError(`Apple Podcasts has no show with id ${id}.`);
      }
      const candidates: PlatformEpisode[] = [];
      for (const raw of body.results) {
        const ep = EpisodeSchema.safeParse(raw);
        if (!ep.success) continue; // the show record itself, or a malformed episode
        const publishedAt = new Date(ep.data.releaseDate);
        const link = httpUrlOrNull(ep.data.trackViewUrl);
        if (Number.isNaN(publishedAt.getTime()) || link === null) continue;
        candidates.push({
          url: cleanAppleUrl(link),
          title: ep.data.trackName,
          publishedAt,
          guid: ep.data.episodeGuid ?? null,
          dayPrecision: false,
        });
      }
      const matched = matchEpisodes(episodes, candidates);
      return new Map([...matched].map(([key, apple]) => [key, { apple }]));
    },
  };
}
