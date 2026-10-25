import { LocaleSchema, MeSchema, type Me } from '@fant/shared';
import { serialize } from './validate.js';
import type { User } from '@prisma/client';

export function toMe(user: User): Me {
  const locale = LocaleSchema.safeParse(user.locale);
  return serialize(
    MeSchema,
    {
      id: user.id,
      name: user.name,
      entryId: user.entryId,
      teamName: user.teamName,
      role: user.role === 'ADMIN' ? 'admin' : 'user',
      locale: locale.success ? locale.data : 'he',
      createdAt: user.createdAt.toISOString(),
    },
    'Me',
  );
}
