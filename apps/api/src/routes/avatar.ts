import { AvatarResponseSchema, LeagueAvatarsSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { clearAvatar, setAvatar } from '../account/avatar.js';
import type { Auth } from '../auth/session.js';
import { requireWriter } from '../community/guard.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { HOT_POLICY, LEAGUE_AVATARS_HOT_KEY } from '../perf/hotData.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
import { toMe } from '../serializers.js';
import { serialize } from '../validate.js';
import { readImageFile } from './uploads.js';

/**
 * Profile photos. POST /v1/me/avatar (multipart "file", same reading/sniffing rules as POST /v1/uploads; banned
 * users get 403), DELETE /v1/me/avatar (allowed while banned: it only removes the user's own photo), and the
 * public GET /v1/league/avatars (entryId → URL for the league table; banned users left out).
 */
export function avatarRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, uploadLimit: object): void {
  app.post('/v1/me/avatar', { config: { rateLimit: uploadLimit } }, async (request) => {
    const { user } = await requireWriter(auth, request);
    const bytes = await readImageFile(request);
    const updated = await setAvatar(ctx, user.id, bytes);
    if (updated === null) throw notFound('This account no longer exists');
    return serialize(AvatarResponseSchema, { user: toMe(updated, ctx.mediaUrl) }, 'AvatarResponse');
  });

  app.delete('/v1/me/avatar', async (request) => {
    const { user } = await auth.requireUser(request);
    const updated = await clearAvatar(ctx, user.id);
    if (updated === null) throw notFound('This account no longer exists');
    return serialize(AvatarResponseSchema, { user: toMe(updated, ctx.mediaUrl) }, 'AvatarResponse');
  });

  // Same bytes for everybody (no Vary: authorization), one DB query per minute at most, dropped on every change.
  app.get('/v1/league/avatars', async (request, reply) => {
    const { body } = await ctx.hot.cache.get(LEAGUE_AVATARS_HOT_KEY, HOT_POLICY.avatars, async () => {
      const rows = await ctx.prisma.user.findMany({
        where: { entryId: { not: null }, avatarUrl: { not: null }, bannedAt: null },
        select: { entryId: true, avatarUrl: true },
        orderBy: { entryId: 'asc' },
      });
      return {
        build: () =>
          serialize(
            LeagueAvatarsSchema,
            {
              avatars: rows.flatMap((r) =>
                r.entryId === null || r.avatarUrl === null
                  ? []
                  : [{ entryId: r.entryId, url: ctx.mediaUrl(r.avatarUrl) }],
              ),
            },
            'LeagueAvatars',
          ),
      };
    });
    return sendHot(request, reply, body, CACHE_CONTROL.avatars);
  });
}
