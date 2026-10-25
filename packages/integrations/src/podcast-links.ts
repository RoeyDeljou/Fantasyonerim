import { episodeRefFromDraft, fetchPodcastFeed } from './podcast-rss.js';
import type { PodcastRssConfig } from './podcast-rss.js';
import { describeError } from './http.js';
import { episodeNumberFromTitle, titleKeys } from './text.js';
import type {
  ContentSource,
  EpisodeRef,
  IntegrationContext,
  NewsItemDraft,
  PodcastLinkResolver,
  ResolvedPodcastLinks,
} from './types.js';

/**
 * Returns new drafts with the resolved Spotify/Apple links filled in (existing non-null links are kept;
 * a resolved link never overwrites a different one already present). Pure — inputs are not mutated.
 */
export function mergePodcastLinks(
  drafts: readonly NewsItemDraft[],
  resolved: ResolvedPodcastLinks,
): NewsItemDraft[] {
  return drafts.map((draft) => {
    const found = resolved.get(draft.dedupeKey);
    if (found === undefined) return draft;
    return {
      ...draft,
      links: {
        ...draft.links,
        spotify: draft.links.spotify ?? found.spotify ?? null,
        apple: draft.links.apple ?? found.apple ?? null,
      },
    };
  });
}

/** Combines several resolvers' maps into one. */
export function combineResolvedLinks(maps: readonly ResolvedPodcastLinks[]): ResolvedPodcastLinks {
  const out: ResolvedPodcastLinks = new Map();
  for (const map of maps) {
    for (const [key, links] of map) out.set(key, { ...out.get(key), ...links });
  }
  return out;
}

/** A platform episode, reduced to what matching needs. */
export interface PlatformEpisode {
  url: string;
  title: string;
  /** Exact time when known (Apple), else the release day at 00:00 UTC (Spotify). */
  publishedAt: Date;
  /** RSS GUID when the platform exposes it (Apple's `episodeGuid`). */
  guid: string | null;
  /** True when `publishedAt` is only day-precise. */
  dayPrecision: boolean;
}

const HOUR = 3_600_000;

/**
 * Matches RSS episodes to platform episodes, most reliable signal first:
 *   1. GUID (Apple exposes the RSS guid);
 *   2. normalized title (full, then with the "פרק NN -" prefix stripped), unique on the platform side;
 *   3. episode number (RSS itunes:episode vs. number written in the platform title) + date within 48 h;
 *   4. date alone, only when it is unambiguous: exactly one unmatched platform episode within 12 h of the
 *      RSS episode, and that RSS episode is the only unmatched one within 12 h of it. Platform episodes
 *      that carry a GUID (Apple) or a different episode number in their title never match on date.
 * Pass every recent episode (not just the unresolved one) so tier 4 can see its rivals.
 * Each platform episode is used at most once.
 */
export function matchEpisodes(
  refs: readonly EpisodeRef[],
  candidates: readonly PlatformEpisode[],
  maxDateDistanceMs = 48 * HOUR,
): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<PlatformEpisode>();
  const take = (ref: EpisodeRef, ep: PlatformEpisode): void => {
    result.set(ref.dedupeKey, ep.url);
    used.add(ep);
  };

  const byGuid = new Map<string, PlatformEpisode>();
  for (const ep of candidates) if (ep.guid !== null) byGuid.set(ep.guid, ep);
  for (const ref of refs) {
    const ep = byGuid.get(ref.guid);
    if (ep !== undefined && !used.has(ep)) take(ref, ep);
  }

  for (const keyIndex of [0, 1]) {
    const byTitle = new Map<string, PlatformEpisode[]>();
    for (const ep of candidates) {
      if (used.has(ep)) continue;
      const key = titleKeys(ep.title)[keyIndex] ?? titleKeys(ep.title)[0];
      if (key === undefined || key === '') continue;
      byTitle.set(key, [...(byTitle.get(key) ?? []), ep]);
    }
    for (const ref of refs) {
      if (result.has(ref.dedupeKey)) continue;
      const key = titleKeys(ref.title)[keyIndex] ?? titleKeys(ref.title)[0];
      if (key === undefined || key === '') continue;
      const options = (byTitle.get(key) ?? []).filter((ep) => !used.has(ep));
      // Same title twice (e.g. "Trailer"): take the one closest in time.
      const best = closest(options, ref.publishedAt);
      if (best !== undefined) take(ref, best);
    }
  }

  for (const ref of refs) {
    if (result.has(ref.dedupeKey) || ref.episodeNumber === null) continue;
    const options = candidates.filter(
      (ep) =>
        !used.has(ep) &&
        episodeNumberFromTitle(ep.title) === ref.episodeNumber &&
        distance(ep, ref.publishedAt) <= maxDateDistanceMs,
    );
    const best = closest(options, ref.publishedAt);
    if (best !== undefined) take(ref, best);
  }

  const dateWindow = 12 * HOUR;
  const unmatchedRefs = refs.filter((r) => !result.has(r.dedupeKey));
  for (const ref of unmatchedRefs) {
    const options = candidates.filter((ep) => {
      if (used.has(ep) || ep.guid !== null || distance(ep, ref.publishedAt) > dateWindow) return false;
      const n = episodeNumberFromTitle(ep.title);
      return n === null || ref.episodeNumber === null || n === ref.episodeNumber;
    });
    const only = options[0];
    if (options.length !== 1 || only === undefined) continue;
    const rivals = unmatchedRefs.filter(
      (r) => !result.has(r.dedupeKey) && distance(only, r.publishedAt) <= dateWindow,
    );
    if (rivals.length === 1) take(ref, only);
  }
  return result;
}

function distance(ep: PlatformEpisode, at: Date): number {
  const t = ep.publishedAt.getTime();
  const target = at.getTime();
  // A release *day* covers [00:00, 24:00) UTC; and Spotify days can be local (Israel = UTC+2/3).
  if (ep.dayPrecision) {
    if (target >= t && target < t + 24 * HOUR) return 0;
    return Math.min(Math.abs(target - t), Math.abs(target - (t + 24 * HOUR)));
  }
  return Math.abs(target - t);
}

function closest(options: readonly PlatformEpisode[], at: Date): PlatformEpisode | undefined {
  let best: PlatformEpisode | undefined;
  for (const ep of options) if (best === undefined || distance(ep, at) < distance(best, at)) best = ep;
  return best;
}

export interface PodcastSourceConfig extends PodcastRssConfig {
  /** Spotify / Apple resolvers that are configured; each one failing only adds a warning. */
  resolvers: readonly PodcastLinkResolver[];
}

/**
 * The podcast ContentSource apps/api should poll: RSS (conditional GET) + every configured link
 * resolver, merged into one item per episode. A resolver failure never fails the poll — it becomes a
 * warning and the episode is published with the links that are known.
 *
 * Spotify/Apple often list an episode minutes–hours after the RSS. When the RSS answers 304 nothing is
 * re-resolved here, so apps/api should also call `resolveEpisodeLinks` for recent episodes that are
 * still missing a link (e.g. published in the last 3 days).
 */
export function createPodcastSource(config: PodcastSourceConfig, ctx: IntegrationContext): ContentSource {
  return {
    source: 'podcast',
    async fetchLatest(cursor) {
      const feed = await fetchPodcastFeed({ rssUrl: config.rssUrl, cursor }, ctx);
      if (feed.notModified || feed.items.length === 0) return feed;
      const refs = feed.items.map(episodeRefFromDraft).filter((r): r is EpisodeRef => r !== null);
      const { links, warnings } = await resolveEpisodeLinks(refs, config.resolvers);
      return {
        ...feed,
        items: mergePodcastLinks(feed.items, links),
        warnings: [...feed.warnings, ...warnings],
      };
    },
  };
}

/** Runs every resolver independently (in parallel); failures are returned as warnings, never thrown. */
export async function resolveEpisodeLinks(
  refs: readonly EpisodeRef[],
  resolvers: readonly PodcastLinkResolver[],
): Promise<{ links: ResolvedPodcastLinks; warnings: string[] }> {
  if (refs.length === 0 || resolvers.length === 0) return { links: new Map(), warnings: [] };
  const settled = await Promise.allSettled(resolvers.map((r) => r.resolve(refs)));
  const maps: ResolvedPodcastLinks[] = [];
  const warnings: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') maps.push(s.value);
    else warnings.push(`${resolvers[i]?.platform ?? 'link'} lookup failed: ${describeError(s.reason)}`);
  });
  return { links: combineResolvedLinks(maps), warnings };
}
