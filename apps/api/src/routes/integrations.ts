import type { ConnectableInstagramAccount } from '@fant/integrations';
import {
  IntegrationIdSchema,
  IntegrationListSchema,
  IntegrationStatusSchema,
  IntegrationUpdateBodySchema,
  OAuthStartSchema,
  type IntegrationId,
} from '@fant/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { ApiHttpError, badRequest } from '../errors.js';
import { EXPECTED_INSTAGRAM_USERNAME, INTEGRATIONS, INTEGRATION_IDS } from '../integrations/config.js';
import { createOAuthState, verifyOAuthState } from '../integrations/oauthState.js';
import {
  describeIntegrationError,
  encryptSecrets,
  ensureIntegrationRows,
  isAuthError,
  isConfigError,
  loadIntegration,
  toIntegrationStatus,
} from '../integrations/store.js';
import { SYNC_JOBS } from '../jobs/index.js';
import type { JobRunner } from '../jobs/runner.js';
import { parseInput, serialize } from '../validate.js';

const IdParamsSchema = z.object({ id: IntegrationIdSchema });

const CallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(1000).optional(),
  error: z.string().max(200).optional(),
  error_reason: z.string().max(200).optional(),
});

export function instagramRedirectUri(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, '')}/v1/integrations/instagram/callback`;
}

/** Prefers the client's account; otherwise the first one, with a warning for the admin console. */
export function chooseInstagramAccount(accounts: readonly ConnectableInstagramAccount[]): {
  account: ConnectableInstagramAccount;
  warning: string | null;
} {
  const expected = accounts.find((a) => a.username.toLowerCase() === EXPECTED_INSTAGRAM_USERNAME);
  if (expected !== undefined) return { account: expected, warning: null };
  const first = accounts[0];
  if (first === undefined) throw new Error('no connectable Instagram account');
  return {
    account: first,
    warning: `Connected @${first.username} — expected @${EXPECTED_INSTAGRAM_USERNAME}. Reconnect and select the Facebook Page linked to @${EXPECTED_INSTAGRAM_USERNAME} if this is the wrong account.`,
  };
}

export function integrationRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, jobs: JobRunner): void {
  const { prisma } = ctx;
  const key = ctx.config.secretsKey;

  const status = async (id: IntegrationId) =>
    serialize(IntegrationStatusSchema, toIntegrationStatus(await loadIntegration(prisma, key, id)));

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.get('/v1/admin/integrations', async () => {
      await ensureIntegrationRows(prisma);
      const rows = await prisma.integrationConfig.findMany();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const integrations = [];
      for (const id of INTEGRATION_IDS) {
        const row = byId.get(id);
        if (row !== undefined) integrations.push(toIntegrationStatus(await loadIntegration(prisma, key, id)));
      }
      return serialize(IntegrationListSchema, { integrations });
    });

    admin.get('/v1/admin/integrations/instagram/connect-url', async (request) => {
      const { user } = await auth.requireAdmin(request);
      const meta = ctx.config.meta;
      const apiUrl = ctx.config.apiPublicUrl;
      if (!meta || !apiUrl) {
        throw new ApiHttpError(
          503,
          'upstream_unavailable',
          'Instagram connect is not configured on the server (META_APP_ID / META_APP_SECRET / API_PUBLIC_URL)',
        );
      }
      const url = ctx.integrations.buildInstagramConnectUrl({
        appId: meta.appId,
        redirectUri: instagramRedirectUri(apiUrl),
        state: createOAuthState(key, user.id, ctx.clock.now().getTime()),
      });
      return serialize(OAuthStartSchema, { url });
    });

    admin.delete('/v1/admin/integrations/instagram', async (_request, reply) => {
      await loadIntegration(prisma, key, 'instagram');
      await prisma.integrationConfig.update({
        where: { id: 'instagram' },
        data: {
          enabled: false,
          settings: {},
          secretsEnc: null,
          cursor: null,
          accountLabel: null,
          lastError: null,
          tokenExpiresAt: null,
          dataAccessExpiresAt: null,
          initialSyncDone: false,
        },
      });
      for (const job of SYNC_JOBS.instagram) await jobs.reset(job, { forgetState: true });
      return reply.code(204).send();
    });

    admin.put('/v1/admin/integrations/:id', async (request) => {
      const { id } = parseInput(IdParamsSchema, request.params);
      const body = parseInput(IntegrationUpdateBodySchema, request.body);
      const def = INTEGRATIONS[id];
      const current = await loadIntegration(prisma, key, id);

      const settings: Record<string, string> = { ...current.settings };
      for (const [name, value] of Object.entries(body.settings)) {
        const normalize = def.editable[name];
        if (normalize !== undefined) {
          if (value === null || value === '') {
            delete settings[name];
            continue;
          }
          const result = normalize(value);
          if (!result.ok) throw badRequest(`settings.${name}: ${result.message}`);
          settings[name] = result.value;
        } else if (!def.readOnly.includes(name)) {
          throw badRequest(`settings.${name}: not a setting of ${id}`);
        }
      }

      const secrets: Record<string, string> = { ...current.secrets };
      for (const [name, value] of Object.entries(body.secrets ?? {})) {
        if (!def.secretKeys.includes(name)) {
          throw badRequest(
            id === 'instagram'
              ? `secrets.${name}: Instagram credentials come from "Connect Instagram", not from this form`
              : `secrets.${name}: not a secret of ${id}`,
          );
        }
        if (value === null) delete secrets[name];
        else if (value !== '') secrets[name] = value; // blank = keep the stored value
      }

      const data: Prisma.IntegrationConfigUpdateInput = { enabled: body.enabled };
      const settingsChanged = JSON.stringify(settings) !== JSON.stringify(current.settings);
      const secretsChanged = JSON.stringify(secrets) !== JSON.stringify(current.secrets);

      if (id === 'x') {
        const usernameChanged = settings['username'] !== current.settings['username'];
        const tokenChanged = secrets['bearerToken'] !== current.secrets['bearerToken'];
        if (usernameChanged || tokenChanged || !settings['userId']) delete settings['userId'];
        const bearerToken = secrets['bearerToken'];
        const username = settings['username'];
        if (!settings['userId'] && bearerToken && username) {
          try {
            const user = await ctx.integrations.resolveXUser({ bearerToken, username }, ctx.integrationCtx);
            settings['userId'] = user.id;
            settings['username'] = user.username;
            data.accountLabel = `@${user.username}`;
          } catch (err) {
            if (isAuthError(err))
              throw badRequest(`secrets.bearerToken: ${describeIntegrationError('x', err)}`);
            if (isConfigError(err))
              throw badRequest(`settings.username: ${describeIntegrationError('x', err)}`);
            // X unreachable: save anyway, the x job resolves the account on its next run.
            data.lastError = `Couldn't verify the X account yet — will retry. (${describeIntegrationError('x', err)})`;
          }
        }
        if (usernameChanged) data.cursor = null;
      }
      if (id === 'podcast_rss' && settings['rssUrl'] !== current.settings['rssUrl']) data.cursor = null;

      data.settings = settings;
      data.secretsEnc = encryptSecrets(key, secrets);
      if ((settingsChanged || secretsChanged) && data.lastError === undefined) data.lastError = null;
      await prisma.integrationConfig.update({ where: { id }, data });

      // Changed settings → poll on the next scheduler tick instead of waiting for the interval.
      if (settingsChanged || secretsChanged || (body.enabled && !current.row.enabled)) {
        for (const job of SYNC_JOBS[id]) await jobs.reset(job);
      }
      return status(id);
    });

    admin.post('/v1/admin/integrations/:id/sync', async (request) => {
      const { id } = parseInput(IdParamsSchema, request.params);
      for (const job of SYNC_JOBS[id]) await jobs.run(job, { force: true });
      return status(id);
    });
  });

  // Public, but only accepted with a valid signed state from an admin's connect-url.
  app.get('/v1/integrations/instagram/callback', async (request, reply) => {
    const webAppUrl = ctx.config.webAppUrl;
    if (!webAppUrl) {
      throw new ApiHttpError(503, 'upstream_unavailable', 'WEB_APP_URL is not configured on the server');
    }
    const back = (reply: FastifyReply, params: Record<string, string>) =>
      reply.redirect(
        `${webAppUrl.replace(/\/+$/, '')}/admin/?${new URLSearchParams(params).toString()}`,
        302,
      );
    const fail = (reason: string) => back(reply, { instagram: 'error', reason });

    const query = CallbackQuerySchema.safeParse(request.query);
    if (!query.success || query.data.state === undefined) return fail('invalid_state');
    const verified = verifyOAuthState(key, query.data.state, ctx.clock.now().getTime());
    if (!verified.ok) return fail(verified.reason);
    const admin = await prisma.user.findUnique({ where: { id: verified.userId } });
    if (admin === null || admin.role !== 'ADMIN') return fail('invalid_state');
    if (query.data.error !== undefined) return fail(query.data.error_reason ?? 'denied');
    if (query.data.code === undefined) return fail('missing_code');
    const meta = ctx.config.meta;
    const apiUrl = ctx.config.apiPublicUrl;
    if (!meta || !apiUrl) return fail('not_configured');

    await loadIntegration(prisma, key, 'instagram');
    let accounts: ConnectableInstagramAccount[];
    try {
      accounts = await ctx.integrations.completeInstagramConnect(
        {
          appId: meta.appId,
          appSecret: meta.appSecret,
          redirectUri: instagramRedirectUri(apiUrl),
          code: query.data.code,
        },
        ctx.integrationCtx,
      );
    } catch (err) {
      await prisma.integrationConfig.update({
        where: { id: 'instagram' },
        data: { lastError: describeIntegrationError('instagram', err), lastRunAt: ctx.clock.now() },
      });
      return fail(isConfigError(err) ? 'no_instagram_account' : 'connect_failed');
    }
    if (accounts.length === 0) return fail('no_instagram_account');
    const { account, warning } = chooseInstagramAccount(accounts);
    await prisma.integrationConfig.update({
      where: { id: 'instagram' },
      data: {
        enabled: true,
        settings: { igUserId: account.igUserId, username: account.username, pageId: account.pageId },
        secretsEnc: encryptSecrets(key, { accessToken: account.accessToken }),
        accountLabel: `@${account.username}`,
        tokenExpiresAt: account.expiresAt,
        dataAccessExpiresAt: account.dataAccessExpiresAt,
        lastError: warning,
        cursor: null,
        // A (re)connected account backfills silently.
        initialSyncDone: false,
      },
    });
    for (const job of SYNC_JOBS.instagram) await jobs.reset(job, { forgetState: true });
    return back(
      reply,
      warning === null
        ? { instagram: 'connected' }
        : { instagram: 'connected', warning: 'unexpected_account' },
    );
  });
}
