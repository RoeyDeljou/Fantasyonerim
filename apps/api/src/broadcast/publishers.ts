import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
  X_MAX_WEIGHTED_LENGTH,
  XPostTooLongError,
  xWeightedLength,
  type PublishInput,
} from '@fant/integrations';
import type {
  BroadcastTarget,
  BroadcastTargetResult,
  BroadcastTargetsStatus,
  PushPayload,
} from '@fant/shared';
import type { Upload } from '@prisma/client';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { loadIntegration } from '../integrations/store.js';
import { createAdminUpdate } from '../news/adminUpdate.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { EMPTY_LINKS, readLinks } from '../news/serialize.js';
import { broadcastCopy } from '../push/copy.js';
import { notify } from '../push/notify.js';

/**
 * Admin live broadcasts: one message → several targets. Each target is a `BroadcastPublisher`; adding a target
 * (e.g. the deferred WhatsApp group bot) = add it to BroadcastTargetSchema in @fant/shared + one entry in
 * PUBLISHERS below. Targets never throw into each other: `runBroadcast` isolates every one.
 */

export const LIVE_PUSH_TTL_SEC = 60 * 60;
export const X_NOT_CONNECTED = "X isn't connected — paid feature, contact the creator";
export const NO_LIVE_SUBSCRIBERS = 'No one has enabled live notifications yet';
export const PUSH_NOT_CONFIGURED = "Push notifications aren't set up on the server (VAPID keys are missing)";
const X_WRITE_KEYS = ['apiKey', 'apiSecret', 'accessToken', 'accessSecret'] as const;

export interface BroadcastInput {
  id: string;
  title: string | null;
  text: string;
  upload: Upload | null;
  targets: readonly BroadcastTarget[];
}

/** Shared between targets of one broadcast (push links to the News item when both were chosen). */
export interface BroadcastRunState {
  newsItemId: string | null;
}

/** Fields every non-push result shares (push fills the device counts). */
const NO_COUNTS = { delivered: null, recipients: null } as const;

export interface TargetAvailability {
  available: boolean;
  reason: string | null;
  reasonCode: BroadcastTargetsStatus['targets'][number]['reasonCode'];
  paidFeature: boolean;
}

export interface BroadcastPublisher {
  target: BroadcastTarget;
  status(ctx: AppContext): Promise<TargetAvailability>;
  /** Runs before anything is published; throws an ApiHttpError (400) so nothing half-publishes. */
  precheck?(input: Pick<BroadcastInput, 'text'>): void;
  publish(ctx: AppContext, input: BroadcastInput, state: BroadcastRunState): Promise<BroadcastTargetResult>;
}

const newsUrl = (id: string) => `/news/?item=${encodeURIComponent(id)}`;

// ---------- news ----------

const newsPublisher: BroadcastPublisher = {
  target: 'news',
  status: async () => ({ available: true, reason: null, reasonCode: null, paidFeature: false }),
  async publish(ctx, input, state) {
    // Same shape as the manual POST /v1/admin/news item — but NOT pushed through the regular news push:
    // the broadcast's own `push` target (prefs.live) is the only notification for it.
    const item = await createAdminUpdate(ctx, { title: input.title, text: input.text, image: input.upload });
    state.newsItemId = item.id;
    return {
      target: 'news',
      status: 'ok',
      code: 'posted',
      detail: 'Posted to the News feed',
      ...NO_COUNTS,
      url: newsUrl(item.id),
    };
  },
};

// ---------- push ----------

async function liveSubscriberCount(ctx: AppContext): Promise<number> {
  return ctx.prisma.user.count({
    where: {
      pushSubscriptions: { some: {} },
      OR: [{ notificationPrefs: { is: null } }, { notificationPrefs: { is: { live: true } } }],
    },
  });
}

const pushPublisher: BroadcastPublisher = {
  target: 'push',
  async status(ctx) {
    if (ctx.push === null) {
      return {
        available: false,
        reason: PUSH_NOT_CONFIGURED,
        reasonCode: 'not_configured',
        paidFeature: false,
      };
    }
    const none = (await liveSubscriberCount(ctx)) === 0;
    return {
      available: true,
      reason: none ? NO_LIVE_SUBSCRIBERS : null,
      reasonCode: none ? 'no_subscribers' : null,
      paidFeature: false,
    };
  },
  async publish(ctx, input, state) {
    if (ctx.push === null) {
      return {
        target: 'push',
        status: 'skipped',
        code: 'not_configured',
        detail: PUSH_NOT_CONFIGURED,
        ...NO_COUNTS,
        url: null,
      };
    }
    const url = state.newsItemId === null ? '/news/' : newsUrl(state.newsItemId);
    const result = await notify(ctx, {
      to: 'all',
      // Live updates follow the "live" preference; the "news" preference is irrelevant here.
      pref: 'live',
      dedupeKeys: [`broadcast:${input.id}`],
      options: { ttlSec: LIVE_PUSH_TTL_SEC, urgency: 'high' },
      build: ({ locale }): PushPayload => {
        const copy = broadcastCopy(locale, input.title, input.text);
        return {
          title: copy.title,
          body: copy.body,
          url,
          tag: `live-${input.id}`,
          icon: PUSH_ICON,
          image: input.upload ? ctx.mediaUrl(input.upload.url) : null,
        };
      },
    });
    if (result.devices === 0) {
      return {
        target: 'push',
        status: 'skipped',
        code: 'no_subscribers',
        detail: NO_LIVE_SUBSCRIBERS,
        delivered: 0,
        recipients: 0,
        url: null,
      };
    }
    const failed = result.devicesDelivered === 0;
    return {
      target: 'push',
      status: failed ? 'error' : 'ok',
      code: failed ? 'failed' : 'delivered',
      detail: `Delivered to ${result.devicesDelivered} of ${result.devices} devices`,
      delivered: result.devicesDelivered,
      recipients: result.devices,
      url: null,
    };
  },
};

// ---------- X ----------

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/** Admin-readable publish failure, with every stored secret value scrubbed out (defense in depth). */
export function describeXPublishError(err: unknown, secrets: Readonly<Record<string, string>>): string {
  let message: string;
  const raw = errorMessage(err).trim();
  if (err instanceof IntegrationAuthError || isNamed(err, 'IntegrationAuthError')) {
    // @fant/integrations auth errors already say what to do ("… needs Read and write …").
    message =
      raw !== ''
        ? raw
        : 'X rejected the keys — re-enter the API Key/Secret and Access Token/Secret (generated with Read and write).';
  } else if (err instanceof IntegrationRateLimitError || isNamed(err, 'IntegrationRateLimitError')) {
    message = `X rate limit or credits reached — try again later. ${raw}`;
  } else if (err instanceof IntegrationUnavailableError || isNamed(err, 'IntegrationUnavailableError')) {
    message = `X is not responding right now — not posted. ${raw}`;
  } else if (err instanceof IntegrationConfigError || isNamed(err, 'IntegrationConfigError')) {
    message = raw;
  } else {
    message = `Couldn't post to X. ${raw}`;
  }
  for (const value of Object.values(secrets)) {
    if (value.length >= 4) message = message.split(value).join('***');
  }
  message = message.replace(/\s+/g, ' ').trim();
  return message.length <= 300 ? message : `${message.slice(0, 299)}…`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function uploadBytes(ctx: AppContext, upload: Upload): Promise<Uint8Array | null> {
  try {
    if (ctx.media.read) {
      const stored = await ctx.media.read(upload.storageKey);
      if (stored !== null) return stored.bytes;
    }
    const res = await ctx.fetch(upload.url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function xWriteCredentials(ctx: AppContext) {
  const x = await loadIntegration(ctx.prisma, ctx.config.secretsKey, 'x');
  const ok = X_WRITE_KEYS.every((k) => (x.secrets[k] ?? '') !== '');
  return { x, ok };
}

const xPublisher: BroadcastPublisher = {
  target: 'x',
  async status(ctx) {
    const { ok } = await xWriteCredentials(ctx);
    return {
      available: ok,
      reason: ok ? null : X_NOT_CONNECTED,
      reasonCode: ok ? null : 'paid_feature',
      paidFeature: true,
    };
  },
  precheck({ text }) {
    const length = xWeightedLength(text);
    if (length > X_MAX_WEIGHTED_LENGTH) {
      throw badRequest(
        `text: too long for X — ${length} characters by X's count, the limit is ${X_MAX_WEIGHTED_LENGTH}. Shorten it or untick X. Nothing was sent.`,
      );
    }
  },
  async publish(ctx, input, state) {
    const { x, ok } = await xWriteCredentials(ctx);
    if (!ok) {
      return {
        target: 'x',
        status: 'skipped',
        code: 'not_configured',
        detail: X_NOT_CONNECTED,
        ...NO_COUNTS,
        url: null,
      };
    }

    let image: PublishInput['image'] = null;
    let imageNote = '';
    if (input.upload !== null) {
      const bytes = await uploadBytes(ctx, input.upload);
      if (bytes === null) imageNote = " (without the image — it couldn't be read)";
      else image = { bytes, mimeType: input.upload.contentType };
    }
    try {
      const publisher = ctx.integrations.createXPublisher(
        {
          apiKey: x.secrets['apiKey'] ?? '',
          apiSecret: x.secrets['apiSecret'] ?? '',
          accessToken: x.secrets['accessToken'] ?? '',
          accessSecret: x.secrets['accessSecret'] ?? '',
          ...(x.settings['username'] ? { username: x.settings['username'] } : {}),
        },
        ctx.integrationCtx,
      );
      const posted = await publisher.publish({ text: input.text, image });
      await rememberOwnXPost(ctx, posted.externalId, posted.url, state.newsItemId);
      return {
        target: 'x',
        status: 'ok',
        code: 'posted',
        detail: `Posted to X${imageNote}`,
        ...NO_COUNTS,
        url: posted.url,
      };
    } catch (err) {
      const tooLong = err instanceof XPostTooLongError;
      const detail = tooLong
        ? `Too long for X (${err.weightedLength} of ${X_MAX_WEIGHTED_LENGTH} characters)`
        : describeXPublishError(err, x.secrets);
      return {
        target: 'x',
        status: 'error',
        code: tooLong ? 'too_long' : 'failed',
        detail,
        ...NO_COUNTS,
        url: null,
      };
    }
  },
};

/**
 * The X read integration would otherwise import our own post as a new News item (a duplicate card + a second
 * notification). A hidden placeholder under the post's dedupe key makes that import a no-op; when the broadcast
 * also created a News item, that item links to the X post instead.
 */
async function rememberOwnXPost(
  ctx: AppContext,
  postId: string,
  url: string | null,
  newsItemId: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.prisma.newsItem.upsert({
    where: { dedupeKey: `x:${postId}` },
    update: { hiddenAt: now, suppressed: true },
    create: {
      dedupeKey: `x:${postId}`,
      source: 'x_post',
      title: null,
      text: null,
      links: { ...EMPTY_LINKS, x: url },
      publishedAt: now,
      hiddenAt: now,
      suppressed: true,
    },
  });
  if (newsItemId !== null && url !== null) {
    const item = await ctx.prisma.newsItem.findUnique({ where: { id: newsItemId } });
    if (item !== null) {
      await ctx.prisma.newsItem.update({
        where: { id: newsItemId },
        data: { links: { ...readLinks(item.links), x: url } },
      });
    }
  }
}

// ---------- registry ----------

/** In run order: news first (push links to it), then the rest in parallel. */
export const PUBLISHERS: Readonly<Record<BroadcastTarget, BroadcastPublisher>> = {
  news: newsPublisher,
  push: pushPublisher,
  x: xPublisher,
};

/** Every precheck of the chosen targets; throws (400) before anything is created or sent. */
export function precheckBroadcast(input: Pick<BroadcastInput, 'text' | 'targets'>): void {
  for (const target of input.targets) PUBLISHERS[target].precheck?.(input);
}

/** Runs every chosen target; one failing (even throwing) never blocks the others. Results in request order. */
export async function runBroadcast(
  ctx: AppContext,
  input: BroadcastInput,
  onUnexpected: (target: BroadcastTarget, err: unknown) => void,
): Promise<BroadcastTargetResult[]> {
  const state: BroadcastRunState = { newsItemId: null };
  const run = async (target: BroadcastTarget): Promise<BroadcastTargetResult> => {
    try {
      return await PUBLISHERS[target].publish(ctx, input, state);
    } catch (err) {
      onUnexpected(target, err);
      return {
        target,
        status: 'error',
        code: 'failed',
        detail: 'Something went wrong on our side — not sent',
        ...NO_COUNTS,
        url: null,
      };
    }
  };
  const results = new Map<BroadcastTarget, BroadcastTargetResult>();
  if (input.targets.includes('news')) results.set('news', await run('news'));
  const rest = input.targets.filter((t) => t !== 'news');
  const done = await Promise.all(rest.map(run));
  rest.forEach((t, i) => {
    const r = done[i];
    if (r !== undefined) results.set(t, r);
  });
  return input.targets.flatMap((t) => {
    const r = results.get(t);
    return r === undefined ? [] : [r];
  });
}
