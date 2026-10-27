import type { Prisma, PrismaClient } from '@prisma/client';
import type { MediaStore } from './store.js';

export const PENDING_MEDIA_BATCH = 500;

/** Records keys to delete (inside the transaction that removes their rows), so no file is ever orphaned. */
export async function recordPendingMediaDeletes(
  tx: Prisma.TransactionClient,
  keys: readonly string[],
  now: Date,
): Promise<void> {
  if (keys.length === 0) return;
  await tx.pendingMediaDelete.createMany({
    data: [...new Set(keys)].map((key) => ({ key, createdAt: now })),
    skipDuplicates: true,
  });
}

/**
 * Deletes recorded files; a key is forgotten only once its file is gone, so failures are retried by the hourly
 * cleanup job. `keys` limits the run to those keys (the request that recorded them); omitted = everything due.
 */
export async function purgePendingMediaDeletes(
  prisma: PrismaClient,
  media: MediaStore,
  keys?: readonly string[],
): Promise<number> {
  const rows = await prisma.pendingMediaDelete.findMany({
    where: keys === undefined ? {} : { key: { in: [...keys] } },
    orderBy: { createdAt: 'asc' },
    take: PENDING_MEDIA_BATCH,
  });
  let purged = 0;
  for (const row of rows) {
    try {
      await media.delete(row.key);
    } catch {
      continue;
    }
    await prisma.pendingMediaDelete.deleteMany({ where: { key: row.key } });
    purged += 1;
  }
  return purged;
}
