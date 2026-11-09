import {
  FplEntryIdSchema,
  FplPlayerIdSchema,
  GameweekRoundupSchema,
  GameweekSchema,
  type FplEntryId,
  type FplLeagueId,
  type Gameweek,
  type GameweekRoundup,
  type RoundupCaptain,
  type RoundupStatus,
} from '@fant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import {
  currentRoundupEvent,
  effectiveCaptain,
  officialEvents,
  readCaptainPoints,
  readRoundup,
  ROUNDUP_HOT_PREFIX,
  sortCaptains,
} from '../league/roundup.js';
import { computeSeasonCaptains, SEASON_CAPTAINS_HOT_PREFIX } from '../league/seasonCaptains.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import type { HotPolicy } from '../perf/hotCache.js';
import { parseInput, serialize } from '../validate.js';
import { cleanQuery, EventQuerySchema } from './query.js';

/** A stored roundup is final; the status of an unbuilt GW is re-read every 30 s. */
const ROUNDUP_POLICY: HotPolicy = { freshMs: 30_000, staleMs: 60_000, staleIfErrorMs: 30 * 60_000 };

/** The season leaderboard is recomputed at most once a minute (and dropped when a roundup is stored). */
const SEASON_POLICY: HotPolicy = { freshMs: 60_000, staleMs: 120_000, staleIfErrorMs: 30 * 60_000 };

/** The `mine` row's label: the client shows its own i18n text for kind `mine`. */
export const MINE_LABEL = 'mine';

function emptyRoundup(event: Gameweek, status: RoundupStatus, events: Gameweek[]): GameweekRoundup {
  return {
    event,
    status,
    events,
    league: null,
    participants: null,
    averages: null,
    king: null,
    table: [],
    biggestClimb: null,
    biggestDrop: null,
    benchPoints: null,
    bestTransfer: null,
    worstTransfer: null,
    captains: [],
    builtAt: null,
  };
}

/**
 * GET /v1/league/roundup?event=<gw> — the stored Gameweek Roundup ("סיכום מחזור"). The shared part is computed
 * once per TTL for everybody (ctx.hot) and is public-cacheable without a viewer; a signed-in fan with a team
 * gets their own captain row (`kind: 'mine'`) added per request, in a private response.
 */
export function roundupRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  async function shared(leagueId: FplLeagueId, event: Gameweek, official: boolean, events: Gameweek[]) {
    const key = `${ROUNDUP_HOT_PREFIX}${leagueId}:${event}:${official ? 'official' : 'pending'}`;
    return ctx.hot.cache.get(key, ROUNDUP_POLICY, async () => ({
      build: async () => {
        if (!official) return serialize(GameweekRoundupSchema, emptyRoundup(event, 'pending', events));
        const stored = await readRoundup(ctx.prisma, leagueId, event);
        if (stored === null) return serialize(GameweekRoundupSchema, emptyRoundup(event, 'building', events));
        if (stored === 'invalid') {
          return serialize(GameweekRoundupSchema, emptyRoundup(event, 'unavailable', events));
        }
        return serialize(
          GameweekRoundupSchema,
          {
            ...stored.core,
            event,
            status: 'ready',
            events,
            league: { id: leagueId, name: stored.leagueName },
            captains: stored.captains,
            builtAt: stored.builtAt.toISOString(),
          } satisfies GameweekRoundup,
          'GameweekRoundup',
        );
      },
    }));
  }

  /** The viewer's captain that GW: from their stored table row when they're a member, else their picks. */
  async function mineRow(
    roundup: GameweekRoundup,
    leagueId: FplLeagueId,
    entryId: FplEntryId,
    request: FastifyRequest,
  ): Promise<RoundupCaptain | null> {
    const event = roundup.event;
    try {
      const row = roundup.table.find((r) => r.entryId === entryId);
      let captain: { playerId: number; multiplier: 2 | 3; points: number } | null = null;
      if (row !== undefined && row.captainPlayerId !== null) {
        const points = await readCaptainPoints(ctx.prisma, leagueId, event);
        captain = {
          playerId: row.captainPlayerId,
          multiplier: row.chip === '3xc' ? 3 : 2,
          points: points[row.captainPlayerId] ?? 0,
        };
      } else {
        const found = effectiveCaptain(await ctx.fpl.getEntryPicks(entryId, event));
        if (found === null) return null;
        const playerId = FplPlayerIdSchema.parse(found.playerId);
        const points = ctx.fpl.getEventPoints
          ? ((await ctx.fpl.getEventPoints(event)).get(playerId)?.points ?? 0)
          : ((await ctx.fpl.getPlayersLive([playerId], event))[0]?.basePoints ?? 0);
        captain = { ...found, points };
      }
      return {
        key: 'me',
        label: MINE_LABEL,
        kind: 'mine',
        tag: null,
        playerId: FplPlayerIdSchema.parse(captain.playerId),
        multiplier: captain.multiplier,
        captainPoints: captain.points * captain.multiplier,
      };
    } catch (err) {
      // No team that GW (404) or FPL unavailable: the roundup is shown without the viewer's row.
      request.log.info({ err, entryId, event }, 'roundup: viewer captain unavailable');
      return null;
    }
  }

  app.get('/v1/league/roundup', async (request, reply) => {
    const query = parseInput(EventQuerySchema, cleanQuery(request.query));
    const bootstrap = (await ctx.hot.bootstrap()).value;
    const current = currentRoundupEvent(bootstrap);
    if (query.event !== undefined && query.event > current) {
      throw badRequest(`event: must be between 1 and ${current} (the current gameweek)`);
    }
    const official = officialEvents(bootstrap);
    const event = query.event ?? official[0] ?? current;
    const events = Array.from({ length: current }, (_, i) => GameweekSchema.parse(i + 1));
    const viewer = await auth.resolve(request);
    const leagueId = await ctx.hot.leagueId();

    if (leagueId === null) {
      reply.header('cache-control', viewer === null ? CACHE_CONTROL.roundup : CACHE_CONTROL.private);
      reply.header('vary', 'accept-encoding, authorization');
      return serialize(GameweekRoundupSchema, emptyRoundup(event, 'unavailable', events), 'GameweekRoundup');
    }

    const { value, body } = await shared(leagueId, event, official.includes(event), events);
    if (viewer === null) return sendHot(request, reply, body, CACHE_CONTROL.roundup, ['authorization']);
    const entryId = viewer.user.entryId === null ? null : FplEntryIdSchema.parse(viewer.user.entryId);
    const mine =
      entryId !== null && value.status === 'ready' ? await mineRow(value, leagueId, entryId, request) : null;
    if (mine === null) return sendHot(request, reply, body, CACHE_CONTROL.private, ['authorization']);
    reply.header('cache-control', CACHE_CONTROL.private).header('vary', 'authorization');
    return serialize(
      GameweekRoundupSchema,
      { ...value, captains: sortCaptains([...value.captains, mine]) },
      'GameweekRoundup',
    );
  });

  /**
   * GET /v1/league/season-captains — the season Captain Battle leaderboard, from the stored roundups only. Public and
   * identical for everybody: computed once per minute (ctx.hot) and sent as a precomputed body.
   */
  app.get('/v1/league/season-captains', async (request, reply) => {
    const leagueId = await ctx.hot.leagueId();
    const { body } = await ctx.hot.cache.get(
      `${SEASON_CAPTAINS_HOT_PREFIX}${leagueId ?? 'none'}`,
      SEASON_POLICY,
      async () => ({
        build: () => computeSeasonCaptains(ctx.prisma, leagueId, ctx.clock.now()),
      }),
    );
    return sendHot(request, reply, body, CACHE_CONTROL.roundup);
  });
}
