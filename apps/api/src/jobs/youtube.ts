import {
  isEpisodeVideo,
  youTubeVideoRefFromDraft,
  type ContentSource,
  type YouTubeEpisodeRef,
} from '@fant/integrations';
import { PodcastMetaSchema } from '@fant/shared';
import type { AppContext } from '../context.js';
import { loadIntegration } from '../integrations/store.js';
import { readLinks } from '../news/serialize.js';
import { runContentSource, runSummary } from './content.js';
import { MINUTE, type Job } from './types.js';

/** Podcast episodes compared against YouTube uploads (the feed only lists the newest 15 uploads). */
export const YOUTUBE_EPISODE_WINDOW = 40;
/** Job-state key: publishedAt (ms) of the oldest upload in the channel's current feed (read by the podcast relink). */
export const FEED_OLDEST_STATE_KEY = 'feedOldestAt';
/** isEpisodeVideo / the link resolver match an episode and its video up to 7 days apart. */
export const YOUTUBE_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PODCAST_PREFIX = 'podcast:';

/** Recent podcast episodes as matching refs, with the YouTube link each already carries. */
export async function recentEpisodeRefs(app: AppContext): Promise<YouTubeEpisodeRef[]> {
  const rows = await app.prisma.newsItem.findMany({
    where: { source: 'podcast', dedupeKey: { startsWith: PODCAST_PREFIX } },
    orderBy: { publishedAt: 'desc' },
    take: YOUTUBE_EPISODE_WINDOW,
  });
  return rows.flatMap((row) => {
    if (row.title === null) return [];
    const meta = PodcastMetaSchema.safeParse(row.podcast);
    return [
      {
        dedupeKey: row.dedupeKey,
        guid: row.dedupeKey.slice(PODCAST_PREFIX.length),
        title: row.title,
        publishedAt: row.publishedAt,
        episodeNumber: meta.success ? meta.data.episodeNumber : null,
        youtube: readLinks(row.links).youtube ?? null,
      },
    ];
  });
}

/** Drops full-episode videos: they appear as the episode's "Watch on YouTube" link, not as their own item. */
function withoutEpisodeVideos(
  inner: ContentSource,
  episodes: readonly YouTubeEpisodeRef[],
): { source: ContentSource; skippedEpisodes: () => number; oldestAt: () => number | null } {
  let skipped = 0;
  let oldest: number | null = null;
  return {
    skippedEpisodes: () => skipped,
    oldestAt: () => oldest,
    source: {
      source: inner.source,
      async fetchLatest(cursor) {
        const result = await inner.fetchLatest(cursor);
        for (const draft of result.items) {
          const at = draft.publishedAt.getTime();
          if (oldest === null || at < oldest) oldest = at;
        }
        const items = result.items.filter((draft) => {
          const ref = youTubeVideoRefFromDraft(draft);
          const episode = ref !== null && isEpisodeVideo(ref, episodes);
          if (episode) skipped += 1;
          return !episode;
        });
        return { ...result, items };
      },
    },
  };
}

/**
 * A `youtube_video` imported before its episode was linked (or matched): hidden for good once it is an
 * episode's video. Uses the dedupe-placeholder flag (`suppressed`: never listed among hidden items, never
 * restorable) so the next poll's upsert stays a no-op instead of re-creating it.
 */
export async function hideEpisodeVideos(app: AppContext, episodes: readonly YouTubeEpisodeRef[]) {
  const videos = await app.prisma.newsItem.findMany({
    where: { source: 'youtube_video', suppressed: false },
    orderBy: { publishedAt: 'desc' },
    take: 50,
  });
  let hidden = 0;
  for (const v of videos) {
    const ref = youTubeVideoRefFromDraft({
      dedupeKey: v.dedupeKey,
      source: 'youtube_video',
      title: v.title,
      text: v.text,
      media: [],
      links: readLinks(v.links),
      podcast: null,
      publishedAt: v.publishedAt,
      expiresAt: null,
    });
    if (ref === null || !isEpisodeVideo(ref, episodes)) continue;
    await app.prisma.newsItem.update({
      where: { id: v.id },
      data: { hiddenAt: v.hiddenAt ?? app.clock.now(), suppressed: true },
    });
    hidden += 1;
  }
  return hidden;
}

export const youtubeJob: Job = {
  name: 'youtube',
  everyMs: 10 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const yt = await loadIntegration(app.prisma, app.config.secretsKey, 'youtube');
    if (!yt.active) return { summary: 'youtube disabled or not configured' };
    const episodes = await recentEpisodeRefs(app);
    const filtered = withoutEpisodeVideos(
      app.integrations.createYouTubeSource({ channelId: yt.settings['channelId'] ?? '' }, app.integrationCtx),
      episodes,
    );
    // Thumbnails are re-hosted (served from our media CDN, not i.ytimg.com).
    const result = await runContentSource(ctx, yt, filtered.source, { rehost: true, stateKey: 'synced' });
    const hidden = await hideEpisodeVideos(app, episodes);
    const state = { ...result.state };
    const oldest = filtered.oldestAt();
    if (oldest !== null) state[FEED_OLDEST_STATE_KEY] = oldest; // unchanged feed (304) → keep the last value
    return {
      summary: `${runSummary(result)}, ${filtered.skippedEpisodes()} episode videos skipped, ${hidden} hidden`,
      state,
    };
  },
};
