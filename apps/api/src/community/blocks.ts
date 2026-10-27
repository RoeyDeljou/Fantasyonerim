import type { PrismaClient } from '@prisma/client';

/** Users the viewer has blocked (their posts/comments are hidden from the viewer everywhere). */
export async function blockedIdsOf(prisma: PrismaClient, viewerId: string | null): Promise<string[]> {
  if (viewerId === null) return [];
  const rows = await prisma.userBlock.findMany({
    where: { blockerId: viewerId },
    select: { blockedId: true },
  });
  return rows.map((r) => r.blockedId);
}

export async function hasBlocked(
  prisma: PrismaClient,
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  return (await prisma.userBlock.count({ where: { blockerId, blockedId } })) > 0;
}
