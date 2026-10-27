import { z } from 'zod';

/**
 * Phase 4 contract: the admin "live update" composer (e.g. a goal alert) that publishes one message to several
 * places at once, plus admin account security.
 *
 * Targets are independent: one failing never blocks the others, and each reports its own result. WhatsApp is a
 * deferred target (docs/CLIENT_ACCOUNTS.md) — adding it later means adding 'whatsapp' here and a Publisher in
 * packages/integrations.
 */

export const BroadcastTargetSchema = z.enum(['news', 'push', 'x']);
export type BroadcastTarget = z.infer<typeof BroadcastTargetSchema>;

/** POST /v1/admin/broadcast */
export const BroadcastBodySchema = z
  .object({
    /** Optional headline for the News card and the push title (defaults to "פנטזיונרים"). */
    title: z.string().trim().max(80).nullable().optional(),
    /** The message. X counts it with its own weighted rules (≤ 280); the API rejects it per target if too long. */
    text: z.string().trim().min(1).max(1000),
    /** From POST /v1/uploads (the admin's own, unused upload). Shown on the News card and attached to the X post. */
    uploadId: z.string().min(1).max(100).nullable().optional(),
    targets: z.array(BroadcastTargetSchema).min(1),
  })
  .refine((b) => new Set(b.targets).size === b.targets.length, { message: 'Duplicate target' });
export type BroadcastBody = z.infer<typeof BroadcastBodySchema>;

export const BroadcastTargetResultSchema = z.object({
  target: BroadcastTargetSchema,
  status: z.enum(['ok', 'skipped', 'error']),
  /** Human-readable outcome, e.g. "Posted", "X isn't configured", "Delivered to 312 of 340 devices". */
  detail: z.string(),
  /** Where the result lives: the News item deep link, or the X post URL. */
  url: z.string().nullable(),
});
export type BroadcastTargetResult = z.infer<typeof BroadcastTargetResultSchema>;

export const BroadcastResultSchema = z.object({
  id: z.string(),
  results: z.array(BroadcastTargetResultSchema),
  createdAt: z.string().datetime({ offset: true }),
});
export type BroadcastResult = z.infer<typeof BroadcastResultSchema>;

/** GET /v1/admin/broadcasts — the last 50, newest first (audit trail: who sent what where). */
export const BroadcastHistorySchema = z.object({
  items: z.array(
    BroadcastResultSchema.extend({
      title: z.string().nullable(),
      text: z.string(),
      sentBy: z.string(),
    }),
  ),
});
export type BroadcastHistory = z.infer<typeof BroadcastHistorySchema>;

/** GET /v1/admin/broadcast/targets — which targets can be used right now, for the composer's toggles. */
export const BroadcastTargetsStatusSchema = z.object({
  targets: z.array(
    z.object({
      target: BroadcastTargetSchema,
      available: z.boolean(),
      /** Why not, e.g. "X API keys aren't set — paid feature" or "No push subscribers yet". */
      reason: z.string().nullable(),
      /** X only: the paid-feature note applies. */
      paidFeature: z.boolean(),
    }),
  ),
});
export type BroadcastTargetsStatus = z.infer<typeof BroadcastTargetsStatusSchema>;

/** POST /v1/admin/me/password — the signed-in admin changes their own password; other sessions are signed out. */
export const ChangePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(10).max(200),
  })
  .refine((b) => b.currentPassword !== b.newPassword, {
    message: 'The new password must be different',
    path: ['newPassword'],
  });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;
