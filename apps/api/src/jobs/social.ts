import { loadIntegration, recordIntegrationRun, describeIntegrationError } from '../integrations/store.js';
import { runContentSource, runSummary } from './content.js';
import { MINUTE, type Job } from './types.js';

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

export const xJob: Job = {
  name: 'x',
  everyMs: 10 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    let x = await loadIntegration(app.prisma, app.config.secretsKey, 'x');
    const bearerToken = x.secrets['bearerToken'];
    const username = x.settings['username'];
    if (!x.row.enabled || !bearerToken || !username) return { summary: 'x disabled or not configured' };
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
      { bearerToken, userId: x.settings['userId'] ?? '', username: x.settings['username'] ?? username },
      app.integrationCtx,
    );
    const result = await runContentSource(ctx, x, source, { rehost: false, stateKey: 'synced' });
    return { summary: runSummary(result), state: result.state };
  },
};
