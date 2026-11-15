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
import { planContentPoll, runContentSource, runSummary, type ContentCarry } from './content.js';
import {
  fillEpisodeThumbnails,
  THUMBNAIL_BATCH,
  THUMBNAIL_RECHECK_MS,
  THUMBNAIL_RECHECK_WINDOW_MS,
  thumbnailSummary,
  type ThumbnailRunResult,
} from './episodeThumbnails.js';
import {
  FEED_OLDEST_STATE_KEY,
  hideEpisodeVideos,
  recentEpisodeRefs,
  YOUTUBE_MATCH_WINDOW_MS,
} from './youtube.js';
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

interface RecentEpisode {
  id: string;
  dedupeKey: string;
  title: string | null;
  publishedAt: Date;
  links: Prisma.JsonValue;
  podcast: Prisma.JsonValue;
}

/** Memo (in memory, refreshed by every database run): what the DB-free checks between runs compare against. */
interface PodcastMemo {
  recent: { items: RecentEpisode[]; youtubeFrom: Date | null };
  /** Audio-only / failed episodes whose Spotify thumbnail is re-checked hourly (oEmbed, no DB). */
  thumbs: { more: boolean; rechecks: { id: string; spotifyUrl: string; checkedAt: number }[] };
}
const MEMO_KEY = 'podcast';

function readMemo(memo: Record<string, unknown>): PodcastMemo | null {
  const value = memo[MEMO_KEY];
  return typeof value === 'object' && value !== null ? (value as PodcastMemo) : null;
}

/** What the plan hands to the run: the feed it fetched (with its tracked resolvers) and relink results. */
interface PodcastCarry {
  podcast: true;
  content: ContentCarry;
  feedResolvers: TrackedResolver[];
  relink: { links: ResolvedPodcastLinks; resolvers: TrackedResolver[] } | null;
}

function isPodcastCarry(value: unknown): value is PodcastCarry {
  return typeof value === 'object' && value !== null && 'podcast' in value && 'content' in value;
}

async function recentEpisodes(app: AppContext): Promise<RecentEpisode[]> {
  return app.prisma.newsItem.findMany({
    where: { source: 'podcast', dedupeKey: { startsWith: PODCAST_PREFIX } },
    orderBy: { publishedAt: 'desc' },
    take: RELINK_RECENT_EPISODES,
    select: { id: true, dedupeKey: true, title: true, publishedAt: true, links: true, podcast: true },
  });
}

/** The links an episode would carry after applying `found` (never overwrites a known link). */
function mergedLinks(
  current: ReturnType<typeof readLinks>,
  f: ResolvedPodcastLinks extends Map<string, infer V> ? V : never,
) {
  const youtube = current.youtube ?? f.youtube ?? null;
  return {
    ...current,
    spotify: current.spotify ?? f.spotify ?? null,
    apple: current.apple ?? f.apple ?? null,
    ...(youtube === null ? {} : { youtube }),
  };
}

function linksChange(
  item: { dedupeKey: string; links: Prisma.JsonValue },
  found: ResolvedPodcastLinks,
): boolean {
  const f = found.get(item.dedupeKey);
  if (f === undefined) return false;
  const current = readLinks(item.links);
  const next = mergedLinks(current, f);
  return !(
    next.spotify === current.spotify &&
    next.apple === current.apple &&
    (next.youtube ?? null) === (current.youtube ?? null)
  );
}

/**
 * Asks the resolvers about recent episodes still missing a link. Per platform: only resolvers with an episode
 * actually missing their link are called (episodes 1–55 will never be in YouTube's 15-upload feed, which must not
 * make every relink call Spotify and Apple too). No database access: `recent` comes from the DB or the memo.
 */
async function resolveMissing(
  app: AppContext,
  recent: readonly RecentEpisode[],
  youtubeFrom: Date | null,
  resolvers: readonly TrackedResolver[],
): Promise<{ missing: RecentEpisode[]; links: ResolvedPodcastLinks; called: TrackedResolver[] }> {
  const missingFor = (item: RecentEpisode, platform: PodcastLinkPlatform): boolean => {
    const links = readLinks(item.links);
    if (platform === 'apple') return links.apple === null;
    if (platform === 'spotify') return links.spotify === null;
    return (links.youtube ?? null) === null && (youtubeFrom === null || item.publishedAt >= youtubeFrom);
  };
  const active = resolvers.filter((r) => recent.some((item) => missingFor(item, r.resolver.platform)));
  if (active.length === 0) return { missing: [], links: new Map(), called: [] };
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
  return { missing, links, called: active };
}

/** Fills missing Spotify/Apple links on the most recent episodes (never overwrites a known link). */
async function relinkRecent(ctx: JobRunContext, resolvers: readonly TrackedResolver[]): Promise<number> {
  const { app } = ctx;
  const recent = await recentEpisodes(app);
  const { missing, links } = await resolveMissing(app, recent, await youtubeMatchableFrom(app), resolvers);
  return applyLinks(app, missing, links);
}

/**
 * Episodes published before this can't match anything in YouTube's current feed: the oldest upload the youtube
 * job saw in it (its job state), minus the 7-day match window (a video can go up days after the audio).
 * null = not known yet (no skipping).
 */
async function youtubeMatchableFrom(app: AppContext): Promise<Date | null> {
  const lease = await app.prisma.jobLease.findUnique({ where: { name: 'youtube' } });
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
    if (f === undefined || !linksChange(item, found)) continue;
    await app.prisma.newsItem.update({
      where: { id: item.id },
      data: { links: mergedLinks(readLinks(item.links), f) },
    });
    changed += 1;
  }
  return changed;
}

/** Re-reads what the DB-free checks need until the next database run. */
async function refreshMemo(
  app: AppContext,
  memo: Record<string, unknown>,
  thumbs: ThumbnailRunResult | null,
) {
  const now = app.clock.now();
  const recentAfter = new Date(now.getTime() - THUMBNAIL_RECHECK_WINDOW_MS);
  const [items, youtubeFrom, rechecks] = await Promise.all([
    recentEpisodes(app),
    youtubeMatchableFrom(app),
    app.prisma.newsItem.findMany({
      where: {
        source: 'podcast',
        OR: [{ thumbnailStatus: 'error' }, { thumbnailStatus: 'none', publishedAt: { gte: recentAfter } }],
      },
      select: { id: true, links: true, thumbnailCheckedAt: true },
      orderBy: { publishedAt: 'desc' },
      take: THUMBNAIL_BATCH,
    }),
  ]);
  const value: PodcastMemo = {
    recent: { items, youtubeFrom },
    thumbs: {
      more: thumbs !== null && thumbs.checked >= THUMBNAIL_BATCH,
      rechecks: rechecks.flatMap((r) => {
        const spotifyUrl = readLinks(r.links).spotify;
        return spotifyUrl === null
          ? []
          : [{ id: r.id, spotifyUrl, checkedAt: r.thumbnailCheckedAt?.getTime() ?? 0 }];
      }),
    },
  };
  memo[MEMO_KEY] = value;
}

/** Thumbnails due between database runs: a recheck answering with a thumbnail (or more backlog) needs the DB. */
async function thumbnailsNeedRun(app: AppContext, memo: PodcastMemo, nowMs: number): Promise<boolean> {
  if (memo.thumbs.more) return true;
  for (const r of memo.thumbs.rechecks) {
    if (nowMs - r.checkedAt < THUMBNAIL_RECHECK_MS) continue;
    try {
      if ((await app.integrations.fetchSpotifyEpisodeThumbnail(r.spotifyUrl, app.integrationCtx)) !== null) {
        return true;
      }
    } catch {
      // Same as a failed check in the run: retried in an hour.
    }
    r.checkedAt = nowMs;
  }
  return false;
}

const lastRelinkOf = (state: Readonly<Record<string, unknown>>, memo: Record<string, unknown>) =>
  Math.max(
    typeof state['lastRelinkAt'] === 'number' ? state['lastRelinkAt'] : 0,
    typeof memo['lastRelinkAt'] === 'number' ? memo['lastRelinkAt'] : 0,
  );

export const podcastJob: Job = {
  name: 'podcast',
  everyMs: 5 * MINUTE,
  /**
   * DB-free between changes: the RSS (conditional GET) is compared with the last save, the 30-minute relink asks
   * Spotify/Apple/YouTube about the episodes in memory, and audio-only episodes' thumbnails are re-checked via
   * oEmbed. The database is used only when one of them found something to write.
   */
  async plan(ctx) {
    const { app } = ctx;
    const [rss, apple, spotify, youtube] = await Promise.all([
      ctx.integration('podcast_rss'),
      ctx.integration('apple'),
      ctx.integration('spotify'),
      ctx.integration('youtube'),
    ]);
    if (!rss.active) return { run: false, summary: 'podcast RSS disabled or not configured' };
    const feedResolvers = buildResolvers(app, apple, spotify, youtube);
    const source = app.integrations.createPodcastSource(
      { rssUrl: rss.settings['rssUrl'] ?? '', resolvers: feedResolvers.map((r) => r.resolver) },
      app.integrationCtx,
    );
    const poll = await planContentPoll(ctx, rss, source, { rehost: false, stateKey: 'synced' });
    const carry: PodcastCarry = { podcast: true, content: poll.carry, feedResolvers, relink: null };
    if (poll.changed) return { run: true, reason: poll.reason, carry };
    const memo = readMemo(ctx.memo);
    if (memo === null) return { run: true, reason: 'first check since start', carry };

    const nowMs = ctx.now.getTime();
    if (nowMs - lastRelinkOf(ctx.state, ctx.memo) >= RELINK_EVERY_MS) {
      const resolvers = buildResolvers(app, apple, spotify, youtube);
      const { missing, links, called } = await resolveMissing(
        app,
        memo.recent.items,
        memo.recent.youtubeFrom,
        resolvers,
      );
      const rows = { apple, spotify, youtube };
      const newError = called.some(
        (r) =>
          r.outcome.error !== null && (r.id === 'youtube' || r.outcome.error !== rows[r.id].row.lastError),
      );
      const recovered = called.some(
        (r) => r.id !== 'youtube' && r.outcome.error === null && rows[r.id].row.lastError !== null,
      );
      if (missing.some((item) => linksChange(item, links)) || newError || recovered) {
        return {
          run: true,
          reason: 'relink found links',
          carry: { ...carry, relink: { links, resolvers: called } },
        };
      }
      for (const r of called) if (r.id !== 'youtube') ctx.checked(r.id, { ok: true, error: null });
      ctx.memo['lastRelinkAt'] = nowMs;
    }
    if (await thumbnailsNeedRun(app, memo, nowMs)) return { run: true, reason: 'thumbnails due', carry };
    return { run: false, summary: poll.reason };
  },
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

    const carry = isPodcastCarry(ctx.carry) ? ctx.carry : null;
    // The plan's tracked resolvers carry the outcome of the lookups its feed fetch made.
    const feedResolvers = carry?.feedResolvers ?? buildResolvers(app, apple, spotify, youtube);
    const source = app.integrations.createPodcastSource(
      { rssUrl: rss.settings['rssUrl'] ?? '', resolvers: feedResolvers.map((r) => r.resolver) },
      app.integrationCtx,
    );
    const result = await runContentSource({ ...ctx, carry: carry?.content }, rss, source, {
      rehost: false,
      stateKey: 'synced',
    });
    await recordResolvers(app, feedResolvers);
    const state = result.state;

    // The feed just resolved every episode when it changed; otherwise re-check recent ones periodically.
    const nowMs = ctx.now.getTime();
    const lastRelink = lastRelinkOf(ctx.state, ctx.memo);
    const feedResolved = result.ok && result.fetched?.notModified === false && feedResolvers.length > 0;
    let relinked = 0;
    if (feedResolved) {
      state['lastRelinkAt'] = nowMs;
    } else if (result.ok && carry !== null && carry.relink !== null) {
      // The plan already asked the resolvers: apply what it found to the episodes as stored now.
      const recent = await recentEpisodes(app);
      relinked = await applyLinks(app, recent, carry.relink.links);
      await recordResolvers(app, carry.relink.resolvers);
      state['lastRelinkAt'] = nowMs;
    } else if (result.ok && (ctx.force || nowMs - lastRelink >= RELINK_EVERY_MS)) {
      const relinkResolvers = buildResolvers(app, apple, spotify, youtube);
      if (relinkResolvers.length > 0) {
        relinked = await relinkRecent(ctx, relinkResolvers);
        await recordResolvers(app, relinkResolvers);
      }
      state['lastRelinkAt'] = nowMs;
    } else if (lastRelink > 0) {
      state['lastRelinkAt'] = lastRelink;
    }
    // A new or newly linked episode can make an already imported YouTube upload its video: hide that one now
    // (the youtube job only runs when its own feed changes).
    const ingest = result.ingest;
    if (relinked > 0 || (ingest !== null && ingest.created.length + ingest.updated > 0)) {
      await hideEpisodeVideos(app, await recentEpisodeRefs(app));
    }
    // Per-episode Spotify thumbnails: best-effort, after the feed; never fails the run or the Spotify status.
    let thumbs: string;
    let thumbResult: ThumbnailRunResult | null = null;
    try {
      thumbResult = await fillEpisodeThumbnails(app, ctx.now);
      thumbs = thumbnailSummary(thumbResult);
    } catch (err) {
      thumbs = `thumbnails: skipped (${err instanceof Error ? err.message : String(err)})`;
    }
    await refreshMemo(app, ctx.memo, thumbResult);
    ctx.memo['lastRelinkAt'] = state['lastRelinkAt'];
    return { summary: `${runSummary(result)}, ${relinked} relinked, ${thumbs}`, state };
  },
};
