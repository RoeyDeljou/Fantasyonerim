import {
  DeleteAccountBodySchema,
  MeSchema,
  RedeemAdminInviteBodySchema,
  UpdateMeBodySchema,
} from '@fant/shared';
import { claimInvite } from '../auth/invites.js';
import { deleteAccount } from '../account/deleteAccount.js';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { conflict, forbidden } from '../errors.js';
import { toMe } from '../serializers.js';
import { parseInput, serialize } from '../validate.js';
import { EMAIL_TAKEN, isUniqueViolationOn } from './email.js';

export function meRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: Auth,
  writeLimit: object,
  redeemLimit: object,
): void {
  app.get('/v1/me', async (request) => {
    const { user } = await auth.requireUser(request);
    return toMe(user);
  });

  app.patch('/v1/me', async (request) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(UpdateMeBodySchema, request.body ?? {});
    // A banned user's name shows on all their (still visible) content: they can't change it while banned.
    if (body.name !== undefined && user.bannedAt !== null)
      throw forbidden("Your account can't change its name right now");
    // Email (the one-time pop-up for older accounts, or a change in Profile): allowed while banned — it only
    // affects how the user signs back in. Unique across accounts; the unique index decides any race.
    if (body.email !== undefined && body.email !== user.email) {
      const owner = await ctx.prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
      if (owner !== null && owner.id !== user.id) throw conflict(EMAIL_TAKEN);
    }
    let updated;
    try {
      updated = await ctx.prisma.user.update({
        where: { id: user.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
        },
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'email')) throw conflict(EMAIL_TAKEN);
      throw err;
    }
    ctx.forgetUser(user.id);
    return serialize(MeSchema, toMe(updated));
  });

  // Permanent account deletion (App Store 5.1.1(v)). Allowed while banned: it only removes the user's own data.
  app.delete('/v1/me', { config: { rateLimit: writeLimit } }, async (request, reply) => {
    const { user } = await auth.requireUser(request);
    parseInput(DeleteAccountBodySchema, request.body);
    await deleteAccount(ctx, user.id);
    ctx.forgetUser(user.id);
    return reply.code(204).send();
  });

  // An existing account redeems an admin invite link → becomes an admin (claim + role change in one transaction).
  app.post('/v1/me/admin-invite', { config: { rateLimit: redeemLimit } }, async (request) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(RedeemAdminInviteBodySchema, request.body);
    if (user.bannedAt !== null) throw forbidden("A banned account can't become an admin");
    if (user.role === 'ADMIN') throw conflict('You are already an admin');
    const updated = await ctx.prisma.$transaction(async (tx) => {
      await claimInvite(tx, body.token, user, ctx.clock.now());
      return tx.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    });
    ctx.forgetUser(user.id);
    return serialize(MeSchema, toMe(updated));
  });
}
