import { mapWithConcurrency, nextDeadline } from '@fant/fpl';
import { FplEntryIdSchema } from '@fant/shared';
import type { AppContext } from '../context.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { UNUSED_UPLOAD_TTL_MS } from '../routes/uploads.js';
import { deadlineCopy, gameweekSummaryCopy } from '../push/copy.js';
import { notify } from '../push/notify.js';
import { getSettings } from '../settings.js';
import { HOUR, MINUTE, type Job } from './types.js';

/** A reminder that is due but more than this late (host was asleep) is dropped, not sent late. */
export const REMINDER_MAX_LATENESS_MS = 30 * MINUTE;
export const SUMMARY_FPL_CONCURRENCY = 5;

export const deadlineRemindersJob: Job = {
  name: 'deadline_reminders',
  everyMs: 5 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const nowMs = app.clock.now().getTime();
    const bootstrap = await app.fpl.getBootstrap();
    const next = nextDeadline(bootstrap.events, nowMs);
    if (next === null) return { summary: 'no upcoming deadline' };
    const deadlineMs = Date.parse(next.deadlineTime);
    const settings = await getSettings(app.prisma);
    const sent: string[] = [];
    for (const offset of settings.deadlineReminderMinutes) {
      const fireAt = deadlineMs - offset * MINUTE;
      if (nowMs < fireAt || nowMs >= deadlineMs || nowMs - fireAt > REMINDER_MAX_LATENESS_MS) continue;
      const ttlSec = Math.max(60, Math.min(3600, Math.floor((deadlineMs - nowMs) / 1000)));
      const result = await notify(app, {
        to: 'all',
        pref: 'fpl',
        dedupeKeys: [`deadline:${next.event}:${offset}`],
        options: { ttlSec, urgency: 'high' },
        build: ({ locale }) => ({
          ...deadlineCopy(locale, next.event, offset),
          url: '/my-team/',
          tag: `deadline-${next.event}`,
          icon: PUSH_ICON,
          image: null,
        }),
      });
      sent.push(`${offset}m → ${result.recipients}`);
    }
    return {
      summary: sent.length === 0 ? `GW${next.event}: nothing due` : `GW${next.event}: ${sent.join(', ')}`,
    };
  },
};

export const gameweekSummaryJob: Job = {
  name: 'gameweek_summary',
  everyMs: 30 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const bootstrap = await app.fpl.getBootstrap();
    // Only while the finished GW is still "current" (until the next deadline): never a stale summary.
    const event = bootstrap.events.find((e) => e.isCurrent && e.finished && e.dataChecked);
    if (event === undefined) return { summary: 'no finished gameweek to summarize' };
    if (ctx.state['summarizedGw'] === event.id) return { summary: `GW${event.id} already summarized` };
    const key = `gw_summary:${event.id}`;

    const users = await app.prisma.user.findMany({
      where: {
        entryId: { not: null },
        pushSubscriptions: { some: {} },
        notificationLogs: { none: { key } },
        OR: [{ notificationPrefs: { is: null } }, { notificationPrefs: { is: { fpl: true } } }],
      },
      select: { id: true, entryId: true },
    });
    let failures = 0;
    const scores = new Map<string, { points: number; rank: number | null }>();
    await mapWithConcurrency(users, SUMMARY_FPL_CONCURRENCY, async (user) => {
      const entryId = FplEntryIdSchema.safeParse(user.entryId);
      if (!entryId.success) return;
      try {
        const picks = await app.fpl.getEntryPicks(entryId.data, event.id);
        scores.set(user.id, { points: picks.points - picks.transfersCost, rank: picks.overallRank });
      } catch (err) {
        failures += 1;
        ctx.log.warn({ err, userId: user.id }, 'gameweek summary: picks unavailable');
      }
    });
    const result = await notify(app, {
      to: [...scores.keys()],
      pref: 'fpl',
      dedupeKeys: [key],
      options: { ttlSec: (12 * HOUR) / 1000, urgency: 'normal' },
      build: ({ userId, locale }) => {
        const score = scores.get(userId);
        if (score === undefined) return null;
        return {
          ...gameweekSummaryCopy(locale, event.id, score.points, score.rank),
          url: '/my-team/',
          tag: `gw-summary-${event.id}`,
          icon: PUSH_ICON,
          image: null,
        };
      },
    });
    // Users whose picks failed are retried on the next run; the GW is "done" only without failures.
    return {
      summary: `GW${event.id}: ${result.recipients} sent, ${failures} failed`,
      state: failures === 0 ? { ...ctx.state, summarizedGw: event.id } : ctx.state,
    };
  },
};

export const STORY_MEDIA_RETENTION_MS = 48 * HOUR;

export const cleanupJob: Job = {
  name: 'cleanup',
  everyMs: HOUR,
  async run(ctx) {
    const { app } = ctx;
    const now = app.clock.now();
    const hidden = await app.prisma.newsItem.updateMany({
      where: { source: 'instagram_story', expiresAt: { lt: now }, hiddenAt: null },
      data: { hiddenAt: now },
    });
    const old = await app.prisma.newsMedia.findMany({
      where: {
        item: {
          source: 'instagram_story',
          publishedAt: { lt: new Date(now.getTime() - STORY_MEDIA_RETENTION_MS) },
        },
        OR: [{ storageKey: { not: null } }, { posterKey: { not: null } }],
      },
    });
    let deleted = 0;
    for (const m of old) {
      try {
        if (m.storageKey !== null) await app.media.delete(m.storageKey);
        if (m.posterKey !== null) await app.media.delete(m.posterKey);
        await app.prisma.newsMedia.update({
          where: { id: m.id },
          data: { storageKey: null, posterKey: null },
        });
        deleted += 1;
      } catch (err) {
        ctx.log.warn({ err, mediaId: m.id }, 'cleanup: media delete failed (will retry)');
      }
    }
    const uploads = await deleteUnusedUploads(app, now);
    return {
      summary: `${hidden.count} stories hidden, ${deleted} media files deleted, ${uploads} unused uploads deleted`,
    };
  },
};

export const UPLOAD_CLEANUP_BATCH = 500;

/**
 * Uploads never attached to a post within UNUSED_UPLOAD_TTL_MS. The row is deleted first (only while still
 * unused, so a post created meanwhile keeps its image), then the file.
 */
async function deleteUnusedUploads(app: AppContext, now: Date): Promise<number> {
  const stale = await app.prisma.upload.findMany({
    where: { usedAt: null, createdAt: { lt: new Date(now.getTime() - UNUSED_UPLOAD_TTL_MS) } },
    take: UPLOAD_CLEANUP_BATCH,
    select: { id: true, storageKey: true },
  });
  let count = 0;
  for (const upload of stale) {
    const claimed = await app.prisma.upload.deleteMany({ where: { id: upload.id, usedAt: null } });
    if (claimed.count === 0) continue;
    // A failed file delete leaves an orphaned object but never an unusable row.
    await app.media.delete(upload.storageKey).catch(() => undefined);
    count += 1;
  }
  return count;
}
