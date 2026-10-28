import {
  CommentSchema,
  CommunityPostSchema,
  TeamSnapshotSchema,
  type Comment,
  type CommunityPost,
} from '@fant/shared';
import type {
  Comment as CommentRow,
  CommunityPost as PostRow,
  Prisma,
  PrismaClient,
  Upload,
  User,
} from '@prisma/client';
import type { MediaUrlMapper } from '../media/publicUrl.js';
import { serialize } from '../validate.js';

/** Every post query includes these relations. */
export const POST_INCLUDE = { author: true, image: true } as const satisfies Prisma.CommunityPostInclude;
export const COMMENT_INCLUDE = { author: true } as const satisfies Prisma.CommentInclude;

export type PostWithRelations = PostRow & { author: User; image: Upload | null };
export type CommentWithAuthor = CommentRow & { author: User };

/** Raw author fields; branded by the CommunityPost / Comment schema in serialize(). */
export function toAuthor(user: User) {
  return {
    id: user.id,
    name: user.name,
    entryId: user.entryId,
    teamName: user.teamName,
    role: user.role === 'ADMIN' ? 'admin' : 'user',
  };
}

/** `mediaUrl` maps the stored image URL to the client URL (ctx.mediaUrl). */
export function toPost(
  row: PostWithRelations,
  viewerId: string | null,
  likedByMe: boolean,
  mediaUrl: MediaUrlMapper,
): CommunityPost {
  const team = row.teamSnapshot === null ? null : TeamSnapshotSchema.safeParse(row.teamSnapshot);
  return serialize(
    CommunityPostSchema,
    {
      id: row.id,
      author: toAuthor(row.author),
      text: row.text,
      image:
        row.image === null
          ? null
          : { url: mediaUrl(row.image.url), width: row.image.width, height: row.image.height },
      team: team === null || !team.success ? null : team.data,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      likedByMe: viewerId !== null && likedByMe,
      mine: viewerId !== null && viewerId === row.authorId,
      createdAt: row.createdAt.toISOString(),
    },
    'CommunityPost',
  );
}

/** Serializes posts for one viewer, filling likedByMe with a single query. */
export async function toPosts(
  prisma: PrismaClient,
  rows: readonly PostWithRelations[],
  viewerId: string | null,
  mediaUrl: MediaUrlMapper,
): Promise<CommunityPost[]> {
  let liked = new Set<string>();
  if (viewerId !== null && rows.length > 0) {
    const likes = await prisma.postLike.findMany({
      where: { userId: viewerId, postId: { in: rows.map((r) => r.id) } },
      select: { postId: true },
    });
    liked = new Set(likes.map((l) => l.postId));
  }
  return rows.map((row) => toPost(row, viewerId, liked.has(row.id), mediaUrl));
}

export function toComment(row: CommentWithAuthor, viewerId: string | null): Comment {
  return serialize(
    CommentSchema,
    {
      id: row.id,
      postId: row.postId,
      author: toAuthor(row.author),
      text: row.text,
      mine: viewerId !== null && viewerId === row.authorId,
      createdAt: row.createdAt.toISOString(),
    },
    'Comment',
  );
}
