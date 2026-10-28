import type { IntegrationId } from '@fant/shared';
import { cleanupJob, deadlineRemindersJob, gameweekSummaryJob } from './fpl.js';
import { podcastJob } from './podcast.js';
import { instagramPostsJob, instagramStoriesJob, xJob } from './social.js';
import type { Job, JobName } from './types.js';
import { youtubeJob } from './youtube.js';

/** The job registry (run in this order by a tick). */
export const JOBS: readonly Job[] = [
  podcastJob,
  // Right after podcast: episodes (and their YouTube links) are fresh when uploads are matched against them.
  youtubeJob,
  instagramStoriesJob,
  instagramPostsJob,
  xJob,
  deadlineRemindersJob,
  gameweekSummaryJob,
  cleanupJob,
];

/** Which jobs "sync now" runs for an integration. */
export const SYNC_JOBS: Readonly<Record<IntegrationId, readonly JobName[]>> = {
  podcast_rss: ['podcast'],
  apple: ['podcast'],
  spotify: ['podcast'],
  instagram: ['instagram_posts', 'instagram_stories'],
  x: ['x'],
  // The YouTube link on episodes comes from the podcast job's resolver.
  youtube: ['podcast', 'youtube'],
};
