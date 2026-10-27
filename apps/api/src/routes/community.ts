import {
  CommentIdSchema,
  CommentPageSchema,
  CommentSchema,
  CommunityPageQuerySchema,
  CommunityPageSchema,
  CommunityPostSchema,
  CreateCommentBodySchema,
  CreatePostBodySchema,
  FplEntryIdSchema,
  LikeResultSchema,
  PostIdSchema,
  ReportBodySchema,
  TeamSnapshotSchema,
  type Gameweek,
  type TeamSnapshot,
} from '@fant/shared';
import { Prisma, type ReportTargetKind, type User } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import { requireWriter } from '../community/guard.js';
import { softDeleteComment, softDeletePost } from '../community/moderation.js';
import { COMMENT_INCLUDE, POST_INCLUDE, toComment, toPost, toPosts } from '../community/serialize.js';
import { cleanPlainText } from '../community/text.js';
import type { AppContext } from '../context.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isFplNotFound } from '../fplErrors.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { commentCopy } from '../push/copy.js';
import { notify } from '../push/notify.js';
import { parseInput, serialize } from '../validate.js';
import { cleanQuery } from './query.js';

const PostParamsSchema = z.object({ id: PostIdSchema });
const CommentParamsSchema = z.object({ id: CommentIdSchema });
/** Comment pages take the same cursor/limit as post pages (no author filter). */
const CommentPageQuerySchema = CommunityPageQuerySchema.omit({ authorId: true });

export interface CommunityLimits {
  posts: object;
  comments: object;
  writes: object;
}

/** Freezes the author's FPL team for a started GW (FPL only exposes picks after the deadline). */
export async function takeTeamSnapshot(ctx: AppContext, user: User, event: Gameweek): Promise<TeamSnapshot> {
  if (user.entryId === null) throw badRequest('shareTeamEvent: your account has no FPL team to share');
  const bootstrap = await ctx.fpl.getBootstrap();
  const current = bootstrap.currentEvent;
  if (current === null || event > current) {
    throw badRequest(
      `shareTeamEvent: gameweek ${event} hasn't started yet — a team can be shared once its deadline has passed`,
    );
  }
  const entryId = FplEntryIdSchema.parse(user.entryId);
  try {
    const [picks, entry] = await Promise.all([
      ctx.fpl.getEntryPicks(entryId, event),
      ctx.fpl.getEntry(entryId),
    ]);
    if (picks.picks.length !== 15) {
      throw badRequest(`shareTeamEvent: no complete team for gameweek ${event}`);
    }
    return serialize(
      TeamSnapshotSchema,
      {
        entryId,
        event,
        teamName: entry.teamName,
        managerName: entry.managerName,
        points: picks.points,
        overallRank: picks.overallRank,
        activeChip: picks.activeChip,
        picks: [...picks.picks].sort((a, b) => a.slot - b.slot),
      },
      'TeamSnapshot',
    );
  } catch (err) {
    if (isFplNotFound(err)) throw badRequest(`shareTeamEvent: your team has no picks for gameweek ${event}`);
    throw err;
  }
}

export function communityRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: Auth,
  limits: CommunityLimits,
): void {
  const { prisma } = ctx;

  async function viewerId(request: FastifyRequest): Promise<string | null> {
    return (await auth.resolve(request))?.user.id ?? null;
  }

  async function livePost(id: string) {
    const post = await prisma.communityPost.findFirst({ where: { id, deletedAt: null } });
    if (post === null) throw notFound('This post does not exist');
    return post;
  }

  // ---------- posts ----------
  app.get('/v1/community/posts', async (request) => {
    const query = parseInput(CommunityPageQuerySchema, cleanQuery(request.query));
    const where: Prisma.CommunityPostWhereInput = { deletedAt: null };
    if (query.authorId !== undefined) where.authorId = query.authorId;
    if (query.cursor !== undefined) {
      const c = decodeCursor(query.cursor);
      where.OR = [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }];
    }
    const rows = await prisma.communityPost.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: POST_INCLUDE,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return serialize(CommunityPageSchema, {
      items: await toPosts(prisma, page, await viewerId(request)),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    });
  });

  app.get('/v1/community/posts/:id', async (request) => {
    const { id } = parseInput(PostParamsSchema, request.params);
    const row = await prisma.communityPost.findFirst({
      where: { id, deletedAt: null },
      include: POST_INCLUDE,
    });
    if (row === null) throw notFound('This post does not exist');
    const [post] = await toPosts(prisma, [row], await viewerId(request));
    return serialize(CommunityPostSchema, post);
  });

  app.post('/v1/community/posts', { config: { rateLimit: limits.posts } }, async (request, reply) => {
    const { user } = await requireWriter(auth, request);
    const body = parseInput(CreatePostBodySchema, request.body);
    const text = cleanPlainText(body.text, 'text');
    const uploadId = body.uploadId ?? null;
    const team = body.shareTeamEvent ? await takeTeamSnapshot(ctx, user, body.shareTeamEvent) : null;
    const now = ctx.clock.now();
    const row = await prisma.$transaction(async (tx) => {
      if (uploadId !== null) {
        const claimed = await tx.upload.updateMany({
          where: { id: uploadId, ownerId: user.id, usedAt: null },
          data: { usedAt: now },
        });
        if (claimed.count === 0) throw badRequest('uploadId: unknown upload, not yours, or already used');
      }
      return tx.communityPost.create({
        data: {
          authorId: user.id,
          text,
          imageUploadId: uploadId,
          ...(team === null ? {} : { teamSnapshot: team }),
          createdAt: now,
        },
        include: POST_INCLUDE,
      });
    });
    return reply.code(201).send(serialize(CommunityPostSchema, toPost(row, user.id, false)));
  });

  app.delete('/v1/community/posts/:id', { config: { rateLimit: limits.writes } }, async (request, reply) => {
    const { user } = await auth.requireUser(request); // banned users may still remove their own content;
    const { id } = parseInput(PostParamsSchema, request.params);
    const post = await livePost(id);
    const own = post.authorId === user.id;
    if (!own && user.role !== 'ADMIN') throw forbidden('You can only delete your own posts');
    const now = ctx.clock.now();
    await prisma.$transaction((tx) => softDeletePost(tx, id, user.id, own ? 'deleted' : 'removed', now));
    return reply.code(204).send();
  });

  // ---------- likes ----------
  app.put('/v1/community/posts/:id/like', { config: { rateLimit: limits.writes } }, async (request) => {
    const { user } = await requireWriter(auth, request);
    const { id } = parseInput(PostParamsSchema, request.params);
    await livePost(id);
    const likeCount = await prisma.$transaction(async (tx) => {
      const inserted = await tx.postLike.createMany({
        data: [{ postId: id, userId: user.id, createdAt: ctx.clock.now() }],
        skipDuplicates: true,
      });
      if (inserted.count > 0) {
        return (await tx.communityPost.update({ where: { id }, data: { likeCount: { increment: 1 } } }))
          .likeCount;
      }
      return (await tx.communityPost.findUniqueOrThrow({ where: { id } })).likeCount;
    });
    return serialize(LikeResultSchema, { likeCount, likedByMe: true });
  });

  app.delete('/v1/community/posts/:id/like', { config: { rateLimit: limits.writes } }, async (request) => {
    const { user } = await requireWriter(auth, request);
    const { id } = parseInput(PostParamsSchema, request.params);
    await livePost(id);
    const likeCount = await prisma.$transaction(async (tx) => {
      const removed = await tx.postLike.deleteMany({ where: { postId: id, userId: user.id } });
      if (removed.count > 0) {
        await tx.communityPost.updateMany({
          where: { id, likeCount: { gt: 0 } },
          data: { likeCount: { decrement: 1 } },
        });
      }
      return (await tx.communityPost.findUniqueOrThrow({ where: { id } })).likeCount;
    });
    return serialize(LikeResultSchema, { likeCount, likedByMe: false });
  });

  // ---------- comments ----------
  app.get('/v1/community/posts/:id/comments', async (request) => {
    const { id } = parseInput(PostParamsSchema, request.params);
    const query = parseInput(CommentPageQuerySchema, cleanQuery(request.query));
    await livePost(id);
    const where: Prisma.CommentWhereInput = { postId: id, deletedAt: null };
    if (query.cursor !== undefined) {
      const c = decodeCursor(query.cursor);
      where.OR = [{ createdAt: { gt: c.at } }, { createdAt: c.at, id: { gt: c.id } }];
    }
    const rows = await prisma.comment.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      include: COMMENT_INCLUDE,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const viewer = await viewerId(request);
    return serialize(CommentPageSchema, {
      items: page.map((row) => toComment(row, viewer)),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    });
  });

  app.post(
    '/v1/community/posts/:id/comments',
    { config: { rateLimit: limits.comments } },
    async (request, reply) => {
      const { user } = await requireWriter(auth, request);
      const { id } = parseInput(PostParamsSchema, request.params);
      const body = parseInput(CreateCommentBodySchema, request.body);
      const text = cleanPlainText(body.text, 'text');
      const post = await livePost(id);
      const now = ctx.clock.now();
      const comment = await prisma.$transaction(async (tx) => {
        const bumped = await tx.communityPost.updateMany({
          where: { id, deletedAt: null },
          data: { commentCount: { increment: 1 } },
        });
        if (bumped.count === 0) throw notFound('This post does not exist');
        return tx.comment.create({
          data: { postId: id, authorId: user.id, text, createdAt: now },
          include: COMMENT_INCLUDE,
        });
      });

      if (post.authorId !== user.id) {
        try {
          await notify(ctx, {
            to: [post.authorId],
            pref: 'community',
            dedupeKeys: [`comment:${comment.id}`],
            build: ({ locale }) => ({
              ...commentCopy(locale, user.name, text),
              url: `/community/?post=${encodeURIComponent(id)}`,
              tag: `comments-${id}`,
              icon: PUSH_ICON,
              image: null,
            }),
          });
        } catch (err) {
          request.log.error({ err }, 'comment push failed');
        }
      }
      return reply.code(201).send(serialize(CommentSchema, toComment(comment, user.id)));
    },
  );

  app.delete(
    '/v1/community/comments/:id',
    { config: { rateLimit: limits.writes } },
    async (request, reply) => {
      const { user } = await auth.requireUser(request); // banned users may still remove their own content;
      const { id } = parseInput(CommentParamsSchema, request.params);
      const comment = await prisma.comment.findFirst({
        where: { id, deletedAt: null, post: { deletedAt: null } },
      });
      if (comment === null) throw notFound('This comment does not exist');
      const own = comment.authorId === user.id;
      if (!own && user.role !== 'ADMIN') throw forbidden('You can only delete your own comments');
      const now = ctx.clock.now();
      await prisma.$transaction((tx) =>
        softDeleteComment(tx, comment, user.id, own ? 'deleted' : 'removed', now),
      );
      return reply.code(204).send();
    },
  );

  // ---------- reports ----------
  async function report(request: FastifyRequest, kind: ReportTargetKind, targetId: string) {
    const { user } = await requireWriter(auth, request);
    const body = parseInput(ReportBodySchema, request.body);
    const note = body.note === undefined ? '' : cleanPlainText(body.note, 'note');
    const target =
      kind === 'post'
        ? await prisma.communityPost.findFirst({ where: { id: targetId, deletedAt: null } })
        : await prisma.comment.findFirst({
            where: { id: targetId, deletedAt: null, post: { deletedAt: null } },
          });
    if (target === null) throw notFound(`This ${kind} does not exist`);
    if (target.authorId === user.id) throw badRequest(`You can't report your own ${kind}`);
    const open = { isOpen: true, targetKind: kind, targetId, reporterId: user.id };
    if ((await prisma.report.count({ where: open })) > 0) return;
    try {
      await prisma.report.create({
        data: { ...open, reason: body.reason, note: note === '' ? null : note, createdAt: ctx.clock.now() },
      });
    } catch (err) {
      // A concurrent duplicate: the open report already exists, which is the idempotent outcome.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }

  app.post(
    '/v1/community/posts/:id/report',
    { config: { rateLimit: limits.writes } },
    async (request, reply) => {
      const { id } = parseInput(PostParamsSchema, request.params);
      await report(request, 'post', id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/community/comments/:id/report',
    { config: { rateLimit: limits.writes } },
    async (request, reply) => {
      const { id } = parseInput(CommentParamsSchema, request.params);
      await report(request, 'comment', id);
      return reply.code(204).send();
    },
  );
}
