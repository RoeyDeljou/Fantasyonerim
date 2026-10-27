import { z } from 'zod';
import { ChipSchema, PickSchema } from './fpl.js';
import { CommentIdSchema, FplEntryIdSchema, GameweekSchema, PostIdSchema, UserIdSchema } from './ids.js';
import { RoleSchema } from './api.js';

/**
 * Phase 3 contract: the Community tab (fan posts, shared teams, comments, likes, reports, moderation).
 */

export const CommunityAuthorSchema = z.object({
  id: UserIdSchema,
  name: z.string(),
  entryId: FplEntryIdSchema.nullable(),
  teamName: z.string().nullable(),
  /** Admin posts get a "Fantasyonerim" badge. */
  role: RoleSchema,
});
export type CommunityAuthor = z.infer<typeof CommunityAuthorSchema>;

/** An uploaded image, re-encoded server-side (EXIF/GPS stripped), served from the MediaStore. */
export const UploadedImageSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type UploadedImage = z.infer<typeof UploadedImageSchema>;

/**
 * A frozen copy of the author's FPL team for one GW, taken when the post was created (later transfers don't
 * change it). FPL only exposes picks after a GW's deadline, so this is the current/last started GW — for
 * "rate my team for next week" posts users attach a screenshot instead.
 */
export const TeamSnapshotSchema = z.object({
  entryId: FplEntryIdSchema,
  event: GameweekSchema,
  teamName: z.string(),
  managerName: z.string(),
  /** Official GW points at snapshot time. */
  points: z.number().int(),
  overallRank: z.number().int().nullable(),
  activeChip: ChipSchema.nullable(),
  picks: z.array(PickSchema).length(15),
});
export type TeamSnapshot = z.infer<typeof TeamSnapshotSchema>;

export const CommunityPostSchema = z.object({
  id: PostIdSchema,
  author: CommunityAuthorSchema,
  text: z.string(),
  image: UploadedImageSchema.nullable(),
  team: TeamSnapshotSchema.nullable(),
  likeCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  /** false for anonymous viewers. */
  likedByMe: z.boolean(),
  /** The viewer wrote it (can delete). */
  mine: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type CommunityPost = z.infer<typeof CommunityPostSchema>;

export const CommunityPageSchema = z.object({
  items: z.array(CommunityPostSchema),
  nextCursor: z.string().nullable(),
});
export type CommunityPage = z.infer<typeof CommunityPageSchema>;

export const CommunityPageQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Only this author's posts (profile view). */
  authorId: UserIdSchema.optional(),
});

export const PostTextSchema = z.string().trim().max(1000);

/** POST /v1/community/posts — at least one of text / image / team. */
export const CreatePostBodySchema = z
  .object({
    text: PostTextSchema.default(''),
    /** From POST /v1/uploads. Must belong to the author and be unused. */
    uploadId: z.string().min(1).max(100).nullable().optional(),
    /** Attach a snapshot of the author's own team for this GW (must be a started GW). */
    shareTeamEvent: GameweekSchema.nullable().optional(),
  })
  .refine((b) => b.text.length > 0 || Boolean(b.uploadId) || Boolean(b.shareTeamEvent), {
    message: 'A post needs text, an image or a team',
  });
export type CreatePostBody = z.infer<typeof CreatePostBodySchema>;

/** POST /v1/uploads (multipart field "file": jpeg / png / webp / heic, ≤ 10 MB) */
export const UploadResponseSchema = z.object({ uploadId: z.string(), image: UploadedImageSchema });
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export const CommentSchema = z.object({
  id: CommentIdSchema,
  postId: PostIdSchema,
  author: CommunityAuthorSchema,
  text: z.string(),
  mine: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Comment = z.infer<typeof CommentSchema>;

/** GET /v1/community/posts/:id/comments — oldest first (conversation order). */
export const CommentPageSchema = z.object({
  items: z.array(CommentSchema),
  nextCursor: z.string().nullable(),
});
export type CommentPage = z.infer<typeof CommentPageSchema>;

export const CreateCommentBodySchema = z.object({ text: z.string().trim().min(1).max(500) });
export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>;

/** PUT / DELETE /v1/community/posts/:id/like → the new counts. */
export const LikeResultSchema = z.object({
  likeCount: z.number().int().nonnegative(),
  likedByMe: z.boolean(),
});

export const ReportReasonSchema = z.enum(['spam', 'abuse', 'hate', 'sexual', 'other']);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

/** POST /v1/community/posts/:id/report and /v1/community/comments/:id/report — one open report per user/target. */
export const ReportBodySchema = z.object({
  reason: ReportReasonSchema,
  note: z.string().trim().max(300).optional(),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

// ---------- admin moderation ----------
export const ReportTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('post'), post: CommunityPostSchema }),
  z.object({ kind: z.literal('comment'), comment: CommentSchema }),
]);

/** GET /v1/admin/reports?status=open — grouped per target. */
export const ReportGroupSchema = z.object({
  targetId: z.string(),
  target: ReportTargetSchema,
  reportCount: z.number().int().positive(),
  reasons: z.array(ReportReasonSchema),
  notes: z.array(z.string()),
  firstReportedAt: z.string().datetime({ offset: true }),
});
export type ReportGroup = z.infer<typeof ReportGroupSchema>;
export const ReportListSchema = z.object({ items: z.array(ReportGroupSchema) });

/** POST /v1/admin/reports/:targetId/resolve — remove the content, or dismiss the reports. */
export const ResolveReportBodySchema = z.object({ action: z.enum(['remove', 'dismiss']) });

export const AdminUserSchema = z.object({
  id: UserIdSchema,
  name: z.string(),
  entryId: FplEntryIdSchema.nullable(),
  teamName: z.string().nullable(),
  role: RoleSchema,
  bannedAt: z.string().datetime({ offset: true }).nullable(),
  banReason: z.string().nullable(),
  postCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;
/** GET /v1/admin/users?query= (name / team name / Team ID) */
export const AdminUserListSchema = z.object({ items: z.array(AdminUserSchema) });

/** POST /v1/admin/users/:id/ban — banned users can read but not post/comment/like/report. DELETE unbans. */
export const BanBodySchema = z.object({ reason: z.string().trim().min(1).max(200) });

// ---------- blocking (App Store guideline 1.2: users must be able to block abusive users) ----------
/**
 * PUT /v1/community/blocks/:userId → 204 (idempotent), DELETE → 204. Blocking is one-way and private: the blocker
 * no longer sees the blocked user's posts or comments anywhere, and gets no notifications from them. You can't
 * block yourself or an admin (400).
 */
export const BlockedUserSchema = z.object({
  id: UserIdSchema,
  name: z.string(),
  teamName: z.string().nullable(),
  blockedAt: z.string().datetime({ offset: true }),
});
export type BlockedUser = z.infer<typeof BlockedUserSchema>;
/** GET /v1/community/blocks */
export const BlockListSchema = z.object({ items: z.array(BlockedUserSchema) });
