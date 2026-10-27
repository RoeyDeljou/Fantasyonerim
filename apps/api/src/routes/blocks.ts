import { BlockListSchema, UserIdSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { parseInput, serialize } from '../validate.js';

const ParamsSchema = z.object({ userId: UserIdSchema });

/**
 * User blocking (App Store guideline 1.2). One-way and private. Banned users may block too: it only protects
 * them and changes nothing anyone else sees.
 */
export function blockRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, writeLimit: object): void {
  const { prisma } = ctx;

  app.get('/v1/community/blocks', async (request) => {
    const { user } = await auth.requireUser(request);
    const rows = await prisma.userBlock.findMany({
      where: { blockerId: user.id },
      orderBy: [{ createdAt: 'desc' }, { blockedId: 'desc' }],
      include: { blocked: true },
    });
    return serialize(BlockListSchema, {
      items: rows.map((r) => ({
        id: r.blocked.id,
        name: r.blocked.name,
        teamName: r.blocked.teamName,
        blockedAt: r.createdAt.toISOString(),
      })),
    });
  });

  app.put('/v1/community/blocks/:userId', { config: { rateLimit: writeLimit } }, async (request, reply) => {
    const { user } = await auth.requireUser(request);
    const { userId } = parseInput(ParamsSchema, request.params);
    if (userId === user.id) throw badRequest("You can't block yourself");
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (target === null) throw notFound('This user does not exist');
    if (target.role === 'ADMIN') throw badRequest("Admins can't be blocked");
    await prisma.userBlock.createMany({
      data: [{ blockerId: user.id, blockedId: userId, createdAt: ctx.clock.now() }],
      skipDuplicates: true,
    });
    return reply.code(204).send();
  });

  app.delete(
    '/v1/community/blocks/:userId',
    { config: { rateLimit: writeLimit } },
    async (request, reply) => {
      const { user } = await auth.requireUser(request);
      const { userId } = parseInput(ParamsSchema, request.params);
      if (userId === user.id) throw badRequest("You can't block yourself");
      if ((await prisma.user.count({ where: { id: userId } })) === 0)
        throw notFound('This user does not exist');
      await prisma.userBlock.deleteMany({ where: { blockerId: user.id, blockedId: userId } });
      return reply.code(204).send();
    },
  );
}
