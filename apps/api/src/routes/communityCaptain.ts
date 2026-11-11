import {
  AdminCommunityCaptainResolveBodySchema,
  AdminCommunityCaptainSchema,
  CommunityCaptainStateSchema,
  CommunityCaptainVoteBodySchema,
  FplPlayerIdSchema,
  type AdminCommunityCaptain,
  type CommunityCaptainState,
  type Gameweek,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import {
  COMMUNITY_CAPTAIN_HOT_KEY,
  FAN_TOP,
  STORED_TOP,
  communityPickOf,
  invalidateCaptainCaches,
  leadersOf,
  resultOf,
  setCommunityPlayer,
  tallyOf,
} from '../communityCaptain/service.js';
import { RESOLVE_GRACE_MS, displayWindow, targetWindow, windowOf } from '../communityCaptain/window.js';
import { requireWriter } from '../community/guard.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import { parseInput, serialize } from '../validate.js';
import { EventQuerySchema, cleanQuery } from './query.js';

const SHARED_POLICY = { freshMs: 15_000, staleMs: 0, staleIfErrorMs: 30 * 60_000 } as const;

type SharedState = Omit<CommunityCaptainState, 'myPick'>;

/**
 * "My Community Captain": fans vote for the community captain of the next GW (GET/PUT /v1/community-captain); the
 * admin card reads the live tally and breaks ties / picks by hand (/v1/admin/community-captain). The job
 * `community_captain` (jobs/communityCaptain.ts) tallies at the deadline and writes the captain battle.
 */
export function communityCaptainRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: Auth,
  writeLimit: object,
): void {
  const { prisma } = ctx;

  /** The part of the state that is the same for everybody. */
  async function sharedState(): Promise<SharedState> {
    const now = ctx.clock.now();
    const bootstrap = await ctx.fpl.getBootstrap();
    const target = displayWindow(bootstrap.events, now.getTime());
    if (target === null) {
      return {
        event: null,
        status: 'locked',
        opensAfterEvent: null,
        deadline: null,
        voters: 0,
        result: null,
        updatedAt: now.toISOString(),
      };
    }
    const [voters, row] = await Promise.all([
      prisma.communityCaptainVote.count({ where: { event: target.event, user: { bannedAt: null } } }),
      target.status === 'locked'
        ? prisma.communityCaptainResult.findUnique({ where: { event: target.event } })
        : null,
    ]);
    return {
      event: target.event,
      status: target.status,
      opensAfterEvent: target.opensAfterEvent,
      deadline: target.deadline,
      voters,
      result: target.status === 'locked' ? resultOf(row, FAN_TOP) : null,
      updatedAt: now.toISOString(),
    };
  }

  function hotShared() {
    return ctx.hot.cache.get(COMMUNITY_CAPTAIN_HOT_KEY, SHARED_POLICY, async () => {
      const value = await sharedState();
      return {
        build: () =>
          serialize(CommunityCaptainStateSchema, { ...value, myPick: null }, 'CommunityCaptainState'),
      };
    });
  }

  async function stateFor(userId: string): Promise<CommunityCaptainState> {
    const shared = await sharedState();
    const vote =
      shared.event === null
        ? null
        : await prisma.communityCaptainVote.findUnique({
            where: { event_userId: { event: shared.event, userId } },
          });
    return serialize(
      CommunityCaptainStateSchema,
      { ...shared, myPick: vote?.playerId ?? null },
      'CommunityCaptainState',
    );
  }

  app.get('/v1/community-captain', async (request, reply) => {
    const viewer = await auth.resolve(request);
    if (viewer === null) {
      const shared = await hotShared();
      return sendHot(request, reply, shared.body, CACHE_CONTROL.vote, ['authorization']);
    }
    reply.header('cache-control', CACHE_CONTROL.private).header('vary', 'authorization');
    return stateFor(viewer.user.id);
  });

  app.put('/v1/community-captain', { config: { rateLimit: writeLimit } }, async (request, reply) => {
    const { user } = await requireWriter(auth, request);
    const body = parseInput(CommunityCaptainVoteBodySchema, request.body);
    const now = ctx.clock.now();
    const bootstrap = await ctx.fpl.getBootstrap();
    const target = targetWindow(bootstrap.events, now.getTime());
    if (target === null || body.event !== target.event) {
      const asked = windowOf(bootstrap.events, body.event, now.getTime());
      if (asked === null) throw badRequest(`Gameweek ${body.event} does not exist`);
      if (asked.status === 'locked') {
        throw conflict(`Voting for gameweek ${body.event} is closed: its deadline has passed`);
      }
      throw badRequest(
        target === null
          ? 'There is no gameweek to vote for right now'
          : `You can only vote for gameweek ${target.event}`,
      );
    }
    if (target.status === 'not_open') {
      throw conflict(
        `Voting for gameweek ${target.event} opens when gameweek ${target.opensAfterEvent ?? target.event - 1} ends`,
      );
    }
    if (!bootstrap.players.some((p) => p.id === body.playerId)) {
      throw badRequest(`Unknown player id ${body.playerId}`);
    }
    await prisma.communityCaptainVote.upsert({
      where: { event_userId: { event: body.event, userId: user.id } },
      update: { playerId: body.playerId },
      create: { event: body.event, userId: user.id, playerId: body.playerId, createdAt: now },
    });
    reply.header('cache-control', CACHE_CONTROL.private).header('vary', 'authorization');
    return stateFor(user.id);
  });

  // ---------- admin ----------

  async function adminView(event: Gameweek | null): Promise<AdminCommunityCaptain> {
    const now = ctx.clock.now();
    const bootstrap = await ctx.fpl.getBootstrap();
    const window =
      event === null
        ? displayWindow(bootstrap.events, now.getTime())
        : windowOf(bootstrap.events, event, now.getTime());
    if (window === null) {
      if (event !== null) throw notFound(`Gameweek ${event} does not exist`);
      return serialize(
        AdminCommunityCaptainSchema,
        {
          event: null,
          status: 'locked',
          deadline: null,
          totalVotes: 0,
          tally: [],
          result: null,
          battlePlayerId: null,
        },
        'AdminCommunityCaptain',
      );
    }
    const [tally, row, pick] = await Promise.all([
      tallyOf(prisma, window.event),
      prisma.communityCaptainResult.findUnique({ where: { event: window.event } }),
      communityPickOf(prisma, window.event),
    ]);
    return serialize(
      AdminCommunityCaptainSchema,
      {
        event: window.event,
        status: window.status,
        deadline: window.deadline,
        totalVotes: tally.total,
        tally: tally.rows.slice(0, STORED_TOP),
        result:
          row !== null ? resultOf(row, STORED_TOP) : window.status === 'locked' ? resultOf(null, 0) : null,
        battlePlayerId: pick.playerId,
      },
      'AdminCommunityCaptain',
    );
  }

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.get('/v1/admin/community-captain', async (request) => {
      const query = parseInput(EventQuerySchema, cleanQuery(request.query));
      return adminView(query.event ?? null);
    });

    admin.post('/v1/admin/community-captain/resolve', async (request) => {
      const { user } = await auth.requireAdmin(request);
      const body = parseInput(AdminCommunityCaptainResolveBodySchema, request.body);
      const now = ctx.clock.now();
      const bootstrap = await ctx.fpl.getBootstrap();
      const asked = windowOf(bootstrap.events, body.event, now.getTime());
      if (asked === null) throw notFound(`Gameweek ${body.event} does not exist`);
      const target = targetWindow(bootstrap.events, now.getTime());
      const current =
        target?.event === asked.event ||
        displayWindow(bootstrap.events, now.getTime())?.event === asked.event;
      const recent = asked.status === 'locked' && now.getTime() - asked.deadlineMs <= RESOLVE_GRACE_MS;
      if (!current && !recent) {
        throw badRequest(
          `Gameweek ${body.event} can't be resolved: only the gameweek being voted for, or one whose deadline passed in the last 3 days`,
        );
      }
      if (!bootstrap.players.some((p) => p.id === body.playerId)) {
        throw badRequest(`Unknown player id ${body.playerId}`);
      }
      const playerId = FplPlayerIdSchema.parse(body.playerId);
      await prisma.$transaction(async (tx) => {
        // An explicit admin choice overwrites whatever the battle held.
        await setCommunityPlayer(tx, asked.event, playerId, now, true);
        // Before the deadline the vote is still running: only the battle is set (a manual pick, which the
        // job then keeps). From the deadline on the outcome is recorded.
        if (asked.status !== 'locked') return;
        const tally = await tallyOf(tx, asked.event);
        const source = leadersOf(tally).some((r) => r.playerId === playerId) ? 'votes' : 'admin';
        const data = {
          status: 'decided',
          source,
          winnerPlayerId: playerId,
          tiedPlayerIds: [],
          totalVotes: tally.total,
          top: tally.rows.slice(0, STORED_TOP),
          decidedAt: now,
          decidedById: user.id,
        };
        await tx.communityCaptainResult.upsert({
          where: { event: asked.event },
          update: data,
          create: { event: asked.event, ...data },
        });
      });
      invalidateCaptainCaches(ctx);
      return adminView(asked.event);
    });
  });
}
