import type { Prisma, PrismaClient, ReportTargetKind } from '@prisma/client';
import type { MediaStore } from '../media/store.js';
import { z } from 'zod';
import { badRequest } from '../errors.js';

/** How a report was closed. */
export type ReportResolution = 'removed' | 'dismissed' | 'deleted';

/**
 * Report target ids used by GET /v1/admin/reports and POST /v1/admin/reports/:targetId/resolve:
 * `post:<postId>` or `comment:<commentId>`.
 */
export function encodeTargetId(kind: ReportTargetKind, id: string): string {
  return `${kind}:${id}`;
}

const TargetIdSchema = z.string().regex(/^(post|comment):[A-Za-z0-9_-]{1,100}$/);

export function decodeTargetId(value: string): { kind: ReportTargetKind; id: string } {
  if (!TargetIdSchema.safeParse(value).success) {
    throw badRequest('targetId: expected "post:<id>" or "comment:<id>"');
  }
  const sep = value.indexOf(':');
  return { kind: value.slice(0, sep) === 'post' ? 'post' : 'comment', id: value.slice(sep + 1) };
}

type Tx = Prisma.TransactionClient;

/** Closes every open report on the targets. */
export async function resolveReports(
  tx: Tx,
  targets: readonly { kind: ReportTargetKind; ids: readonly string[] }[],
  resolution: ReportResolution,
  by: string,
  now: Date,
): Promise<number> {
  let count = 0;
  for (const t of targets) {
    if (t.ids.length === 0) continue;
    const res = await tx.report.updateMany({
      where: { isOpen: true, targetKind: t.kind, targetId: { in: [...t.ids] } },
      data: { isOpen: null, resolvedAt: now, resolution, resolvedBy: by },
    });
    count += res.count;
  }
  return count;
}

/**
 * Soft-deletes a post (idempotent: false when it was already deleted) and closes the open reports on it
 * and on its comments, which disappear with it.
 */
export async function softDeletePost(
  tx: Tx,
  postId: string,
  by: string,
  resolution: ReportResolution,
  now: Date,
): Promise<boolean> {
  const res = await tx.communityPost.updateMany({
    where: { id: postId, deletedAt: null },
    data: { deletedAt: now, deletedBy: by },
  });
  if (res.count === 0) return false;
  const comments = await tx.comment.findMany({ where: { postId }, select: { id: true } });
  await resolveReports(
    tx,
    [
      { kind: 'post', ids: [postId] },
      { kind: 'comment', ids: comments.map((c) => c.id) },
    ],
    resolution,
    by,
    now,
  );
  return true;
}

/** Soft-deletes a comment, decrements its post's commentCount and closes its open reports. */
export async function softDeleteComment(
  tx: Tx,
  comment: { id: string; postId: string },
  by: string,
  resolution: ReportResolution,
  now: Date,
): Promise<boolean> {
  const res = await tx.comment.updateMany({
    where: { id: comment.id, deletedAt: null },
    data: { deletedAt: now, deletedBy: by },
  });
  if (res.count === 0) return false;
  await tx.communityPost.updateMany({
    where: { id: comment.postId, commentCount: { gt: 0 } },
    data: { commentCount: { decrement: 1 } },
  });
  await resolveReports(tx, [{ kind: 'comment', ids: [comment.id] }], resolution, by, now);
  return true;
}

/**
 * Takes the images of deleted posts offline: deletes the Upload row (the post's imageUploadId becomes null) and
 * the stored file. Called right after a post is deleted/removed, and by the hourly cleanup as a safety net.
 * A failed file delete is retried on the next run because the row is only removed once the file is gone.
 */
export async function purgeDeletedPostImages(
  prisma: PrismaClient,
  media: MediaStore,
  postIds?: readonly string[],
): Promise<number> {
  const uploads = await prisma.upload.findMany({
    where: { post: { deletedAt: { not: null }, ...(postIds ? { id: { in: [...postIds] } } : {}) } },
    select: { id: true, storageKey: true },
    take: 500,
  });
  let purged = 0;
  for (const upload of uploads) {
    try {
      await media.delete(upload.storageKey);
    } catch {
      continue;
    }
    await prisma.upload.deleteMany({ where: { id: upload.id } });
    purged += 1;
  }
  return purged;
}
