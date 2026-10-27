import {
  AdminLoginBodySchema,
  AuthResponseSchema,
  RecoverBodySchema,
  RegisterBodySchema,
  type EntrySummary,
} from '@fant/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { hashSecret, verifyAgainstDummy, verifySecret } from '../auth/passwords.js';
import { claimInvite } from '../auth/invites.js';
import type { Auth } from '../auth/session.js';
import { generateRecoveryCode, normalizeRecoveryCode } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import { isFplNotFound } from '../fplErrors.js';
import { encryptSecret } from '../secrets.js';
import { toMe } from '../serializers.js';
import { parseInput, serialize } from '../validate.js';

const ALREADY_REGISTERED =
  'This Team ID is already registered. Sign in on this device with your recovery code (Profile → Recovery code on your other device).';

export function authRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, strictLimit: object): void {
  const { prisma } = ctx;

  app.post('/v1/auth/register', { config: { rateLimit: strictLimit } }, async (request, reply) => {
    const body = parseInput(RegisterBodySchema, request.body);

    let entry: EntrySummary;
    try {
      entry = await ctx.fpl.getEntry(body.entryId);
    } catch (err) {
      if (isFplNotFound(err)) {
        throw notFound(
          `We couldn't find an FPL team with ID ${body.entryId}. Check the number and try again.`,
        );
      }
      throw err;
    }

    if (await prisma.user.findUnique({ where: { entryId: body.entryId }, select: { id: true } })) {
      throw conflict(ALREADY_REGISTERED);
    }

    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashSecret(recoveryCode);
    const inviteToken = body.inviteToken;
    let user;
    try {
      // With an invite: the account is created as an admin and the invite claimed in ONE transaction — an
      // invalid/used/expired/revoked invite rolls the whole thing back (never a silent fan account).
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: body.name,
            entryId: body.entryId,
            teamName: entry.teamName,
            locale: body.locale ?? 'he',
            role: inviteToken === undefined ? 'USER' : 'ADMIN',
            recoveryCodeHash,
            recoveryCodeEnc: encryptSecret(ctx.config.secretsKey, recoveryCode),
          },
        });
        if (inviteToken !== undefined) await claimInvite(tx, inviteToken, created, ctx.clock.now());
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(ALREADY_REGISTERED);
      }
      throw err;
    }

    const token = await auth.issueSession(user.id, request);
    return reply.code(201).send(serialize(AuthResponseSchema, { token, user: toMe(user) }));
  });

  app.post('/v1/auth/recover', { config: { rateLimit: strictLimit } }, async (request) => {
    const body = parseInput(RecoverBodySchema, request.body);
    const code = normalizeRecoveryCode(body.recoveryCode);
    const user = await prisma.user.findUnique({ where: { entryId: body.entryId } });
    const ok = user?.recoveryCodeHash
      ? await verifySecret(user.recoveryCodeHash, code)
      : await verifyAgainstDummy(code);
    if (!user || !ok) throw unauthorized('Team ID or recovery code is incorrect');
    const token = await auth.issueSession(user.id, request);
    return serialize(AuthResponseSchema, { token, user: toMe(user) });
  });

  app.post('/v1/auth/admin-login', { config: { rateLimit: strictLimit } }, async (request) => {
    const body = parseInput(AdminLoginBodySchema, request.body);
    const credential = await prisma.adminCredential.findUnique({
      where: { username: body.username },
      include: { user: true },
    });
    const ok = credential
      ? await verifySecret(credential.passwordHash, body.password)
      : await verifyAgainstDummy(body.password);
    if (!credential || !ok || credential.user.role !== 'ADMIN') {
      throw unauthorized('Invalid username or password');
    }
    const token = await auth.issueSession(credential.userId, request);
    return serialize(AuthResponseSchema, { token, user: toMe(credential.user) });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const { session } = await auth.requireUser(request);
    await prisma.session.deleteMany({ where: { id: session.id } });
    return reply.code(204).send();
  });
}
