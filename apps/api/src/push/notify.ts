import { randomUUID } from 'node:crypto';
import { mapWithConcurrency } from '@fant/fpl';
import { LocaleSchema, PushPayloadSchema, type Locale, type PushPayload } from '@fant/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Clock } from '../context.js';
import { DEFAULT_PUSH_OPTIONS, toOutcome, type PushProvider, type PushSendOptions } from './provider.js';
import { pushServiceOf, type PushBatchRecorder } from './stats.js';
import type { PushService } from '@fant/shared';

export type PrefKey = 'news' | 'fpl' | 'live' | 'community';

/** A subscription is deleted after this many consecutive non-404/410 failures. */
export const MAX_PUSH_FAILURES = 5;
export const PUSH_CONCURRENCY = 10;

export interface Recipient {
  userId: string;
  locale: Locale;
}

/** What a batch is, for the logs and the admin push-health view. */
export type NotifyKind = 'news' | 'live' | 'deadline' | 'gw_summary' | 'comment' | 'admin' | 'test';

export interface NotifyRequest {
  kind: NotifyKind;
  /** Explicit user ids, or every user with a push subscription. */
  to: readonly string[] | 'all';
  /** Only users who have this preference on (no prefs row = all on). null = no preference filter. */
  pref: PrefKey | null;
  /**
   * "At most once per user per item": each key is claimed in NotificationLog before sending; users who
   * already hold every key are skipped. Omit for unlogged sends (e.g. admin manual push).
   */
  dedupeKeys?: readonly string[];
  /** Per-recipient payload (localized). Return null to skip that user. */
  build: (recipient: Recipient) => PushPayload | null;
  options?: PushSendOptions;
}

export interface NotifyResult {
  /** Users the notification was sent to (after preference + dedupe filtering). */
  recipients: number;
  /** Of those, users with at least one device that accepted it. */
  delivered: number;
  /** Push subscriptions (devices) the notification was sent to. */
  devices: number;
  /** Of those, devices whose push service accepted it. */
  devicesDelivered: number;
  /** Devices whose subscription is dead (404/410): deleted. */
  gone: number;
  /** Devices that failed otherwise (counted; deleted after MAX_PUSH_FAILURES in a row). */
  failed: number;
  /** HTTP statuses of the failures (distinct, sorted), e.g. [403]. */
  failureCodes: number[];
}

const NOTHING_SENT: NotifyResult = {
  recipients: 0,
  delivered: 0,
  devices: 0,
  devicesDelivered: 0,
  gone: 0,
  failed: 0,
  failureCodes: [],
};

/**
 * Web push payloads must fit in 4 KB once encrypted (≈ 3.99 KB of plaintext). Keep well under it: drop the
 * optional image first, then shorten the body.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 3000;

export function fitPayload(payload: PushPayload): PushPayload {
  const size = (p: PushPayload) => Buffer.byteLength(JSON.stringify(p), 'utf8');
  if (size(payload) <= MAX_PUSH_PAYLOAD_BYTES) return payload;
  let fitted: PushPayload = { ...payload, image: null };
  let body = [...fitted.body];
  while (size(fitted) > MAX_PUSH_PAYLOAD_BYTES && body.length > 0) {
    body = body.slice(0, Math.max(0, Math.floor(body.length * 0.8) - 1));
    fitted = { ...fitted, body: body.length === 0 ? '' : `${body.join('').trimEnd()}…` };
  }
  if (size(fitted) > MAX_PUSH_PAYLOAD_BYTES)
    fitted = { ...fitted, title: [...fitted.title].slice(0, 100).join('') };
  return fitted;
}

export interface NotifyDeps {
  prisma: PrismaClient;
  push: PushProvider | null;
  clock: Clock;
  /** Logs + keeps every batch's counts (no endpoints). */
  pushStats?: PushBatchRecorder;
}

export async function notify(deps: NotifyDeps, request: NotifyRequest): Promise<NotifyResult> {
  const { prisma, push } = deps;
  if (push === null) return { ...NOTHING_SENT };
  if (request.to !== 'all' && request.to.length === 0) return { ...NOTHING_SENT };

  const where: Prisma.UserWhereInput = { pushSubscriptions: { some: {} } };
  if (request.to !== 'all') where.id = { in: [...request.to] };
  if (request.pref !== null) {
    where.OR = [{ notificationPrefs: { is: null } }, { notificationPrefs: { is: { [request.pref]: true } } }];
  }
  const users = await prisma.user.findMany({ where, select: { id: true, locale: true } });

  const payloads = new Map<string, PushPayload>();
  for (const user of users) {
    const locale = LocaleSchema.safeParse(user.locale);
    const payload = request.build({ userId: user.id, locale: locale.success ? locale.data : 'he' });
    if (payload !== null) payloads.set(user.id, fitPayload(PushPayloadSchema.parse(payload)));
  }
  if (payloads.size === 0) return finish(deps, request.kind, { ...NOTHING_SENT }, {});

  let recipientIds = [...payloads.keys()];
  const keys = request.dedupeKeys ?? [];
  if (keys.length > 0) recipientIds = await claim(prisma, recipientIds, keys);
  if (recipientIds.length === 0) return finish(deps, request.kind, { ...NOTHING_SENT }, {});

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId: { in: recipientIds } } });
  const deliveredTo = new Set<string>();
  let devicesDelivered = 0;
  let gone = 0;
  let failed = 0;
  const failureCodes = new Set<number>();
  const services: Partial<Record<PushService, number>> = {};
  for (const sub of subscriptions) {
    const service = pushServiceOf(sub.endpoint);
    services[service] = (services[service] ?? 0) + 1;
  }
  const options = request.options ?? DEFAULT_PUSH_OPTIONS;
  await mapWithConcurrency(subscriptions, PUSH_CONCURRENCY, async (sub) => {
    const payload = payloads.get(sub.userId);
    if (payload === undefined) return;
    const { result, statusCode } = toOutcome(await push.send(sub, payload, options));
    if (result === 'ok') {
      deliveredTo.add(sub.userId);
      devicesDelivered += 1;
      await prisma.pushSubscription.updateMany({
        where: { id: sub.id },
        data: { lastSuccessAt: deps.clock.now(), failureCount: 0 },
      });
    } else if (result === 'gone') {
      gone += 1;
      await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
    } else {
      failed += 1;
      if (statusCode !== null) failureCodes.add(statusCode);
      await prisma.pushSubscription.updateMany({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
      });
      await prisma.pushSubscription.deleteMany({
        where: { id: sub.id, failureCount: { gte: MAX_PUSH_FAILURES } },
      });
    }
  });
  return finish(
    deps,
    request.kind,
    {
      recipients: recipientIds.length,
      delivered: deliveredTo.size,
      devices: subscriptions.length,
      devicesDelivered,
      gone,
      failed,
      failureCodes: [...failureCodes].sort((a, b) => a - b),
    },
    services,
  );
}

/** Records the batch (log line + recent list). Batches that reached nobody aren't kept, except tests. */
function finish(
  deps: NotifyDeps,
  kind: NotifyKind,
  result: NotifyResult,
  services: Partial<Record<PushService, number>>,
): NotifyResult {
  if (deps.pushStats && (result.recipients > 0 || kind === 'test')) {
    deps.pushStats.record({
      at: deps.clock.now().toISOString(),
      kind,
      recipients: result.recipients,
      devices: result.devices,
      delivered: result.devicesDelivered,
      gone: result.gone,
      failed: result.failed,
      failureCodes: result.failureCodes,
      services,
    });
  }
  return result;
}

/** Inserts (user, key) rows; returns the users for whom at least one key was new. */
async function claim(prisma: PrismaClient, userIds: string[], keys: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  const users: string[] = [];
  const allKeys: string[] = [];
  for (const userId of userIds) {
    for (const key of keys) {
      ids.push(randomUUID());
      users.push(userId);
      allKeys.push(key);
    }
  }
  const rows = await prisma.$queryRaw<{ userId: string }[]>(Prisma.sql`
    INSERT INTO "NotificationLog" ("id", "userId", "key")
    SELECT * FROM unnest(${ids}::text[], ${users}::text[], ${allKeys}::text[])
    ON CONFLICT ("userId", "key") DO NOTHING
    RETURNING "userId"`);
  return [...new Set(rows.map((r) => r.userId))];
}
