import type {
  EpisodeRef,
  PodcastLinkPlatform,
  PodcastLinkResolver,
  ResolvedPodcastLinks,
} from '@fant/integrations';
import { PodcastMetaSchema, type IntegrationId } from '@fant/shared';
import { Prisma } from '@prisma/client';
import type { AppContext } from '../context.js';
import {
  describeIntegrationError,
  loadIntegration,
  recordIntegrationRun,
  type LoadedIntegration,
} from '../integrations/store.js';
import { readLinks } from '../news/serialize.js';
import { runContentSource, runSummary } from './content.js';
import { fillEpisodeThumbnails, thumbnailSummary } from './episodeThumbnails.js';
import { FEED_OLDEST_STATE_KEY, YOUTUBE_MATCH_WINDOW_MS } from './youtube.js';
import { MINUTE, type Job, type JobRunContext } from './types.js';

/** Spotify/Apple list an episode later than the RSS: re-resolve recent episodes missing a link. */
export const RELINK_EVERY_MS = 30 * MINUTE;
export const RELINK_RECENT_EPISODES = 15;

const PODCAST_PREFIX = 'podcast:';

interface TrackedResolver {
  id: Extract<IntegrationId, 'apple' | 'spotify' | 'youtube'>;
  resolver: PodcastLinkResolver;
  outcome: { called: boolean; error: string | null };
}

function track(id: TrackedResolver['id'], inner: PodcastLinkResolver): TrackedResolver {
  const tracked: TrackedResolver = { id, resolver: inner, outcome: { called: false, error: null } };
  tracked.resolver = {
    platform: inner.platform,
    async resolve(episodes) {
      tracked.outcome.called = true;
      try {
        const found = await inner.resolve(episodes);
        tracked.outcome.error = null;
        return found;
      } catch (err) {
        tracked.outcome.error = describeIntegrationError(id, err);
        throw err;
      }
    },
  };
  return tracked;
}

function buildResolvers(
  app: AppContext,
  apple: LoadedIntegration,
  spotify: LoadedIntegration,
  youtube: LoadedIntegration,
): TrackedResolver[] {
  const out: TrackedResolver[] = [];
  if (apple.active) {
    out.push(
      track(
        'apple',
        app.integrations.createAppleLinkResolver(
          { podcastId: apple.settings['podcastId'] ?? '' },
          app.integrationCtx,
        ),
      ),
    );
  }
  if (spotify.active) {
    out.push(
      track(
        'spotify',
        app.integrations.createSpotifyLinkResolver(
          {
            showId: spotify.settings['showId'] ?? '',
            clientId: spotify.secrets['clientId'] ?? '',
            clientSecret: spotify.secrets['clientSecret'] ?? '',
          },
          app.integrationCtx,
        ),
      ),
    );
  }
  if (youtube.active) {
    out.push(
      track(
        'youtube',
        app.integrations.createYouTubeLinkResolver(
          { channelId: youtube.settings['channelId'] ?? '' },
          app.integrationCtx,
        ),
      ),
    );
  }
  return out;
}

/** Status rows of Apple/Spotify: last outcome + how many episodes carry their link. */
async function recordResolvers(app: AppContext, resolvers: readonly TrackedResolver[]): Promise<void> {
  for (const r of resolvers) {
    if (!r.outcome.called) continue;
    if (r.id === 'youtube') {
      // YouTube's row also carries its own job's status (imported Shorts/videos): only a failed link lookup
      // is recorded here; a success is reported by the youtube job itself.
      if (r.outcome.error !== null) {
        await recordIntegrationRun(app.prisma, 'youtube', app.clock.now(), {
          ok: false,
          error: r.outcome.error,
        });
      }
      continue;
    }
    const linkKey = r.id === 'apple' ? 'apple' : 'spotify';
    const rows = await app.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM "NewsItem"
      WHERE "source" = 'podcast' AND ("links" ->> ${linkKey}) IS NOT NULL`);
    const now = app.clock.now();
    await recordIntegrationRun(app.prisma, r.id, now, {
      ok: r.outcome.error === null,
      error: r.outcome.error,
    });
    await app.prisma.integrationConfig.updateMany({
      where: { id: r.id },
      data: { itemsImported: Number(rows[0]?.n ?? 0) },
    });
  }
}

/** Fills missing Spotify/Apple links on the most recent episodes (never overwrites a known link). */
async function relinkRecent(ctx: JobRunContext, resolvers: readonly TrackedResolver[]): Promise<number> {
  const { app } = ctx;
  const recent = await app.prisma.newsItem.findMany({
    where: { source: 'podcast', dedupeKey: { startsWith: PODCAST_PREFIX } },
    orderBy: { publishedAt: 'desc' },
    take: RELINK_RECENT_EPISODES,
  });
  // Per platform: only resolvers with an episode actually missing their link are called (episodes 1–55 will
  // never be in YouTube's 15-upload feed, which must not make every relink call Spotify and Apple too).
  const youtubeFrom = await youtubeMatchableFrom(ctx);
  const missingFor = (item: (typeof recent)[number], platform: PodcastLinkPlatform): boolean => {
    const links = readLinks(item.links);
    if (platform === 'apple') return links.apple === null;
    if (platform === 'spotify') return links.spotify === null;
    return (links.youtube ?? null) === null && (youtubeFrom === null || item.publishedAt >= youtubeFrom);
  };
  const active = resolvers.filter((r) => recent.some((item) => missingFor(item, r.resolver.platform)));
  if (active.length === 0) return 0;
  const missing = recent.filter((item) => active.some((r) => missingFor(item, r.resolver.platform)));

  // Every recent episode is passed (not only the missing ones) so date-only matching can see rivals.
  const refs: EpisodeRef[] = recent.flatMap((item) => {
    if (item.title === null) return [];
    const meta = PodcastMetaSchema.safeParse(item.podcast);
    return [
      {
        dedupeKey: item.dedupeKey,
        guid: item.dedupeKey.slice(PODCAST_PREFIX.length),
        title: item.title,
        publishedAt: item.publishedAt,
        episodeNumber: meta.success ? meta.data.episodeNumber : null,
      },
    ];
  });
  const { links } = await app.integrations.resolveEpisodeLinks(
    refs,
    active.map((r) => r.resolver),
  );
  return applyLinks(app, missing, links);
}

/**
 * Episodes published before this can't match anything in YouTube's current feed: the oldest upload the youtube
 * job saw in it (its job state), minus the 7-day match window (a video can go up days after the audio).
 * null = not known yet (no skipping).
 */
async function youtubeMatchableFrom(ctx: JobRunContext): Promise<Date | null> {
  const lease = await ctx.app.prisma.jobLease.findUnique({ where: { name: 'youtube' } });
  const state = lease?.state;
  const oldest =
    state !== null && typeof state === 'object' && !Array.isArray(state)
      ? state[FEED_OLDEST_STATE_KEY]
      : undefined;
  if (typeof oldest !== 'number' || !Number.isFinite(oldest)) return null;
  return new Date(oldest - YOUTUBE_MATCH_WINDOW_MS);
}

async function applyLinks(
  app: AppContext,
  items: readonly { id: string; dedupeKey: string; links: Prisma.JsonValue }[],
  found: ResolvedPodcastLinks,
): Promise<number> {
  let changed = 0;
  for (const item of items) {
    const f = found.get(item.dedupeKey);
    if (f === undefined) continue;
    const current = readLinks(item.links);
    // Never overwrites a known link.
    const youtube = current.youtube ?? f.youtube ?? null;
    const next = {
      ...current,
      spotify: current.spotify ?? f.spotify ?? null,
      apple: current.apple ?? f.apple ?? null,
      ...(youtube === null ? {} : { youtube }),
    };
    if (
      next.spotify === current.spotify &&
      next.apple === current.apple &&
      (next.youtube ?? null) === (current.youtube ?? null)
    ) {
      continue;
    }
    await app.prisma.newsItem.update({ where: { id: item.id }, data: { links: next } });
    changed += 1;
  }
  return changed;
}

export const podcastJob: Job = {
  name: 'podcast',
  everyMs: 5 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const key = app.config.secretsKey;
    const [rss, apple, spotify, youtube] = await Promise.all([
      loadIntegration(app.prisma, key, 'podcast_rss'),
      loadIntegration(app.prisma, key, 'apple'),
      loadIntegration(app.prisma, key, 'spotify'),
      loadIntegration(app.prisma, key, 'youtube'),
    ]);
    if (!rss.active) return { summary: 'podcast RSS disabled or not configured' };

    const feedResolvers = buildResolvers(app, apple, spotify, youtube);
    const source = app.integrations.createPodcastSource(
      { rssUrl: rss.settings['rssUrl'] ?? '', resolvers: feedResolvers.map((r) => r.resolver) },
      app.integrationCtx,
    );
    const result = await runContentSource(ctx, rss, source, { rehost: false, stateKey: 'synced' });
    await recordResolvers(app, feedResolvers);
    const state = result.state;

    // The feed just resolved every episode when it changed; otherwise re-check recent ones periodically.
    const nowMs = ctx.now.getTime();
    const lastRelink = typeof state['lastRelinkAt'] === 'number' ? state['lastRelinkAt'] : 0;
    const feedResolved = result.ok && result.fetched?.notModified === false && feedResolvers.length > 0;
    let relinked = 0;
    if (feedResolved) {
      state['lastRelinkAt'] = nowMs;
    } else if (result.ok && (ctx.force || nowMs - lastRelink >= RELINK_EVERY_MS)) {
      const relinkResolvers = buildResolvers(app, apple, spotify, youtube);
      if (relinkResolvers.length > 0) {
        relinked = await relinkRecent(ctx, relinkResolvers);
        await recordResolvers(app, relinkResolvers);
      }
      state['lastRelinkAt'] = nowMs;
    }
    // Per-episode Spotify thumbnails: best-effort, after the feed; never fails the run or the Spotify status.
    let thumbs: string;
    try {
      thumbs = thumbnailSummary(await fillEpisodeThumbnails(app, ctx.now));
    } catch (err) {
      thumbs = `thumbnails: skipped (${err instanceof Error ? err.message : String(err)})`;
    }
    return { summary: `${runSummary(result)}, ${relinked} relinked, ${thumbs}`, state };
  },
};
