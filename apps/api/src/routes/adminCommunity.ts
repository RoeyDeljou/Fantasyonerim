import {
  AdminUserListSchema,
  BanBodySchema,
  ReportListSchema,
  ReportReasonSchema,
  ResolveReportBodySchema,
  UserIdSchema,
  type ReportReason,
} from '@fant/shared';
import type { Prisma, Report, ReportTargetKind } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import {
  decodeTargetId,
  encodeTargetId,
  resolveReports,
  softDeleteComment,
  softDeletePost,
  purgeDeletedPostImages,
} from '../community/moderation.js';
import { COMMENT_INCLUDE, POST_INCLUDE, toComment, toPosts } from '../community/serialize.js';
import { cleanPlainText } from '../community/text.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { parseInput, serialize } from '../validate.js';
import { cleanQuery } from './query.js';

// Query/param wrappers (the contract has no query DTOs for these).
const ReportsQuerySchema = z.object({ status: z.literal('open').default('open') });
const TargetParamsSchema = z.object({ targetId: z.string().min(1).max(120) });
const UsersQuerySchema = z.object({ query: z.string().trim().max(100).optional() });
const UserParamsSchema = z.object({ id: UserIdSchema });

export const ADMIN_USERS_PAGE = 50;
export const MAX_REPORT_GROUPS = 200;

/** Moderation: report queue, users list, bans. Every route re-checks the ADMIN role first. */
export function adminCommunityRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  const { prisma } = ctx;

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.get('/v1/admin/reports', async (request) => {
      const { user } = await auth.requireAdmin(request);
      parseInput(ReportsQuerySchema, cleanQuery(request.query));
      const open = await prisma.report.findMany({
        where: { isOpen: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const groups = new Map<string, { kind: ReportTargetKind; id: string; reports: Report[] }>();
      for (const r of open) {
        const key = encodeTargetId(r.targetKind, r.targetId);
        const group = groups.get(key) ?? { kind: r.targetKind, id: r.targetId, reports: [] };
        group.reports.push(r);
        groups.set(key, group);
      }
      const idsOf = (kind: ReportTargetKind) =>
        [...groups.values()].filter((g) => g.kind === kind).map((g) => g.id);

      const postRows = await prisma.communityPost.findMany({
        where: { id: { in: idsOf('post') }, deletedAt: null },
        include: POST_INCLUDE,
      });
      const posts = new Map((await toPosts(prisma, postRows, user.id)).map((p) => [p.id as string, p]));
      const commentRows = await prisma.comment.findMany({
        where: { id: { in: idsOf('comment') }, deletedAt: null, post: { deletedAt: null } },
        include: COMMENT_INCLUDE,
      });
      const comments = new Map(commentRows.map((c) => [c.id, toComment(c, user.id)]));

      const items = [...groups.entries()].flatMap(([targetId, g]) => {
        const target =
          g.kind === 'post'
            ? posts.has(g.id)
              ? { kind: 'post' as const, post: posts.get(g.id) }
              : null
            : comments.has(g.id)
              ? { kind: 'comment' as const, comment: comments.get(g.id) }
              : null;
        // Content deleted outside moderation has its reports closed; skip any stragglers.
        if (target === null) return [];
        const counts = new Map<ReportReason, number>();
        for (const r of g.reports) {
          const reason = ReportReasonSchema.safeParse(r.reason);
          const key = reason.success ? reason.data : 'other';
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const first = g.reports[0];
        return [
          {
            targetId,
            target,
            reportCount: g.reports.length,
            reasons: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason]) => reason),
            notes: g.reports.flatMap((r) => (r.note === null || r.note === '' ? [] : [r.note])),
            firstReportedAt: (first?.createdAt ?? ctx.clock.now()).toISOString(),
          },
        ];
      });
      // Most-reported first, then the longest-waiting.
      items.sort(
        (a, b) => b.reportCount - a.reportCount || a.firstReportedAt.localeCompare(b.firstReportedAt),
      );
      return serialize(ReportListSchema, { items: items.slice(0, MAX_REPORT_GROUPS) });
    });

    admin.post('/v1/admin/reports/:targetId/resolve', async (request, reply) => {
      const { user } = await auth.requireAdmin(request);
      const { targetId } = parseInput(TargetParamsSchema, request.params);
      const target = decodeTargetId(targetId);
      const { action } = parseInput(ResolveReportBodySchema, request.body);
      const now = ctx.clock.now();
      const resolved = await prisma.$transaction(async (tx) => {
        const openCount = await tx.report.count({
          where: { isOpen: true, targetKind: target.kind, targetId: target.id },
        });
        if (openCount === 0) return false;
        if (action === 'remove') {
          if (target.kind === 'post') {
            await softDeletePost(tx, target.id, user.id, 'removed', now);
          } else {
            const comment = await tx.comment.findUnique({ where: { id: target.id } });
            if (comment !== null) await softDeleteComment(tx, comment, user.id, 'removed', now);
          }
        }
        // remove: anything left open on the target (e.g. it was already deleted) is closed as removed.
        await resolveReports(
          tx,
          [{ kind: target.kind, ids: [target.id] }],
          action === 'remove' ? 'removed' : 'dismissed',
          user.id,
          now,
        );
        return true;
      });
      if (!resolved) throw notFound('There are no open reports for this target');
      if (action === 'remove' && target.kind === 'post') {
        await purgeDeletedPostImages(prisma, ctx.media, [target.id]);
      }
      return reply.code(204).send();
    });

    admin.get('/v1/admin/users', async (request) => {
      const { query } = parseInput(UsersQuerySchema, cleanQuery(request.query));
      const where: Prisma.UserWhereInput = {};
      if (query !== undefined && query !== '') {
        const or: Prisma.UserWhereInput[] = [
          { name: { contains: query, mode: 'insensitive' } },
          { teamName: { contains: query, mode: 'insensitive' } },
        ];
        if (/^\d{1,8}$/.test(query)) or.push({ entryId: Number(query) });
        where.OR = or;
      }
      const users = await prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ADMIN_USERS_PAGE,
        include: { _count: { select: { posts: { where: { deletedAt: null } } } } },
      });
      return serialize(AdminUserListSchema, {
        items: users.map((u) => ({
          id: u.id,
          name: u.name,
          entryId: u.entryId,
          teamName: u.teamName,
          role: u.role === 'ADMIN' ? 'admin' : 'user',
          bannedAt: u.bannedAt === null ? null : u.bannedAt.toISOString(),
          banReason: u.banReason,
          postCount: u._count.posts,
          createdAt: u.createdAt.toISOString(),
        })),
      });
    });

    admin.post('/v1/admin/users/:id/ban', async (request, reply) => {
      const { id } = parseInput(UserParamsSchema, request.params);
      const body = parseInput(BanBodySchema, request.body);
      const reason = cleanPlainText(body.reason, 'reason');
      const target = await prisma.user.findUnique({ where: { id } });
      if (target === null) throw notFound('This user does not exist');
      if (target.role === 'ADMIN') throw badRequest("Admins can't be banned");
      await prisma.user.update({
        where: { id },
        data: { bannedAt: target.bannedAt ?? ctx.clock.now(), banReason: reason },
      });
      return reply.code(204).send();
    });

    admin.delete('/v1/admin/users/:id/ban', async (request, reply) => {
      const { id } = parseInput(UserParamsSchema, request.params);
      const updated = await prisma.user.updateMany({
        where: { id },
        data: { bannedAt: null, banReason: null },
      });
      if (updated.count === 0) throw notFound('This user does not exist');
      return reply.code(204).send();
    });
  });
}
