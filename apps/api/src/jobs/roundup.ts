import { FplLeagueIdSchema, type Gameweek } from '@fant/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { isFplUnavailable } from '../fplErrors.js';
import {
  buildRoundups,
  officialEvents,
  ROUNDUP_BUILD_DELAY_MS,
  ROUNDUP_HOT_PREFIX,
  supportsRoundup,
} from '../league/roundup.js';
import { getSettings } from '../settings.js';
import { MINUTE, type Job } from './types.js';

const JOB_NAME = 'gameweek_roundup';

/** When the job first saw the newest official GW (the 5-minute build delay counts from here). */
const CheckedStateSchema = z.object({ event: z.number().int(), since: z.string() });

/**
 * Gameweek Roundup builder. Every run: the GWs FPL has made official (`finished && dataChecked`) that have no
 * stored roundup for the configured league, newest first, then older ones (back-fill), a bounded number per run
 * (league/roundup.ts ROUNDUP_REQUEST_BUDGET). The newest official GW waits ROUNDUP_BUILD_DELAY_MS after the job
 * first saw it official, so no history fetched before FPL's final update (cached 5 min) ends up in it. Older
 * GWs were official long ago and are built right away. FPL unavailable → nothing partial is stored, the run
 * fails (lastError) and the next run retries.
 */
export const gameweekRoundupJob: Job = {
  name: JOB_NAME,
  everyMs: 5 * MINUTE,
  // 171 members × 3 GWs ≈ 1 minute; a 2,000-member league (LEAGUE_MAX_PAGES) still fits.
  leaseMs: 15 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const fpl = app.fpl;
    if (!supportsRoundup(fpl)) return { summary: 'FplService has no roundup data methods' };
    const settings = await getSettings(app.prisma);
    const league = FplLeagueIdSchema.safeParse(settings.leagueId);
    if (settings.leagueId === null || !league.success) return { summary: 'no league configured' };
    const leagueId = league.data;
    const now = app.clock.now();

    const retryAt = fpl.getHealth?.().retryAt ?? null;
    if (retryAt !== null && Date.parse(retryAt) > now.getTime()) {
      return { summary: `FPL backing off until ${retryAt}` };
    }

    const bootstrap = await fpl.getBootstrap();
    const official = officialEvents(bootstrap);
    const newest = official[0];
    if (newest === undefined) return { summary: 'no official gameweek yet' };

    const previous = CheckedStateSchema.safeParse(ctx.state['checked']);
    const checked =
      previous.success && previous.data.event === newest
        ? previous.data
        : { event: newest as number, since: now.toISOString() };
    const state = { ...ctx.state, checked };
    const newestReady = now.getTime() - Date.parse(checked.since) >= ROUNDUP_BUILD_DELAY_MS;

    const stored = await app.prisma.gameweekRoundup.findMany({
      where: { leagueId, event: { in: official } },
      select: { event: true },
    });
    const have = new Set(stored.map((r) => r.event));
    const missing: Gameweek[] = official.filter((gw) => !have.has(gw) && (gw !== newest || newestReady));
    const waiting = !have.has(newest) && !newestReady;
    if (missing.length === 0) {
      return {
        summary: waiting ? `GW${newest}: waiting for FPL's final data` : 'every official gameweek is built',
        state,
      };
    }

    try {
      const result = await buildRoundups(
        {
          prisma: app.prisma,
          fpl,
          now: () => app.clock.now(),
          onStored: (event) => app.hot.cache.invalidate(`${ROUNDUP_HOT_PREFIX}${leagueId}:${event}:`),
        },
        leagueId,
        bootstrap,
        missing,
      );
      return {
        summary: `league ${leagueId}: built ${result.built.map((gw) => `GW${gw}`).join(', ') || 'nothing'}, ${
          result.remaining
        } left${waiting ? `, GW${newest} waiting` : ''}`,
        state,
      };
    } catch (err) {
      // Keep the "first seen official" time even though the run fails (the runner only saves state on success).
      await app.prisma.jobLease
        .update({ where: { name: JOB_NAME }, data: { state: state as Prisma.InputJsonObject } })
        .catch(() => undefined);
      if (isFplUnavailable(err)) {
        throw new Error(`FPL unavailable, nothing stored (retrying next run): ${err.message}`, {
          cause: err,
        });
      }
      throw err;
    }
  },
};
