import { xOptions } from '../integrations/config.js';
import type { ContentSource } from '@fant/integrations';
import type { AppContext } from '../context.js';
import { loadIntegration, describeIntegrationError, type LoadedIntegration } from '../integrations/store.js';
import { planContentPoll, runContentSource, runSummary } from './content.js';
import { HOUR, MINUTE, type Job, type JobPlan, type JobPlanContext } from './types.js';

function instagramConfig(ig: LoadedIntegration) {
  return {
    igUserId: ig.settings['igUserId'] ?? '',
    accessToken: ig.secrets['accessToken'] ?? '',
    ...(ig.settings['username'] ? { username: ig.settings['username'] } : {}),
  };
}

/** DB-free: poll Instagram with the cached connection; the database only when the result differs from the last save. */
async function planInstagram(
  ctx: JobPlanContext,
  create: (app: AppContext, ig: LoadedIntegration) => ContentSource,
): Promise<JobPlan> {
  const ig = await ctx.integration('instagram');
  if (!ig.active) return { run: false, summary: 'instagram not connected' };
  const poll = await planContentPoll(ctx, ig, create(ctx.app, ig), { rehost: true, stateKey: 'synced' });
  return poll.changed
    ? { run: true, reason: poll.reason, carry: poll.carry }
    : { run: false, summary: poll.reason };
}

const postsSource = (app: AppContext, ig: LoadedIntegration) =>
  app.integrations.createInstagramPostsSource(instagramConfig(ig), app.integrationCtx);
const storiesSource = (app: AppContext, ig: LoadedIntegration) =>
  app.integrations.createInstagramStoriesSource(instagramConfig(ig), app.integrationCtx);

export const instagramPostsJob: Job = {
  name: 'instagram_posts',
  everyMs: 10 * MINUTE,
  plan: (ctx) => planInstagram(ctx, postsSource),
  async run(ctx) {
    const { app } = ctx;
    const ig = await loadIntegration(app.prisma, app.config.secretsKey, 'instagram');
    if (!ig.active) return { summary: 'instagram not connected' };
    const source = postsSource(app, ig);
    const result = await runContentSource(ctx, ig, source, { rehost: true, stateKey: 'synced' });
    return { summary: runSummary(result), state: result.state };
  },
};

export const instagramStoriesJob: Job = {
  name: 'instagram_stories',
  everyMs: 5 * MINUTE,
  plan: (ctx) => planInstagram(ctx, storiesSource),
  async run(ctx) {
    const { app } = ctx;
    const ig = await loadIntegration(app.prisma, app.config.secretsKey, 'instagram');
    if (!ig.active) return { summary: 'instagram not connected' };
    const source = storiesSource(app, ig);
    const result = await runContentSource(ctx, ig, source, { rehost: true, stateKey: 'synced' });
    return { summary: runSummary(result), state: result.state };
  },
};

/** How often the X job wakes to check whether a fetch is due (the finest admin interval). */
export const X_WAKE_MS = 30 * MINUTE;
/** After a failed fetch, retry sooner than a long interval (but never more often than the interval itself). */
const X_RETRY_MS = HOUR;
/** The scheduler's jitter can wake the job a little early; don't skip a whole interval for that. */
const X_EARLY_SLACK_MS = 2 * MINUTE;

/** When the next X fetch is due (null = never fetched: fetch now). Uses the current interval, so an admin change applies at once. */
export function xNextFetchAt(state: Record<string, unknown>, pollEveryMinutes: number): Date | null {
  const last = typeof state['lastFetchAt'] === 'string' ? Date.parse(state['lastFetchAt']) : NaN;
  if (Number.isNaN(last)) return null;
  const interval = pollEveryMinutes * MINUTE;
  const wait = state['lastFetchOk'] === false ? Math.min(interval, X_RETRY_MS) : interval;
  return new Date(last + wait);
}

export const xJob: Job = {
  name: 'x',
  // X API is pay-per-use: the job wakes every 30 min but only calls X when the admin's interval
  // (pollEveryMinutes, default twice a day) has passed. One server-side fetch serves every user; since_id means
  // each post is read (and billed) once.
  everyMs: X_WAKE_MS,
  // DB-free until a fetch is actually due (twice a day by default).
  async plan(ctx) {
    const x = await ctx.integration('x');
    if (!x.row.enabled || !x.secrets['bearerToken'] || !x.settings['username']) {
      return { run: false, summary: 'x disabled or not configured' };
    }
    const due = xNextFetchAt(ctx.state, xOptions(x.settings).pollEveryMinutes);
    if (due !== null && ctx.now.getTime() < due.getTime() - X_EARLY_SLACK_MS) {
      return { run: false, summary: `waiting: next X fetch at ${due.toISOString()}` };
    }
    return { run: true, reason: 'X fetch due' };
  },
  async run(ctx) {
    const { app } = ctx;
    let x = await loadIntegration(app.prisma, app.config.secretsKey, 'x');
    const bearerToken = x.secrets['bearerToken'];
    const username = x.settings['username'];
    if (!x.row.enabled || !bearerToken || !username) return { summary: 'x disabled or not configured' };
    const options = xOptions(x.settings);
    const due = xNextFetchAt(ctx.state, options.pollEveryMinutes);
    if (!ctx.force && due !== null && ctx.now.getTime() < due.getTime() - X_EARLY_SLACK_MS) {
      return { summary: `waiting: next X fetch at ${due.toISOString()}` };
    }
    if (!x.settings['userId']) {
      // The PUT couldn't reach X to resolve the account: try again now (only when a fetch is due).
      try {
        const user = await app.integrations.resolveXUser({ bearerToken, username }, app.integrationCtx);
        await app.prisma.integrationConfig.update({
          where: { id: 'x' },
          data: {
            settings: { ...x.settings, username: user.username, userId: user.id },
            accountLabel: `@${user.username}`,
          },
        });
        x = await loadIntegration(app.prisma, app.config.secretsKey, 'x');
      } catch (err) {
        // Search needs only the username, so a failed lookup never blocks (or re-bills) the fetch; it is retried at
        // the next due fetch.
        ctx.log.warn(
          { note: describeIntegrationError('x', err) },
          'x: account lookup failed, fetching anyway',
        );
      }
    }
    const source = app.integrations.createXSource(
      {
        bearerToken,
        userId: x.settings['userId'] ?? '',
        username: x.settings['username'] ?? username,
        includeLinks: options.includeLinks,
        includePhotos: options.includePhotos,
        includeVideos: options.includeVideos,
      },
      app.integrationCtx,
    );
    const result = await runContentSource(ctx, x, source, { rehost: false, stateKey: 'synced' });
    const state = { ...result.state, lastFetchAt: ctx.now.toISOString(), lastFetchOk: result.ok };
    const next = xNextFetchAt(state, options.pollEveryMinutes);
    return { summary: `${runSummary(result)}; next X fetch at ${next?.toISOString() ?? 'next tick'}`, state };
  },
};
