import { LocaleSchema, MeSchema, type Me } from '@fant/shared';
import { serialize } from './validate.js';
import type { User } from '@prisma/client';
import { mapMediaUrl, type MediaUrlMapper } from './media/publicUrl.js';

/** `mediaUrl` maps the stored avatar URL to the client URL (ctx.mediaUrl). */
export function toMe(user: User, mediaUrl: MediaUrlMapper): Me {
  const locale = LocaleSchema.safeParse(user.locale);
  return serialize(
    MeSchema,
    {
      id: user.id,
      name: user.name,
      entryId: user.entryId,
      teamName: user.teamName,
      email: user.email,
      role: user.role === 'ADMIN' ? 'admin' : 'user',
      locale: locale.success ? locale.data : 'he',
      canPost: user.bannedAt === null,
      avatarUrl: mapMediaUrl(mediaUrl, user.avatarUrl),
      createdAt: user.createdAt.toISOString(),
    },
    'Me',
  );
}
