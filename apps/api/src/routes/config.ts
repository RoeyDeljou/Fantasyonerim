import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import { createDbKeepAlive } from '../perf/keepAlive.js';

export function configRoutes(app: FastifyInstance, ctx: AppContext): void {
  const keepAlive = createDbKeepAlive(ctx);

  // Render's health check + the external 5-minute keep-alive. Also keeps Neon awake (SELECT 1 at most once a
  // minute, outside quiet hours) and says whether FPL is answering — no error details.
  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    keepAlive.touch();
    reply.header('cache-control', 'no-store');
    const fpl = ctx.fpl.getHealth?.();
    return fpl === undefined ? { ok: true } : { ok: true, fpl: fpl.state };
  });

  app.get('/v1/config', async (request, reply) => {
    const { body } = await ctx.hot.config();
    return sendHot(request, reply, body, CACHE_CONTROL.config);
  });
}
