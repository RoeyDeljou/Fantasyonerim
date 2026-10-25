import { MeSchema, RecoveryCodeResponseSchema, UpdateMeBodySchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { decryptSecret } from '../secrets.js';
import { toMe } from '../serializers.js';
import { parseInput, serialize } from '../validate.js';

export function meRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  app.get('/v1/me', async (request) => {
    const { user } = await auth.requireUser(request);
    return toMe(user);
  });

  app.patch('/v1/me', async (request) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(UpdateMeBodySchema, request.body ?? {});
    const updated = await ctx.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
      },
    });
    return serialize(MeSchema, toMe(updated));
  });

  app.get('/v1/me/recovery-code', async (request, reply) => {
    const { user } = await auth.requireUser(request);
    if (!user.recoveryCodeEnc) throw notFound('This account has no recovery code');
    reply.header('cache-control', 'no-store');
    return serialize(RecoveryCodeResponseSchema, {
      recoveryCode: decryptSecret(ctx.config.secretsKey, user.recoveryCodeEnc),
    });
  });
}
