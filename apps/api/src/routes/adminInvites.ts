import {
  AdminInviteCreatedSchema,
  AdminInviteListSchema,
  AdminInvitePreviewSchema,
  AdminInviteSchema,
  CreateAdminInviteBodySchema,
  RedeemAdminInviteBodySchema,
} from '@fant/shared';
import type { AdminInvite } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ADMIN_INVITE_TTL_MS,
  generateInviteToken,
  inviteStatus,
  pendingInviteWhere,
} from '../auth/invites.js';
import type { Auth } from '../auth/session.js';
import { hashToken } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { parseInput, serialize } from '../validate.js';

export const DEFAULT_WEB_APP_URL = 'http://localhost:3000';
const IdParamsSchema = z.object({ id: z.string().min(1).max(100) });
const INVITE_NOT_FOUND = 'This invite link is no longer valid';

export interface InviteLimits {
  /** Per admin, for creating invites. */
  create: object;
  /** Per IP (like sign-in), for the public preview. */
  preview: object;
}

export function adminInviteRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, limits: InviteLimits) {
  const { prisma } = ctx;

  const toDto = (invite: AdminInvite) =>
    serialize(
      AdminInviteSchema,
      {
        id: invite.id,
        label: invite.label,
        createdBy: invite.createdByName,
        createdAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
        usedAt: invite.usedAt?.toISOString() ?? null,
        usedByName: invite.usedByName,
        revokedAt: invite.revokedAt?.toISOString() ?? null,
        status: inviteStatus(invite, ctx.clock.now()),
      },
      'AdminInvite',
    );

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.post('/v1/admin/invites', { config: { rateLimit: limits.create } }, async (request, reply) => {
      const { user } = await auth.requireAdmin(request);
      const body = parseInput(CreateAdminInviteBodySchema, request.body);
      const credential = await prisma.adminCredential.findUnique({ where: { userId: user.id } });
      const now = ctx.clock.now();
      const { token, tokenHash } = generateInviteToken();
      const invite = await prisma.adminInvite.create({
        data: {
          label: body.label,
          tokenHash,
          createdById: user.id,
          createdByName: credential?.username ?? user.name,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ADMIN_INVITE_TTL_MS),
        },
      });
      const base = (ctx.config.webAppUrl ?? DEFAULT_WEB_APP_URL).replace(/\/+$/, '');
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(
        serialize(AdminInviteCreatedSchema, {
          invite: toDto(invite),
          // A fragment: never sent to the web host, so its access logs never see the token.
          url: `${base}/onboarding/#invite=${encodeURIComponent(token)}`,
        }),
      );
    });

    admin.get('/v1/admin/invites', async () => {
      const rows = await prisma.adminInvite.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      return serialize(AdminInviteListSchema, { items: rows.map(toDto) });
    });

    admin.delete('/v1/admin/invites/:id', async (request, reply) => {
      const { id } = parseInput(IdParamsSchema, request.params);
      const now = ctx.clock.now();
      const revoked = await prisma.adminInvite.updateMany({
        where: { id, ...pendingInviteWhere(now) },
        data: { revokedAt: now },
      });
      if (revoked.count === 0) {
        const invite = await prisma.adminInvite.findUnique({ where: { id } });
        if (invite === null) throw notFound('This invite does not exist');
        throw conflict(
          `This invite is already ${inviteStatus(invite, now)} — only pending invites can be revoked`,
        );
      }
      return reply.code(204).send();
    });
  });

  // Public: onboarding shows "You're invited as an admin" before signing up. The token travels in the body (a
  // path/query would land in access logs). One generic 404 for every invalid token, whatever its length.
  app.post('/v1/admin-invites/preview', { config: { rateLimit: limits.preview } }, async (request, reply) => {
    const parsed = RedeemAdminInviteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const raw: unknown = request.body;
      const hasStringToken =
        typeof raw === 'object' && raw !== null && typeof (raw as { token?: unknown }).token === 'string';
      if (hasStringToken) throw notFound(INVITE_NOT_FOUND);
      parseInput(RedeemAdminInviteBodySchema, raw); // → 400 for a missing/non-string token
    }
    const token = parsed.data?.token ?? '';
    const invite = await prisma.adminInvite.findFirst({
      where: { tokenHash: hashToken(token), ...pendingInviteWhere(ctx.clock.now()) },
    });
    if (invite === null) throw notFound(INVITE_NOT_FOUND);
    reply.header('cache-control', 'no-store');
    return serialize(AdminInvitePreviewSchema, {
      label: invite.label,
      expiresAt: invite.expiresAt.toISOString(),
    });
  });
}
