import { mapWithConcurrency, nextDeadline } from '@fant/fpl';
import { FplEntryIdSchema, FplLeagueIdSchema } from '@fant/shared';
import type { AppContext } from '../context.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { UNUSED_UPLOAD_TTL_MS } from '../routes/uploads.js';
import { allStandingRows, fetchAllPages, leagueHighlights } from '../league/pages.js';
import { deadlineCopy, gameweekLeagueCopy, gameweekSummaryCopy, type LeagueHighlight } from '../push/copy.js';
import { notify, prefValues } from '../push/notify.js';
import { getSettings } from '../settings.js';
import { HOUR, MINUTE, type Job, type JobRunContext } from './types.js';
import { purgeDeletedPostImages } from '../community/moderation.js';
import { purgePendingMediaDeletes } from '../media/pending.js';
import { deleteWithVariants } from '../media/variants.js';

/** A reminder that is due but more than this late (host was asleep) is dropped, not sent late. */
export const REMINDER_MAX_LATENESS_MS = 30 * MINUTE;
export const SUMMARY_FPL_CONCURRENCY = 5;

/** Reminder offsets due now for the next deadline (fire time passed, not more than 30 min late, before it). */
function dueOffsets(offsets: readonly number[], deadlineMs: number, nowMs: number): number[] {
  return offsets.filter((offset) => {
    const fireAt = deadlineMs - offset * MINUTE;
    return nowMs >= fireAt && nowMs < deadlineMs && nowMs - fireAt <= REMINDER_MAX_LATENESS_MS;
  });
}

/** Memo: `${event}:${offset}` reminders this process already sent (the dedupe log is the real guard). */
function sentReminders(memo: Record<string, unknown>): Set<string> {
  let set = memo['sent'];
  if (!(set instanceof Set)) {
    set = new Set<string>();
    memo['sent'] = set;
  }
  return set as Set<string>;
}

export const deadlineRemindersJob: Job = {
  name: 'deadline_reminders',
  everyMs: 5 * MINUTE,
  // DB-free unless a reminder's fire time has been crossed (cached bootstrap + cached settings).
  async plan(ctx) {
    const nowMs = ctx.now.getTime();
    const next = nextDeadline((await ctx.app.fpl.getBootstrap()).events, nowMs);
    if (next === null) return { run: false, summary: 'no upcoming deadline' };
    const sent = sentReminders(ctx.memo);
    const due = dueOffsets(
      (await ctx.settings()).deadlineReminderMinutes,
      Date.parse(next.deadlineTime),
      nowMs,
    ).filter((offset) => !sent.has(`${next.event}:${offset}`));
    return due.length === 0
      ? { run: false, summary: `GW${next.event}: nothing due` }
      : { run: true, reason: `GW${next.event}: ${due.join(', ')} min reminder due` };
  },
  async run(ctx) {
    const { app } = ctx;
    const nowMs = app.clock.now().getTime();
    const bootstrap = await app.fpl.getBootstrap();
    const next = nextDeadline(bootstrap.events, nowMs);
    if (next === null) return { summary: 'no upcoming deadline' };
    const deadlineMs = Date.parse(next.deadlineTime);
    const settings = await getSettings(app.prisma);
    const sent: string[] = [];
    const remembered = sentReminders(ctx.memo);
    for (const offset of dueOffsets(settings.deadlineReminderMinutes, deadlineMs, nowMs)) {
      const ttlSec = Math.max(60, Math.min(3600, Math.floor((deadlineMs - nowMs) / 1000)));
      const result = await notify(app, {
        kind: 'deadline',
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
      remembered.add(`${next.event}:${offset}`);
    }
    return {
      summary: sent.length === 0 ? `GW${next.event}: nothing due` : `GW${next.event}: ${sent.join(', ')}`,
    };
  },
};

/**
 * One push per user per finished GW (dedupe `gw_summary:<gw>`): the GW points / overall rank line (pref `fpl`)
 * combined with the user's moments in the podcast's league (pref `league`) — top scorer, first place, a climb
 * of 3+, into the top 3 / top 10. The league is read in full (all standings pages); if that fails, everyone
 * gets the plain summary.
 */
/** Users whose picks failed are retried with backoff (30 min, 1 h, 2 h … at most 12 h), not every 30 minutes. */
export const SUMMARY_RETRY_BASE_MS = 30 * MINUTE;
export const SUMMARY_RETRY_MAX_MS = 12 * HOUR;

function summaryRetryOf(
  state: Readonly<Record<string, unknown>>,
): { gw: number; attempts: number; nextAt: number } | null {
  const raw = state['summaryRetry'];
  if (typeof raw !== 'object' || raw === null) return null;
  const { gw, attempts, nextAt } = raw as Record<string, unknown>;
  return typeof gw === 'number' && typeof attempts === 'number' && typeof nextAt === 'number'
    ? { gw, attempts, nextAt }
    : null;
}

function nextSummaryRetry(state: Readonly<Record<string, unknown>>, gw: number, nowMs: number) {
  const previous = summaryRetryOf(state);
  const attempts = previous !== null && previous.gw === gw ? previous.attempts + 1 : 1;
  const wait = Math.min(SUMMARY_RETRY_MAX_MS, SUMMARY_RETRY_BASE_MS * 2 ** (attempts - 1));
  return { gw, attempts, nextAt: nowMs + wait };
}

export const gameweekSummaryJob: Job = {
  name: 'gameweek_summary',
  everyMs: 30 * MINUTE,
  // DB-free until FPL makes the current GW official and it hasn't been summarized yet.
  async plan(ctx) {
    const event = (await ctx.app.fpl.getBootstrap()).events.find(
      (e) => e.isCurrent && e.finished && e.dataChecked,
    );
    if (event === undefined) return { run: false, summary: 'no finished gameweek to summarize' };
    if (ctx.state['summarizedGw'] === event.id)
      return { run: false, summary: `GW${event.id} already summarized` };
    const retry = summaryRetryOf(ctx.state);
    if (retry !== null && retry.gw === event.id && ctx.now.getTime() < retry.nextAt) {
      return {
        run: false,
        summary: `GW${event.id}: retrying failed users at ${new Date(retry.nextAt).toISOString()}`,
      };
    }
    return { run: true, reason: `GW${event.id} to summarize` };
  },
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
        OR: [
          { notificationPrefs: { is: null } },
          { notificationPrefs: { is: { fpl: true } } },
          { notificationPrefs: { is: { league: true } } },
        ],
      },
      select: { id: true, entryId: true, notificationPrefs: true },
    });

    const highlights = await leagueHighlightsByEntry(ctx);
    let failures = 0;
    const scores = new Map<string, { points: number; rank: number | null }>();
    const moments = new Map<string, LeagueHighlight[]>();
    const wantsSummary = users.filter((u) => prefValues(u.notificationPrefs).fpl);
    await mapWithConcurrency(wantsSummary, SUMMARY_FPL_CONCURRENCY, async (user) => {
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
    for (const user of users) {
      const found = user.entryId === null ? undefined : highlights?.get(user.entryId);
      if (found !== undefined && found.length > 0) moments.set(user.id, found);
    }
    // Users whose picks failed are left out (retried next run) — even their league moments, so the one
    // combined push isn't spent on half the news.
    const failed = new Set(wantsSummary.filter((u) => !scores.has(u.id)).map((u) => u.id));
    const recipients = users.filter((u) => !failed.has(u.id) && (scores.has(u.id) || moments.has(u.id)));

    const result = await notify(app, {
      kind: 'gw_summary',
      to: recipients.map((u) => u.id),
      pref: ['fpl', 'league'],
      dedupeKeys: [key],
      options: { ttlSec: (12 * HOUR) / 1000, urgency: 'normal' },
      build: ({ userId, locale, prefs }) => {
        const score = prefs.fpl ? scores.get(userId) : undefined;
        const summary =
          score === undefined ? null : gameweekSummaryCopy(locale, event.id, score.points, score.rank);
        const leagueMoments = prefs.league ? (moments.get(userId) ?? []) : [];
        const text =
          leagueMoments.length === 0 ? summary : gameweekLeagueCopy(locale, leagueMoments, summary);
        if (text === null) return null;
        return {
          ...text,
          url: leagueMoments.length === 0 ? '/my-team/' : '/table/',
          tag: `gw-summary-${event.id}`,
          icon: PUSH_ICON,
          image: null,
        };
      },
    });
    // The GW is "done" only without failures (league standings failing isn't one: plain summary instead).
    return {
      summary: `GW${event.id}: ${result.recipients} sent (${moments.size} with league moments${
        highlights === null ? ', league unavailable' : ''
      }), ${failures} failed`,
      state:
        failures === 0
          ? { ...ctx.state, summarizedGw: event.id, summaryRetry: null }
          : { ...ctx.state, summaryRetry: nextSummaryRetry(ctx.state, event.id, ctx.now.getTime()) },
    };
  },
};

/**
 * entryId → league highlights for every manager of the configured league (all standings pages). null when
 * no league is configured or the standings couldn't be read (logged; the summary goes out without them).
 */
async function leagueHighlightsByEntry(ctx: JobRunContext): Promise<Map<number, LeagueHighlight[]> | null> {
  const { app } = ctx;
  const settings = await getSettings(app.prisma);
  if (settings.leagueId === null) return null;
  const leagueId = FplLeagueIdSchema.safeParse(settings.leagueId);
  if (!leagueId.success) return null;
  try {
    const pages = await fetchAllPages((page) => app.fpl.getLeagueStandings(leagueId.data, page));
    const rows = allStandingRows(pages);
    const max = rows.reduce((m, r) => Math.max(m, r.eventTotal), 0);
    return new Map(rows.map((r) => [r.entryId, leagueHighlights(r, max)]));
  } catch (err) {
    ctx.log.warn({ err }, 'gameweek summary: league standings unavailable, sending the plain summary');
    return null;
  }
}

export const STORY_MEDIA_RETENTION_MS = 48 * HOUR;

/** Notification dedupe rows older than this are deleted: every dedupe key is about a GW / item long gone by then. */
export const NOTIFICATION_LOG_RETENTION_MS = 90 * 24 * HOUR;
export const RETENTION_BATCH = 5000;
const RETENTION_MAX_BATCHES = 20;

/** Deletes rows in bounded batches (one short statement each: no long lock, no compute spike). */
async function deleteInBatches(
  app: AppContext,
  table: 'NotificationLog' | 'Session',
  column: string,
  before: Date,
) {
  let total = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i += 1) {
    const sql = `DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE "${column}" < $1 LIMIT ${RETENTION_BATCH})`;
    const n = await app.prisma.$executeRawUnsafe(sql, before);
    total += n;
    if (n < RETENTION_BATCH) break;
  }
  return total;
}

export const cleanupJob: Job = {
  name: 'cleanup',
  // Housekeeping only (expired stories are already hidden at read time): hourly while the database is awake for
  // other reasons, otherwise once a day, so it never wakes Neon on its own more than that.
  everyMs: HOUR,
  idleEveryMs: 24 * HOUR,
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
        if (m.storageKey !== null) await deleteWithVariants(app.media, m.storageKey);
        if (m.posterKey !== null) await deleteWithVariants(app.media, m.posterKey);
        await app.prisma.newsMedia.update({
          where: { id: m.id },
          data: { storageKey: null, posterKey: null, variants: [] },
        });
        deleted += 1;
      } catch (err) {
        ctx.log.warn({ err, mediaId: m.id }, 'cleanup: media delete failed (will retry)');
      }
    }
    const uploads = await deleteUnusedUploads(app, now);
    // Safety net: images of deleted posts whose immediate purge failed (e.g. storage briefly down).
    const removedImages = await purgeDeletedPostImages(app.prisma, app.media);
    // Files whose rows are already gone (deleted accounts) and whose first delete attempt failed.
    const pending = await purgePendingMediaDeletes(app.prisma, app.media);
    // Retention: the tables that grow with every user and push (1 GB storage cap).
    const logs = await deleteInBatches(
      app,
      'NotificationLog',
      'createdAt',
      new Date(now.getTime() - NOTIFICATION_LOG_RETENTION_MS),
    );
    const sessions = await deleteInBatches(app, 'Session', 'expiresAt', now);
    return {
      summary: `${hidden.count} stories hidden, ${deleted} media files deleted, ${uploads} unused uploads deleted, ${removedImages} deleted-post images purged, ${pending} pending files deleted, ${logs} old notification logs and ${sessions} expired sessions deleted`,
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
    await deleteWithVariants(app.media, upload.storageKey).catch(() => undefined);
    count += 1;
  }
  return count;
}
