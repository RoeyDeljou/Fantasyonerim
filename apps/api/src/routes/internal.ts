import { createHash, timingSafeEqual } from 'node:crypto';
import { JobsTickResponseSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiHttpError, notFound, unauthorized } from '../errors.js';
import type { JobRunner } from '../jobs/runner.js';
import { contentTypeForKey, isSafeKey } from '../media/store.js';
import { serialize } from '../validate.js';

/** Constant-time comparison (hashing first so lengths never leak). */
export function secretEquals(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function internalRoutes(app: FastifyInstance, ctx: AppContext, jobs: JobRunner): void {
  // External cron (sleeping hosts): runs every due job. Exempt from the IP rate limit (one caller).
  app.post('/internal/jobs/tick', { config: { rateLimit: false } }, async (request) => {
    const expected = ctx.config.cronSecret;
    if (!expected) throw new ApiHttpError(503, 'upstream_unavailable', 'CRON_SECRET is not configured');
    const header = request.headers['x-cron-secret'];
    const given = typeof header === 'string' ? header : '';
    if (given === '' || !secretEquals(given, expected)) throw unauthorized('Bad cron secret');
    return serialize(JobsTickResponseSchema, { ran: await jobs.runDue() });
  });

  // Local MediaStore only (dev). S3/R2 serves its own public URLs.
  const read = ctx.media.read?.bind(ctx.media);
  if (read !== undefined) {
    app.get('/media/*', async (request, reply) => {
      const key = (request.params as { '*'?: string })['*'] ?? '';
      if (!isSafeKey(key)) throw notFound('No such media');
      const file = await read(key);
      if (file === null) throw notFound('No such media');
      return reply
        .header('content-type', contentTypeForKey(key))
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(Buffer.from(file.bytes));
    });
  }
}
