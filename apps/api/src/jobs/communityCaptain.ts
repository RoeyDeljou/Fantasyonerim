import type { Gameweek, GameweekInfo } from '@fant/shared';
import type { CommunityCaptainResult } from '@prisma/client';
import type { AppContext } from '../context.js';
import {
  STORED_TOP,
  communityPickOf,
  invalidateCaptainCaches,
  leadersOf,
  setCommunityPlayer,
  tallyOf,
} from '../communityCaptain/service.js';
import { TALLY_GRACE_MS, TALLY_MAX_AGE_MS } from '../communityCaptain/window.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { communityCaptainNoVotesCopy, communityCaptainTieCopy } from '../push/copy.js';
import { notify } from '../push/notify.js';
import { MINUTE, type Job } from './types.js';

const ADMIN_URL = '/admin/?card=vote';

/**
 * Tallies the "My Community Captain" vote once a GW's deadline has passed. Only GWs whose deadline passed within
 * the last 24 h and that have no stored result (the result row is the lock: it is inserted once, so a re-run or a
 * second instance does nothing). Per GW, in one transaction:
 * - a community captain already set for that GW by hand wins (the vote never overwrites it): `decided`, source
 *   `admin`, winner = that player;
 * - one clear winner: `decided`, source `votes`, written to the captain battle (created from the latest earlier
 *   battle when the GW has none);
 * - a tie for the top count: `tied` (admins are pushed to break it); nobody voted: `no_votes` (admins pushed).
 * The admin push is deduped per admin, GW and kind, and retried on the next run if it failed after the commit.
 */
export const communityCaptainJob: Job = {
  name: 'community_captain',
  everyMs: 2 * MINUTE,
  async run(ctx) {
    const { app } = ctx;
    const nowMs = app.clock.now().getTime();
    const bootstrap = await app.fpl.getBootstrap();
    const due = bootstrap.events
      .filter((e) => {
        const age = nowMs - Date.parse(e.deadlineTime);
        return age >= TALLY_GRACE_MS && age <= TALLY_MAX_AGE_MS;
      })
      .sort((a, b) => a.id - b.id);
    if (due.length === 0) return { summary: 'no deadline in the last 24 h' };

    const summary: string[] = [];
    let changed = false;
    for (const gw of due) {
      const existing = await app.prisma.communityCaptainResult.findUnique({ where: { event: gw.id } });
      if (existing !== null) {
        if (await notifyIfNeeded(app, bootstrap.players, existing))
          summary.push(`GW${gw.id}: admins notified`);
        continue;
      }
      const row = await decide(app, gw);
      if (row === null) continue; // another instance got there first
      changed = true;
      summary.push(`GW${gw.id}: ${row.status}${row.source ? ` (${row.source})` : ''}`);
      await notifyIfNeeded(app, bootstrap.players, row);
    }
    if (changed) invalidateCaptainCaches(app);
    return { summary: summary.length === 0 ? 'nothing to tally' : summary.join('; ') };
  },
};

/** Stores the result and applies the winner; null when the result row already existed. */
async function decide(app: AppContext, gw: GameweekInfo): Promise<CommunityCaptainResult | null> {
  const now = app.clock.now();
  return app.prisma.$transaction(async (tx) => {
    const tally = await tallyOf(tx, gw.id);
    const leaders = leadersOf(tally);
    const manual = await communityPickOf(tx, gw.id);
    const base = {
      totalVotes: tally.total,
      top: tally.rows.slice(0, STORED_TOP),
      tiedPlayerIds: [] as number[],
      decidedAt: null as Date | null,
      winnerPlayerId: null as number | null,
      source: null as string | null,
      status: 'no_votes',
    };
    let outcome = { ...base };
    let apply: number | null = null;
    if (manual.isSet) {
      // A manual pick always wins; keep it visible as the decided result.
      outcome = {
        ...base,
        status: 'decided',
        source: 'admin',
        winnerPlayerId: manual.playerId,
        decidedAt: now,
      };
    } else if (leaders.length === 1 && leaders[0] !== undefined) {
      apply = leaders[0].playerId;
      outcome = { ...base, status: 'decided', source: 'votes', winnerPlayerId: apply, decidedAt: now };
    } else if (leaders.length > 1) {
      outcome = { ...base, status: 'tied', tiedPlayerIds: leaders.map((l) => l.playerId) };
    }
    const created = await tx.communityCaptainResult.createMany({
      data: [{ event: gw.id, ...outcome }],
      skipDuplicates: true,
    });
    if (created.count === 0) return null;
    if (apply !== null) {
      const set = await setCommunityPlayer(tx, gw.id as Gameweek, apply, now, false);
      if (!set.applied) {
        // A manual pick landed between the check and the write: it wins.
        return tx.communityCaptainResult.update({
          where: { event: gw.id },
          data: { source: 'admin', winnerPlayerId: set.existingPlayerId, decidedAt: now },
        });
      }
    }
    return tx.communityCaptainResult.findUniqueOrThrow({ where: { event: gw.id } });
  });
}

/** Pushes the admins about a tie / empty vote (once); true when it ran now. */
async function notifyIfNeeded(
  app: AppContext,
  players: readonly { id: number; webName: string }[],
  row: CommunityCaptainResult,
): Promise<boolean> {
  if ((row.status !== 'tied' && row.status !== 'no_votes') || row.adminNotifiedAt !== null) return false;
  const admins = await app.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  const names = (Array.isArray(row.tiedPlayerIds) ? row.tiedPlayerIds : []).map(
    (id) => players.find((p) => p.id === id)?.webName ?? `#${String(id)}`,
  );
  await notify(app, {
    kind: 'admin',
    to: admins.map((a) => a.id),
    pref: null,
    dedupeKeys: [`community_captain:${row.event}:${row.status}`],
    build: ({ locale }) => ({
      ...(row.status === 'tied'
        ? communityCaptainTieCopy(locale, row.event, names)
        : communityCaptainNoVotesCopy(locale, row.event)),
      url: ADMIN_URL,
      tag: `community-captain-${row.event}`,
      icon: PUSH_ICON,
      image: null,
    }),
  });
  await app.prisma.communityCaptainResult.updateMany({
    where: { event: row.event, adminNotifiedAt: null },
    data: { adminNotifiedAt: app.clock.now() },
  });
  return true;
}
