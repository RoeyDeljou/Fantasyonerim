import { randomUUID } from 'node:crypto';
import { mapWithConcurrency } from '@fant/fpl';
import { LocaleSchema, PushPayloadSchema, type Locale, type PushPayload } from '@fant/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Clock } from '../context.js';
import { DEFAULT_PUSH_OPTIONS, type PushProvider, type PushSendOptions } from './provider.js';

export type PrefKey = 'news' | 'fpl' | 'live' | 'community';

/** A subscription is deleted after this many consecutive non-404/410 failures. */
export const MAX_PUSH_FAILURES = 5;
export const PUSH_CONCURRENCY = 10;

export interface Recipient {
  userId: string;
  locale: Locale;
}

export interface NotifyRequest {
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
}

export interface NotifyDeps {
  prisma: PrismaClient;
  push: PushProvider | null;
  clock: Clock;
}

export async function notify(deps: NotifyDeps, request: NotifyRequest): Promise<NotifyResult> {
  const { prisma, push } = deps;
  if (push === null) return { recipients: 0, delivered: 0 };
  if (request.to !== 'all' && request.to.length === 0) return { recipients: 0, delivered: 0 };

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
    if (payload !== null) payloads.set(user.id, PushPayloadSchema.parse(payload));
  }
  if (payloads.size === 0) return { recipients: 0, delivered: 0 };

  let recipientIds = [...payloads.keys()];
  const keys = request.dedupeKeys ?? [];
  if (keys.length > 0) recipientIds = await claim(prisma, recipientIds, keys);
  if (recipientIds.length === 0) return { recipients: 0, delivered: 0 };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId: { in: recipientIds } } });
  const deliveredTo = new Set<string>();
  const options = request.options ?? DEFAULT_PUSH_OPTIONS;
  await mapWithConcurrency(subscriptions, PUSH_CONCURRENCY, async (sub) => {
    const payload = payloads.get(sub.userId);
    if (payload === undefined) return;
    const result = await push.send(sub, payload, options);
    if (result === 'ok') {
      deliveredTo.add(sub.userId);
      await prisma.pushSubscription.updateMany({
        where: { id: sub.id },
        data: { lastSuccessAt: deps.clock.now(), failureCount: 0 },
      });
    } else if (result === 'gone') {
      await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
    } else {
      await prisma.pushSubscription.updateMany({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
      });
      await prisma.pushSubscription.deleteMany({
        where: { id: sub.id, failureCount: { gte: MAX_PUSH_FAILURES } },
      });
    }
  });
  return { recipients: recipientIds.length, delivered: deliveredTo.size };
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
