import type { PrismaClient } from '@prisma/client';
import { AdminUsernameTakenError, createAdmin } from '../routes/admin.js';

/**
 * Creates the first admin from ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD when that username
 * doesn't exist yet and the install has no admin at all. Idempotent: an existing username is left untouched (its password is NOT reset).
 */
export async function bootstrapAdmin(
  prisma: PrismaClient,
  username: string | undefined,
  password: string | undefined,
): Promise<'created' | 'exists' | 'skipped'> {
  if (!username || !password) return 'skipped';
  // Only bootstraps an EMPTY install: once any admin exists, the env vars never (re)create an account — so an
  // admin who deleted their account isn't resurrected on the next boot.
  if ((await prisma.adminCredential.count()) > 0) return 'exists';
  const existing = await prisma.adminCredential.findUnique({ where: { username } });
  if (existing) return 'exists';
  try {
    await createAdmin(prisma, { username, password, name: username });
    return 'created';
  } catch (err) {
    if (err instanceof AdminUsernameTakenError) return 'exists';
    throw err;
  }
}
