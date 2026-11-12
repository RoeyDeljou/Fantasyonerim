import {
  AdminLoginBodySchema,
  AuthResponseSchema,
  EmailLoginBodySchema,
  RegisterBodySchema,
  type EntrySummary,
} from '@fant/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { verifyAgainstDummy, verifySecret } from '../auth/passwords.js';
import { claimInvite } from '../auth/invites.js';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import { isFplNotFound } from '../fplErrors.js';
import { toMe } from '../serializers.js';
import { parseInput, serialize } from '../validate.js';
import { EMAIL_TAKEN, isUniqueViolationOn } from './email.js';

const ALREADY_REGISTERED = 'This Team ID is already registered. Sign in with your email and Team ID.';
/** One message for every email-login miss: never reveal whether the email or the Team ID was wrong. */
const EMAIL_LOGIN_FAILED = 'Email or Team ID is incorrect';

export function authRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, strictLimit: object): void {
  const { prisma } = ctx;

  app.post('/v1/auth/register', { config: { rateLimit: strictLimit } }, async (request, reply) => {
    const body = parseInput(RegisterBodySchema, request.body);

    // Cheap uniqueness checks first (no FPL call for a request that can't succeed); the unique indexes below
    // still decide any race.
    if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw conflict(EMAIL_TAKEN);
    }
    if (await prisma.user.findUnique({ where: { entryId: body.entryId }, select: { id: true } })) {
      throw conflict(ALREADY_REGISTERED);
    }

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
            email: body.email,
            teamName: entry.teamName,
            locale: body.locale ?? 'he',
            role: inviteToken === undefined ? 'USER' : 'ADMIN',
          },
        });
        if (inviteToken !== undefined) await claimInvite(tx, inviteToken, created, ctx.clock.now());
        return created;
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'email')) throw conflict(EMAIL_TAKEN);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(ALREADY_REGISTERED);
      }
      throw err;
    }

    const token = await auth.issueSession(user.id, request);
    return reply.code(201).send(serialize(AuthResponseSchema, { token, user: toMe(user, ctx.mediaUrl) }));
  });

  // Sign back in (new device, after signing out): the account's email AND its Team ID must both match. Banned users
  // may sign in (read-only, as everywhere). Admin-only accounts have no Team ID, so they can't match here.
  app.post('/v1/auth/email-login', { config: { rateLimit: strictLimit } }, async (request) => {
    const body = parseInput(EmailLoginBodySchema, request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user === null || user.entryId === null || user.entryId !== body.entryId) {
      throw unauthorized(EMAIL_LOGIN_FAILED);
    }
    const token = await auth.issueSession(user.id, request);
    return serialize(AuthResponseSchema, { token, user: toMe(user, ctx.mediaUrl) });
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
    return serialize(AuthResponseSchema, { token, user: toMe(credential.user, ctx.mediaUrl) });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const { session } = await auth.requireUser(request);
    await prisma.session.deleteMany({ where: { id: session.id } });
    ctx.forgetUser(session.userId);
    return reply.code(204).send();
  });
}
