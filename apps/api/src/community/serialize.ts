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
import { withVariants } from '../news/serialize.js';
import { serialize } from '../validate.js';

/** The author columns a post/comment shows (never the whole User row). */
const AUTHOR_SELECT = {
  id: true,
  name: true,
  entryId: true,
  teamName: true,
  role: true,
} as const satisfies Prisma.UserSelect;
const IMAGE_SELECT = {
  url: true,
  width: true,
  height: true,
  variants: true,
} as const satisfies Prisma.UploadSelect;

/** Every post query includes these relations. */
export const POST_INCLUDE = {
  author: { select: AUTHOR_SELECT },
  image: { select: IMAGE_SELECT },
} as const satisfies Prisma.CommunityPostInclude;
export const COMMENT_INCLUDE = { author: { select: AUTHOR_SELECT } } as const satisfies Prisma.CommentInclude;

export type AuthorFields = Pick<User, keyof typeof AUTHOR_SELECT>;
export type PostWithRelations = PostRow & {
  author: AuthorFields;
  image: Pick<Upload, keyof typeof IMAGE_SELECT> | null;
};
export type CommentWithAuthor = CommentRow & { author: AuthorFields };

/** Raw author fields; branded by the CommunityPost / Comment schema in serialize(). */
export function toAuthor(user: AuthorFields) {
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
          : {
              url: mediaUrl(row.image.url),
              width: row.image.width,
              height: row.image.height,
              ...withVariants(row.image.variants, mediaUrl),
            },
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
