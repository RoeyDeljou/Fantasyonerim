import {
  AdminUserEmailBodySchema,
  AdminUserListSchema,
  AdminUserSchema,
  BanBodySchema,
  ReportListSchema,
  ReportReasonSchema,
  ResolveReportBodySchema,
  UserIdSchema,
  type ReportReason,
} from '@fant/shared';
import { Prisma, type Report, type ReportTargetKind, type User } from '@prisma/client';
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
import { clearAvatar } from '../account/avatar.js';
import { COMMENT_INCLUDE, POST_INCLUDE, toComment, toPosts } from '../community/serialize.js';
import { cleanPlainText } from '../community/text.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { mapMediaUrl, type MediaUrlMapper } from '../media/publicUrl.js';
import { parseInput, serialize } from '../validate.js';
import { EMAIL_TAKEN, isUniqueViolationOn } from './email.js';
import { cleanQuery } from './query.js';

// Query/param wrappers (the contract has no query DTOs for these).
const ReportsQuerySchema = z.object({ status: z.literal('open').default('open') });
const TargetParamsSchema = z.object({ targetId: z.string().min(1).max(120) });
const UsersQuerySchema = z.object({ query: z.string().trim().max(100).optional() });
const UserParamsSchema = z.object({ id: UserIdSchema });

export const ADMIN_USERS_PAGE = 50;
export const MAX_REPORT_GROUPS = 200;

function toAdminUser(u: User, postCount: number, mediaUrl: MediaUrlMapper) {
  return {
    id: u.id,
    name: u.name,
    entryId: u.entryId,
    teamName: u.teamName,
    email: u.email,
    role: u.role === 'ADMIN' ? ('admin' as const) : ('user' as const),
    bannedAt: u.bannedAt === null ? null : u.bannedAt.toISOString(),
    banReason: u.banReason,
    postCount,
    // Banned users keep their photo in this admin view (so an admin can see and remove it).
    avatarUrl: mapMediaUrl(mediaUrl, u.avatarUrl),
    createdAt: u.createdAt.toISOString(),
  };
}

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
      const posts = new Map(
        (await toPosts(prisma, postRows, user.id, ctx.mediaUrl)).map((p) => [p.id as string, p]),
      );
      const commentRows = await prisma.comment.findMany({
        where: { id: { in: idsOf('comment') }, deletedAt: null, post: { deletedAt: null } },
        include: COMMENT_INCLUDE,
      });
      const comments = new Map(commentRows.map((c) => [c.id, toComment(c, user.id, ctx.mediaUrl)]));

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
          { email: { contains: query, mode: 'insensitive' } },
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
        items: users.map((u) => toAdminUser(u, u._count.posts, ctx.mediaUrl)),
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
      ctx.forgetUser(id);
      // Banned users are left out of the public league avatars.
      ctx.hot.invalidateAvatars();
      return reply.code(204).send();
    });

    // An admin fixes a user's sign-in email (a typo, or a fan who can't get back in). Null clears it. Returns the
    // updated AdminUser (200).
    admin.put('/v1/admin/users/:id/email', async (request) => {
      const { user: by } = await auth.requireAdmin(request);
      const { id } = parseInput(UserParamsSchema, request.params);
      const { email } = parseInput(AdminUserEmailBodySchema, request.body);
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (target === null) throw notFound('This user does not exist');
      if (email !== null) {
        const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (owner !== null && owner.id !== id) throw conflict(EMAIL_TAKEN);
      }
      let updated;
      try {
        updated = await prisma.user.update({
          where: { id },
          data: { email },
          include: { _count: { select: { posts: { where: { deletedAt: null } } } } },
        });
      } catch (err) {
        if (isUniqueViolationOn(err, 'email')) throw conflict(EMAIL_TAKEN);
        // Deleted between the check and the update.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          throw notFound('This user does not exist');
        }
        throw err;
      }
      ctx.forgetUser(id);
      request.log.info({ userId: id, by: by.id }, 'admin changed a user email');
      return serialize(AdminUserSchema, toAdminUser(updated, updated._count.posts, ctx.mediaUrl));
    });

    // Moderation: removes a user's profile photo (the stored object is deleted best-effort). Returns the updated
    // AdminUser (200), like PUT /v1/admin/users/:id/email. Idempotent: a user without a photo is a no-op.
    admin.delete('/v1/admin/users/:id/avatar', async (request) => {
      const { user: by } = await auth.requireAdmin(request);
      const { id } = parseInput(UserParamsSchema, request.params);
      const updated = await clearAvatar(ctx, id);
      if (updated === null) throw notFound('This user does not exist');
      const postCount = await prisma.communityPost.count({ where: { authorId: id, deletedAt: null } });
      request.log.info({ userId: id, by: by.id }, 'admin removed a profile photo');
      return serialize(AdminUserSchema, toAdminUser(updated, postCount, ctx.mediaUrl));
    });

    admin.delete('/v1/admin/users/:id/ban', async (request, reply) => {
      const { id } = parseInput(UserParamsSchema, request.params);
      const updated = await prisma.user.updateMany({
        where: { id },
        data: { bannedAt: null, banReason: null },
      });
      ctx.forgetUser(id);
      ctx.hot.invalidateAvatars();
      if (updated.count === 0) throw notFound('This user does not exist');
      return reply.code(204).send();
    });
  });
}
