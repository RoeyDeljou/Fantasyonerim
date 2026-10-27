import {
  AdminAccountSchema,
  AdminSettingsSchema,
  CaptainBattleConfigSchema,
  ChangePasswordBodySchema,
  CreateAdminBodySchema,
} from '@fant/shared';
import { mapWithConcurrency } from '@fant/fpl';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashSecret, verifySecret } from '../auth/passwords.js';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { isFplNotFound } from '../fplErrors.js';
import { getLatestBattle, getSettings, toAdminSettings, toBattleConfig } from '../settings.js';
import { parseInput, serialize } from '../validate.js';

export class AdminUsernameTakenError extends Error {
  constructor(username: string) {
    super(`Admin username "${username}" is already taken`);
    this.name = 'AdminUsernameTakenError';
  }
}

/** Creates an ADMIN user + argon2id credential. Shared by POST /v1/admin/admins and the env bootstrap. */
export async function createAdmin(
  prisma: PrismaClient,
  input: { username: string; password: string; name: string },
): Promise<{ userId: string; username: string; name: string }> {
  const passwordHash = await hashSecret(input.password);
  try {
    const user = await prisma.user.create({
      data: {
        name: input.name,
        role: 'ADMIN',
        adminCredential: { create: { username: input.username, passwordHash } },
      },
    });
    return { userId: user.id, username: input.username, name: user.name };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AdminUsernameTakenError(input.username);
    }
    throw err;
  }
}

/**
 * Every route in this scope re-checks the ADMIN role before anything else (incl. body parsing).
 * `passwordLimit` is the login rate limit (per IP), applied to the password change too.
 */
export function adminRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, passwordLimit: object): void {
  const { prisma } = ctx;

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.get('/v1/admin/settings', async () => toAdminSettings(await getSettings(prisma)));

    admin.put('/v1/admin/settings', async (request) => {
      const body = parseInput(AdminSettingsSchema, request.body);
      const current = await getSettings(prisma);
      let leagueName = body.leagueId === null ? null : current.leagueName;
      if (body.leagueId !== null && (body.leagueId !== current.leagueId || current.leagueName === null)) {
        try {
          const standings = await ctx.fpl.getLeagueStandings(body.leagueId, 1);
          leagueName = standings.league.name;
        } catch (err) {
          if (isFplNotFound(err)) throw notFound(`FPL league ${body.leagueId} was not found`);
          throw err;
        }
      }
      const updated = await prisma.appSettings.update({
        where: { id: current.id },
        data: {
          leagueId: body.leagueId,
          leagueName,
          deadlineReminderMinutes: [...new Set(body.deadlineReminderMinutes)].sort((a, b) => b - a),
          spotifyUrl: body.socials.spotifyUrl,
          appleUrl: body.socials.appleUrl,
          instagramUrl: body.socials.instagramUrl,
          xUrl: body.socials.xUrl,
          whatsappUrl: body.socials.whatsappUrl,
        },
      });
      return toAdminSettings(updated);
    });

    admin.get('/v1/admin/captain-battle', async (_request, reply) => {
      const battle = await getLatestBattle(prisma);
      // Explicit JSON null: Fastify would otherwise send an empty body for `null`.
      if (!battle) return reply.type('application/json').send('null');
      return toBattleConfig(battle);
    });

    admin.put('/v1/admin/captain-battle', async (request) => {
      const body = parseInput(CaptainBattleConfigSchema, request.body);
      const playerIds = body.entries.flatMap((e) => (e.source === 'player' ? [e.playerId] : []));
      const entryIds = [...new Set(body.entries.flatMap((e) => (e.source === 'entry' ? [e.entryId] : [])))];
      if (playerIds.length > 0) {
        const bootstrap = await ctx.fpl.getBootstrap();
        const known = new Set<number>(bootstrap.players.map((p) => p.id));
        const unknown = playerIds.filter((id) => !known.has(id));
        if (unknown.length > 0) throw badRequest(`Unknown player id(s): ${unknown.join(', ')}`);
      }
      // Linked teams must exist. FPL down → FplUnavailableError → 503 via the error handler.
      const missing = (
        await mapWithConcurrency(entryIds, 5, async (entryId) => {
          try {
            await ctx.fpl.getEntry(entryId);
            return null;
          } catch (err) {
            if (isFplNotFound(err)) return entryId;
            throw err;
          }
        })
      ).filter((id) => id !== null);
      if (missing.length > 0) throw badRequest(`Unknown FPL Team ID(s): ${missing.join(', ')}`);

      const now = ctx.clock.now();
      const battle = await prisma.$transaction(async (tx) => {
        const saved = await tx.captainBattle.upsert({
          where: { event: body.event },
          update: { updatedAt: now },
          create: { event: body.event, createdAt: now, updatedAt: now },
        });
        await tx.captainBattleEntry.deleteMany({ where: { battleId: saved.id } });
        await tx.captainBattleEntry.createMany({
          data: body.entries.map((e, order) => ({
            battleId: saved.id,
            order,
            label: e.label,
            kind: e.kind === 'community' ? ('COMMUNITY' as const) : ('CUSTOM' as const),
            ...(e.source === 'entry'
              ? { source: 'ENTRY' as const, entryId: e.entryId, playerId: null }
              : { source: 'PLAYER' as const, playerId: e.playerId, entryId: null }),
          })),
        });
        return tx.captainBattle.findUniqueOrThrow({
          where: { id: saved.id },
          include: { entries: { orderBy: { order: 'asc' } } },
        });
      });
      return toBattleConfig(battle);
    });

    admin.get('/v1/admin/admins', async () => {
      const credentials = await prisma.adminCredential.findMany({
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      });
      return serialize(
        z.array(AdminAccountSchema),
        credentials.map((c) => ({ userId: c.userId, username: c.username, name: c.user.name })),
        'AdminAccount[]',
      );
    });

    // The signed-in admin changes their own password; every other session of theirs is signed out.
    admin.post('/v1/admin/me/password', { config: { rateLimit: passwordLimit } }, async (request, reply) => {
      const { user, session } = await auth.requireAdmin(request);
      const body = parseInput(ChangePasswordBodySchema, request.body);
      const credential = await prisma.adminCredential.findUnique({ where: { userId: user.id } });
      if (credential === null) throw badRequest('This admin account has no password to change');
      if (!(await verifySecret(credential.passwordHash, body.currentPassword))) {
        throw unauthorized('The current password is incorrect');
      }
      const passwordHash = await hashSecret(body.newPassword);
      await prisma.$transaction([
        prisma.adminCredential.update({ where: { id: credential.id }, data: { passwordHash } }),
        prisma.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } }),
      ]);
      return reply.code(204).send();
    });

    admin.post('/v1/admin/admins', async (request, reply) => {
      const body = parseInput(CreateAdminBodySchema, request.body);
      try {
        const account = await createAdmin(prisma, body);
        return reply.code(201).send(serialize(AdminAccountSchema, account, 'AdminAccount'));
      } catch (err) {
        if (err instanceof AdminUsernameTakenError) throw conflict(err.message);
        throw err;
      }
    });
  });
}
