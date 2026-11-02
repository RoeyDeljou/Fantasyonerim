import { mapWithConcurrency } from '@fant/fpl';
import {
  FplEntryIdSchema,
  FplLeagueIdSchema,
  type FplEntryId,
  type Gameweek,
  type LiveLeagueRow,
  type Locale,
  type PushPayload,
} from '@fant/shared';
import { z } from 'zod';
import { fetchAllPages, rankLiveLeague } from '../league/pages.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { captainReturnCopy, liveFirstPlaceCopy, liveJumpCopy, type PushText } from '../push/copy.js';
import { notify, prefValues, type PrefKey } from '../push/notify.js';
import { createYielder } from '../perf/yield.js';
import { getSettings } from '../settings.js';
import { HOUR, MINUTE, type Job, type JobRunContext } from './types.js';

/**
 * Live "big moment" alerts during a GW, balanced to big events only:
 * - your (effective) captain scored / assisted — pref `captain`, every registered user;
 * - you moved into first place of the live league — pref `league`, league members;
 * - you jumped 5+ places in the live league — pref `league`, league members.
 *
 * Runs every 2 minutes while a fixture of the current GW is live (plus one pass after the last one ends, so
 * final-whistle moments aren't lost), otherwise no-ops on two cached FPL reads. Alerts fire only on changes
 * observed between two consecutive runs: the first run of a GW (or the first time a user is seen) only records
 * a baseline, so a deploy mid-GW never replays earlier goals. No negative alerts.
 */

export const LIVE_ALERTS_EVERY_MS = 2 * MINUTE;
/** Every live alert of a GW, per user (captain + league). */
export const LIVE_ALERTS_MAX_PER_GW = 6;
/** Live-table places climbed (since the baseline or the user's last league alert) that make a "jump". */
export const LIVE_JUMP_PLACES = 5;
export const LIVE_JUMP_MIN_GAP_MS = 2 * HOUR;
export const LIVE_JUMP_MAX_PER_GW = 3;
export const LIVE_FIRST_MIN_GAP_MS = HOUR;
export const LIVE_ENTRY_CONCURRENCY = 5;
const LIVE_TTL_SEC = HOUR / 1000;

const UserStateSchema = z.object({
  /** Effective captain at the previous run (null = unknown / none). */
  cap: z.number().int().nullable(),
  /** Live league rank at the previous run (null = not seen in the league). */
  rank: z.number().int().nullable(),
  /** Reference for a jump: the GW-baseline (official) rank, then the live rank at the user's last league alert. */
  ref: z.number().int().nullable(),
  firstAt: z.number().nullable(),
  firsts: z.number().int(),
  jumpAt: z.number().nullable(),
  jumps: z.number().int(),
});
type UserState = z.infer<typeof UserStateSchema>;

const LiveStateSchema = z.object({
  gw: z.number().int(),
  /** A fixture was live at the previous run (→ one more pass once they all end). */
  wasLive: z.boolean(),
  /** Goals / assists of every player who was someone's effective captain at the previous run. */
  players: z.record(z.string(), z.object({ g: z.number().int(), a: z.number().int() })),
  users: z.record(z.string(), UserStateSchema),
});
type LiveState = z.infer<typeof LiveStateSchema>;

const NEW_USER: UserState = {
  cap: null,
  rank: null,
  ref: null,
  firstAt: null,
  firsts: 0,
  jumpAt: null,
  jumps: 0,
};

export function readLiveState(raw: unknown): LiveState | null {
  const parsed = LiveStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

interface CaptainNow {
  playerId: number;
  goals: number;
  assists: number;
  /** basePoints × effective multiplier so far. */
  points: number;
}

type AlertText = (locale: Locale) => PushText;

interface PlannedAlert {
  userId: string;
  key: string;
  pref: PrefKey;
  url: string;
  text: AlertText;
}

export const liveAlertsJob: Job = {
  name: 'live_alerts',
  everyMs: LIVE_ALERTS_EVERY_MS,
  async run(ctx) {
    const { app } = ctx;
    const stored = readLiveState(ctx.state['live']);
    const bootstrap = await app.fpl.getBootstrap();
    const gw = bootstrap.currentEvent;
    if (gw === null) return { summary: 'no current gameweek' };
    const fixtures = await app.fpl.getFixtures(gw);
    const live = fixtures.some((f) => f.status === 'live');
    const sameGw = stored !== null && stored.gw === gw;
    if (!live && !(sameGw && stored.wasLive)) return { summary: `GW${gw}: no live fixture` };

    const previous: LiveState = sameGw ? stored : { gw, wasLive: false, players: {}, users: {} };
    const names = new Map<number, string>(bootstrap.players.map((p) => [p.id, p.webName]));
    const deadlineTime = bootstrap.events.find((e) => e.id === gw)?.deadlineTime;
    const deadline = deadlineTime === undefined ? null : new Date(deadlineTime);
    const outcome = await observe(ctx, gw, previous, live, (id) => names.get(id) ?? `#${id}`, deadline);
    const sent = await send(ctx, gw, outcome.alerts);
    return {
      summary: `GW${gw}${live ? '' : ' (final pass)'}: ${sameGw ? '' : 'baseline, '}${
        outcome.alerts.length
      } alerts planned, ${sent} sent, ${outcome.captains} captains, ${outcome.members} league members${
        outcome.leagueFailed ? ', live league unavailable' : ''
      }`,
      state: { ...ctx.state, live: outcome.state },
    };
  },
};

interface Observation {
  state: LiveState;
  alerts: PlannedAlert[];
  captains: number;
  members: number;
  leagueFailed: boolean;
}

async function observe(
  ctx: JobRunContext,
  gw: Gameweek,
  previous: LiveState,
  live: boolean,
  playerName: (id: number) => string,
  deadline: Date | null,
): Promise<Observation> {
  const { app } = ctx;
  const nowMs = ctx.now.getTime();
  const users = await app.prisma.user.findMany({
    where: {
      entryId: { not: null },
      pushSubscriptions: { some: {} },
      OR: [
        { notificationPrefs: { is: null } },
        { notificationPrefs: { is: { captain: true } } },
        { notificationPrefs: { is: { league: true } } },
      ],
    },
    select: { id: true, entryId: true, notificationPrefs: true },
  });
  const people = users.flatMap((u) => {
    const entryId = FplEntryIdSchema.safeParse(u.entryId);
    return entryId.success
      ? [{ id: u.id, entryId: entryId.data, prefs: prefValues(u.notificationPrefs) }]
      : [];
  });

  // Captains: the live engine's effective captain (vice when the captain didn't play; TC alike).
  const captains = new Map<string, CaptainNow | null>();
  const yieldNow = createYielder();
  await mapWithConcurrency(
    people.filter((p) => p.prefs.captain),
    LIVE_ENTRY_CONCURRENCY,
    async (person) => {
      await yieldNow();
      try {
        const entry = await app.fpl.getEntryLive(person.entryId, gw);
        const pick = entry.picks.find((p) => p.effectiveMultiplier >= 2);
        captains.set(
          person.id,
          pick === undefined
            ? null
            : { playerId: pick.playerId, goals: pick.goals, assists: pick.assists, points: pick.points },
        );
      } catch (err) {
        // Unknown this run: the user's previous state is kept, nothing is alerted for them.
        ctx.log.info({ err, userId: person.id }, 'live alerts: entry live unavailable');
      }
    },
  );

  // League: the whole live table (every page), ranked league-wide.
  const table = new Map<FplEntryId, LiveLeagueRow>();
  let leagueFailed = false;
  if (people.some((p) => p.prefs.league)) {
    const settings = await getSettings(app.prisma);
    const leagueId = FplLeagueIdSchema.safeParse(settings.leagueId);
    if (leagueId.success) {
      try {
        const pages = await fetchAllPages((page) => app.fpl.getLiveLeague(leagueId.data, gw, page));
        for (const row of rankLiveLeague(pages)) table.set(row.entryId, row);
      } catch (err) {
        leagueFailed = true;
        ctx.log.warn({ err }, 'live alerts: live league unavailable');
      }
    }
  }

  const alreadySent = await liveAlertCounts(ctx, gw, deadline);
  const alerts: PlannedAlert[] = [];
  const nextUsers: Record<string, UserState> = {};
  const nextPlayers: LiveState['players'] = {};

  for (const person of people) {
    const before = previous.users[person.id];
    const state: UserState = { ...(before ?? NEW_USER) };
    let budget = LIVE_ALERTS_MAX_PER_GW - (alreadySent.get(person.id) ?? 0);
    const plan = (alert: Omit<PlannedAlert, 'userId'>): boolean => {
      if (budget <= 0) return false;
      budget -= 1;
      alerts.push({ ...alert, userId: person.id });
      return true;
    };

    // --- captain scored / assisted (one alert per new goal / assist) ---
    const captain = person.prefs.captain ? captains.get(person.id) : null;
    if (captain !== undefined) {
      if (captain !== null) {
        const seen = previous.players[String(captain.playerId)];
        if (before !== undefined && before.cap === captain.playerId && seen !== undefined) {
          const name = playerName(captain.playerId);
          const returns = [
            ...range(seen.g + 1, captain.goals).map((n) => ({ what: 'goal' as const, tag: `g${n}` })),
            ...range(seen.a + 1, captain.assists).map((n) => ({ what: 'assist' as const, tag: `a${n}` })),
          ];
          for (const r of returns) {
            plan({
              key: `live:${gw}:cap:${captain.playerId}:${r.tag}`,
              pref: 'captain',
              url: '/my-team/',
              text: (locale) => captainReturnCopy(locale, r.what, name, gw, captain.points),
            });
          }
        }
        nextPlayers[String(captain.playerId)] = { g: captain.goals, a: captain.assists };
      }
      state.cap = captain?.playerId ?? null;
    } else if (state.cap !== null && previous.players[String(state.cap)] !== undefined) {
      // Not read this run: keep the counts it will be compared against next time.
      nextPlayers[String(state.cap)] ??= previous.players[String(state.cap)] ?? { g: 0, a: 0 };
    }

    // --- live league: into first place / a big jump ---
    const row = person.prefs.league && !leagueFailed ? table.get(person.entryId) : undefined;
    if (row !== undefined) {
      const rank = row.liveRank;
      const prevRank = before?.rank ?? null;
      const ref = state.ref ?? row.officialRank;
      state.ref = ref;
      if (prevRank !== null) {
        const firstOk = state.firstAt === null || nowMs - state.firstAt >= LIVE_FIRST_MIN_GAP_MS;
        const jumpOk =
          state.jumps < LIVE_JUMP_MAX_PER_GW &&
          (state.jumpAt === null || nowMs - state.jumpAt >= LIVE_JUMP_MIN_GAP_MS);
        if (prevRank > 1 && rank === 1 && firstOk) {
          const n = state.firsts + 1;
          const points = row.livePoints;
          if (
            plan({
              key: `live:${gw}:first:${n}`,
              pref: 'league',
              url: '/live/',
              text: (locale) => liveFirstPlaceCopy(locale, gw, points),
            })
          ) {
            state.firsts = n;
            state.firstAt = nowMs;
            state.ref = rank;
          }
        } else if (rank < prevRank && ref - rank >= LIVE_JUMP_PLACES && jumpOk) {
          // Only a climb observed since the previous run triggers it, measured from the reference rank.
          const n = state.jumps + 1;
          const places = ref - rank;
          const points = row.livePoints;
          if (
            plan({
              key: `live:${gw}:jump:${n}`,
              pref: 'league',
              url: '/live/',
              text: (locale) => liveJumpCopy(locale, places, rank, gw, points),
            })
          ) {
            state.jumps = n;
            state.jumpAt = nowMs;
            state.ref = rank;
          }
        }
      }
      state.rank = rank;
    } else if (!leagueFailed) {
      // Not in the league table (or league alerts off): a later appearance starts from a fresh baseline.
      state.rank = null;
    }

    nextUsers[person.id] = state;
  }

  return {
    state: { gw, wasLive: live, players: nextPlayers, users: nextUsers },
    alerts,
    captains: [...captains.values()].filter((c) => c !== null).length,
    members: people.filter((p) => table.has(p.entryId)).length,
    leagueFailed,
  };
}

/** [from..to] inclusive (empty when to < from). */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** Live alerts each user already got this GW (from the dedupe log, so it survives restarts). */
async function liveAlertCounts(
  ctx: JobRunContext,
  gw: Gameweek,
  deadline: Date | null,
): Promise<Map<string, number>> {
  // A GW's live alerts only exist after its deadline: the range on createdAt (indexed) keeps this to the current
  // GW's rows instead of the season-long log. A day of margin for clock skew between the API and the database.
  const since = deadline === null ? null : new Date(deadline.getTime() - 24 * HOUR);
  const rows = await ctx.app.prisma.notificationLog.groupBy({
    by: ['userId'],
    where: { key: { startsWith: `live:${gw}:` }, ...(since === null ? {} : { createdAt: { gte: since } }) },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.userId, r._count._all]));
}

/** One notify batch per dedupe key (e.g. everyone whose captain's 2nd goal just went in). */
async function send(ctx: JobRunContext, gw: Gameweek, alerts: readonly PlannedAlert[]): Promise<number> {
  const byKey = new Map<string, PlannedAlert[]>();
  for (const alert of alerts) byKey.set(alert.key, [...(byKey.get(alert.key) ?? []), alert]);
  let sent = 0;
  for (const [key, group] of byKey) {
    const first = group[0];
    if (first === undefined) continue;
    const perUser = new Map(group.map((a) => [a.userId, a]));
    try {
      const result = await notify(ctx.app, {
        kind: 'live',
        to: [...perUser.keys()],
        pref: first.pref,
        dedupeKeys: [key],
        options: { ttlSec: LIVE_TTL_SEC, urgency: 'high' },
        build: ({ userId, locale }): PushPayload | null => {
          const alert = perUser.get(userId);
          if (alert === undefined) return null;
          return {
            ...alert.text(locale),
            url: alert.url,
            tag: key.replaceAll(':', '-'),
            icon: PUSH_ICON,
            image: null,
          };
        },
      });
      sent += result.recipients;
    } catch (err) {
      ctx.log.warn({ err, gw, key }, 'live alerts: send failed');
    }
  }
  return sent;
}
