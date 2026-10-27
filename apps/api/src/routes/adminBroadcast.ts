import {
  BroadcastBodySchema,
  BroadcastHistorySchema,
  BroadcastResultSchema,
  BroadcastTargetResultSchema,
  BroadcastTargetSchema,
  BroadcastTargetsStatusSchema,
  type BroadcastTargetResult,
} from '@fant/shared';
import type { Broadcast } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import { PUBLISHERS, precheckBroadcast, runBroadcast } from '../broadcast/publishers.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parseInput, serialize } from '../validate.js';

export const BROADCAST_HISTORY_LIMIT = 50;

const StoredResultsSchema = z.array(BroadcastTargetResultSchema);

function storedResults(row: Broadcast): BroadcastTargetResult[] {
  const parsed = StoredResultsSchema.safeParse(row.results);
  return parsed.success ? parsed.data : [];
}

/** Admin live broadcasts (goal alerts etc.). Every route re-checks the ADMIN role first. */
export function adminBroadcastRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: Auth,
  broadcastLimit: object,
): void {
  const { prisma } = ctx;

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.get('/v1/admin/broadcast/targets', async () => {
      const targets = await Promise.all(
        BroadcastTargetSchema.options.map(async (target) => ({
          target,
          ...(await PUBLISHERS[target].status(ctx)),
        })),
      );
      return serialize(BroadcastTargetsStatusSchema, { targets });
    });

    admin.post('/v1/admin/broadcast', { config: { rateLimit: broadcastLimit } }, async (request, reply) => {
      const { user } = await auth.requireAdmin(request);
      const body = parseInput(BroadcastBodySchema, request.body);
      const title = body.title === undefined || body.title === null || body.title === '' ? null : body.title;
      const uploadId = body.uploadId ?? null;
      // Target prechecks (X length) before anything is created, claimed or sent.
      precheckBroadcast({ text: body.text, targets: body.targets });

      const credential = await prisma.adminCredential.findUnique({ where: { userId: user.id } });
      const now = ctx.clock.now();
      const { broadcast, upload } = await prisma.$transaction(async (tx) => {
        let claimed = null;
        if (uploadId !== null) {
          const result = await tx.upload.updateMany({
            where: { id: uploadId, ownerId: user.id, usedAt: null },
            data: { usedAt: now },
          });
          if (result.count === 0) throw badRequest('uploadId: unknown upload, not yours, or already used');
          claimed = await tx.upload.findUniqueOrThrow({ where: { id: uploadId } });
        }
        const created = await tx.broadcast.create({
          data: {
            title,
            text: body.text,
            uploadId,
            targets: body.targets,
            results: [],
            sentById: user.id,
            sentByName: credential?.username ?? user.name,
            createdAt: now,
          },
        });
        return { broadcast: created, upload: claimed };
      });

      const results = await runBroadcast(
        ctx,
        { id: broadcast.id, title, text: body.text, upload, targets: body.targets },
        (target, err) =>
          request.log.error({ err, target, broadcastId: broadcast.id }, 'broadcast target failed'),
      );
      await prisma.broadcast.update({ where: { id: broadcast.id }, data: { results } });
      return reply.code(201).send(
        serialize(BroadcastResultSchema, {
          id: broadcast.id,
          results,
          createdAt: broadcast.createdAt.toISOString(),
        }),
      );
    });

    admin.get('/v1/admin/broadcasts', async () => {
      const rows = await prisma.broadcast.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BROADCAST_HISTORY_LIMIT,
      });
      return serialize(BroadcastHistorySchema, {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          text: row.text,
          sentBy: row.sentByName,
          results: storedResults(row),
          createdAt: row.createdAt.toISOString(),
        })),
      });
    });
  });
}
