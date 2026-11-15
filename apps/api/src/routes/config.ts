import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';

export function configRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Render's health check (and anything pinging the host). Never touches the database, so pings don't keep Neon
  // awake (see perf/keepAlive.ts). Says whether FPL is answering — no error details.
  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const fpl = ctx.fpl.getHealth?.();
    return fpl === undefined ? { ok: true } : { ok: true, fpl: fpl.state };
  });

  app.get('/v1/config', async (request, reply) => {
    const { body } = await ctx.hot.config();
    return sendHot(request, reply, body, CACHE_CONTROL.config);
  });
}
