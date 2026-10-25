import {
  AdminAccountSchema,
  AdminSettingsSchema,
  CaptainBattleConfigSchema,
  CreateAdminBodySchema,
} from '@fant/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashSecret } from '../auth/passwords.js';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
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

/** Every route in this scope re-checks the ADMIN role before anything else (incl. body parsing). */
export function adminRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
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
      const bootstrap = await ctx.fpl.getBootstrap();
      const known = new Set<number>(bootstrap.players.map((p) => p.id));
      const unknown = body.entries.filter((e) => !known.has(e.playerId)).map((e) => e.playerId);
      if (unknown.length > 0) throw badRequest(`Unknown player id(s): ${unknown.join(', ')}`);

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
            playerId: e.playerId,
            kind: e.kind === 'community' ? 'COMMUNITY' : 'CUSTOM',
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
