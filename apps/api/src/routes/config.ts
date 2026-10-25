import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getLatestBattle, getSettings, toPublicConfig } from '../settings.js';

export function configRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/config', async () => {
    const [settings, battle] = await Promise.all([getSettings(ctx.prisma), getLatestBattle(ctx.prisma)]);
    return toPublicConfig(settings, battle);
  });
}
