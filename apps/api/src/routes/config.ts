import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { derivedSocials, getLatestBattle, getSettings, toPublicConfig } from '../settings.js';

export function configRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/config', async () => {
    const [settings, battle, defaults] = await Promise.all([
      getSettings(ctx.prisma),
      getLatestBattle(ctx.prisma),
      derivedSocials(ctx.prisma),
    ]);
    return toPublicConfig(settings, battle, defaults);
  });
}
