import { Prisma } from '@prisma/client';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { purgePendingMediaDeletes, recordPendingMediaDeletes } from '../media/pending.js';

export const LAST_ADMIN_MESSAGE = "You're the only admin — add another admin first";

/**
 * Permanently deletes an account and everything tied to it (App Store guideline 5.1.1(v)), in one transaction:
 * other people's post counters are corrected first, reports about the user's content (and the ones they filed)
 * go, then the User row — which cascades to sessions, push subscriptions, native devices, prefs, notification
 * log, admin credential, posts (with their comments + likes), comments, likes, reports filed, uploads and blocks.
 * Stored photos are recorded as pending deletes in the same transaction and removed after commit (the hourly
 * cleanup retries any that fail). Broadcast history keeps `sentByName` (no FK); an upload used as a broadcast's
 * image is official News content, so its file stays online.
 */
export async function deleteAccount(ctx: Pick<AppContext, 'prisma' | 'media' | 'clock'>, userId: string) {
  const { prisma } = ctx;
  const now = ctx.clock.now();
  const keys = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (user === null) return [];
    if (user.role === 'ADMIN') {
      // Lock every admin row so two admins can't delete themselves concurrently and leave none.
      const admins = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "User" WHERE "role" = 'ADMIN' FOR UPDATE`,
      );
      if (admins.length <= 1) throw conflict(LAST_ADMIN_MESSAGE);
    }

    // Counters on OTHER people's posts (the user's own posts disappear with them).
    await tx.$executeRaw(Prisma.sql`
      UPDATE "CommunityPost" p SET "commentCount" = GREATEST(p."commentCount" - c.n, 0)
      FROM (SELECT "postId", count(*)::int AS n FROM "Comment"
            WHERE "authorId" = ${userId} AND "deletedAt" IS NULL GROUP BY "postId") c
      WHERE p."id" = c."postId" AND p."authorId" <> ${userId}`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "CommunityPost" p SET "likeCount" = GREATEST(p."likeCount" - 1, 0)
      FROM "PostLike" l
      WHERE l."postId" = p."id" AND l."userId" = ${userId} AND p."authorId" <> ${userId}`);

    // Reports about content that is about to vanish (their posts, their comments, comments on their posts).
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "Report"
      WHERE ("targetKind" = 'post' AND "targetId" IN (SELECT "id" FROM "CommunityPost" WHERE "authorId" = ${userId}))
         OR ("targetKind" = 'comment' AND "targetId" IN (
              SELECT "id" FROM "Comment"
              WHERE "authorId" = ${userId}
                 OR "postId" IN (SELECT "id" FROM "CommunityPost" WHERE "authorId" = ${userId})))`);

    const uploads = await tx.upload.findMany({
      where: { ownerId: userId },
      select: { storageKey: true, broadcasts: { select: { id: true }, take: 1 } },
    });
    const fileKeys = uploads.filter((u) => u.broadcasts.length === 0).map((u) => u.storageKey);
    await recordPendingMediaDeletes(tx, fileKeys, now);

    await tx.user.delete({ where: { id: userId } });
    return fileKeys;
  });
  if (keys.length > 0) await purgePendingMediaDeletes(prisma, ctx.media, keys);
}
