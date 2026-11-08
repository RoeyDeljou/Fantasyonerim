import { xOptions } from '../integrations/config.js';
import { loadIntegration, recordIntegrationRun, describeIntegrationError } from '../integrations/store.js';
import { runContentSource, runSummary } from './content.js';
import { HOUR, MINUTE, type Job } from './types.js';

export const instagramPostsJob: Job = {
  name: 'instagram_posts',
  everyMs: 10 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const ig = await loadIntegration(app.prisma, app.config.secretsKey, 'instagram');
    if (!ig.active) return { summary: 'instagram not connected' };
    const source = app.integrations.createInstagramPostsSource(
      {
        igUserId: ig.settings['igUserId'] ?? '',
        accessToken: ig.secrets['accessToken'] ?? '',
        ...(ig.settings['username'] ? { username: ig.settings['username'] } : {}),
      },
      app.integrationCtx,
    );
    const result = await runContentSource(ctx, ig, source, { rehost: true, stateKey: 'synced' });
    return { summary: runSummary(result), state: result.state };
  },
};

export const instagramStoriesJob: Job = {
  name: 'instagram_stories',
  everyMs: 5 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const ig = await loadIntegration(app.prisma, app.config.secretsKey, 'instagram');
    if (!ig.active) return { summary: 'instagram not connected' };
    const source = app.integrations.createInstagramStoriesSource(
      {
        igUserId: ig.settings['igUserId'] ?? '',
        accessToken: ig.secrets['accessToken'] ?? '',
        ...(ig.settings['username'] ? { username: ig.settings['username'] } : {}),
      },
      app.integrationCtx,
    );
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
  return new Date(last + wait - X_EARLY_SLACK_MS);
}

export const xJob: Job = {
  name: 'x',
  // X API is pay-per-use: the job wakes every 30 min but only calls X when the admin's interval
  // (pollEveryMinutes, default twice a day) has passed. One server-side fetch serves every user; since_id means
  // each post is read (and billed) once.
  everyMs: X_WAKE_MS,
  async run(ctx) {
    const { app } = ctx;
    let x = await loadIntegration(app.prisma, app.config.secretsKey, 'x');
    const bearerToken = x.secrets['bearerToken'];
    const username = x.settings['username'];
    if (!x.row.enabled || !bearerToken || !username) return { summary: 'x disabled or not configured' };
    const options = xOptions(x.settings);
    const due = xNextFetchAt(ctx.state, options.pollEveryMinutes);
    if (!ctx.force && due !== null && ctx.now.getTime() < due.getTime()) {
      return { summary: `waiting: next X fetch at ${due.toISOString()}` };
    }
    if (!x.settings['userId']) {
      // The PUT couldn't reach X to resolve the account: do it now, once.
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
        const note = describeIntegrationError('x', err);
        await recordIntegrationRun(app.prisma, 'x', app.clock.now(), { ok: false, error: note });
        return { summary: `failed: ${note}` };
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
