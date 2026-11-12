import { randomBytes } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { processAvatar } from '../community/images.js';
import type { AppContext } from '../context.js';
import { purgePendingMediaDeletes, recordPendingMediaDeletes } from '../media/pending.js';

type AvatarContext = Pick<AppContext, 'prisma' | 'media' | 'clock' | 'hot' | 'forgetUser'>;

/**
 * A new key per upload, so no browser / CDN cache can ever serve the previous photo at the new URL. Under
 * `uploads/` on purpose: those objects get the 5-minute cache TTL (media/store.ts mediaCacheControl and the
 * vercel.json `/media/uploads/*` rule), so a removed or moderated photo goes offline within minutes.
 */
export function avatarKeyFor(userId: string): string {
  return `uploads/avatars/${userId}/${randomBytes(12).toString('base64url')}.jpg`;
}

/**
 * Swaps the user's avatar columns in one transaction (row-locked, so two concurrent uploads can't both "replace"
 * the same old photo and orphan one), recording the previous object as a pending media delete. After commit the
 * old object is deleted best-effort: a failure never fails the request, the hourly cleanup job retries it.
 * Returns the updated user, or null when the user does not exist.
 */
async function swapAvatar(
  ctx: AvatarContext,
  userId: string,
  next: { url: string; key: string } | null,
): Promise<User | null> {
  const now = ctx.clock.now();
  const result = await ctx.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ avatarKey: string | null }[]>(
      Prisma.sql`SELECT "avatarKey" FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
    );
    const current = rows[0];
    if (current === undefined) return null;
    const oldKey = current.avatarKey;
    if (oldKey !== null && oldKey !== next?.key) await recordPendingMediaDeletes(tx, [oldKey], now);
    const user = await tx.user.update({
      where: { id: userId },
      data: { avatarUrl: next?.url ?? null, avatarKey: next?.key ?? null },
    });
    return { user, oldKey };
  });
  if (result === null) return null;
  ctx.forgetUser(userId);
  ctx.hot.invalidateAvatars();
  if (result.oldKey !== null && result.oldKey !== next?.key) {
    await purgePendingMediaDeletes(ctx.prisma, ctx.media, [result.oldKey]).catch(() => 0);
  }
  return result.user;
}

/** Re-encodes `bytes` (415 for non-images), stores the 256×256 JPEG and makes it the user's photo. */
export async function setAvatar(ctx: AvatarContext, userId: string, bytes: Uint8Array): Promise<User | null> {
  const image = await processAvatar(bytes);
  const key = avatarKeyFor(userId);
  const url = await ctx.media.put(key, image.bytes, image.contentType);
  let updated: User | null;
  try {
    updated = await swapAvatar(ctx, userId, { url, key });
  } catch (err) {
    await ctx.media.delete(key).catch(() => undefined);
    throw err;
  }
  // Deleted between auth and here: the new object must not linger.
  if (updated === null) await ctx.media.delete(key).catch(() => undefined);
  return updated;
}

/** Removes the user's photo (own DELETE or admin moderation). Null when the user does not exist. */
export function clearAvatar(ctx: AvatarContext, userId: string): Promise<User | null> {
  return swapAvatar(ctx, userId, null);
}
