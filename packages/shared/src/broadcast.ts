import * as z from 'zod/mini';

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
    title: z.optional(z.nullable(z.string().check(z.trim(), z.maxLength(80)))),
    /** The message. X counts it with its own weighted rules (≤ 280); the API rejects it per target if too long. */
    text: z.string().check(z.trim(), z.minLength(1), z.maxLength(1000)),
    /** From POST /v1/uploads (the admin's own, unused upload). Shown on the News card and attached to the X post. */
    uploadId: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(100)))),
    targets: z.array(BroadcastTargetSchema).check(z.minLength(1)),
  })
  .check(z.refine((b) => new Set(b.targets).size === b.targets.length, { message: 'Duplicate target' }));
export type BroadcastBody = z.infer<typeof BroadcastBodySchema>;

export const BroadcastTargetResultSchema = z.object({
  target: BroadcastTargetSchema,
  status: z.enum(['ok', 'skipped', 'error']),
  /** Human-readable outcome (English, for logs/history), e.g. "Delivered to 312 of 340 devices". */
  detail: z.string(),
  /** Stable outcome code so the client can localize. */
  code: z.enum(['posted', 'delivered', 'no_subscribers', 'not_configured', 'too_long', 'failed']),
  /** Push only: devices that accepted / devices targeted. */
  delivered: z.nullable(z.number().check(z.int(), z.nonnegative())),
  recipients: z.nullable(z.number().check(z.int(), z.nonnegative())),
  /** Where the result lives: the News item deep link, or the X post URL. */
  url: z.nullable(z.string()),
});
export type BroadcastTargetResult = z.infer<typeof BroadcastTargetResultSchema>;

export const BroadcastResultSchema = z.object({
  id: z.string(),
  results: z.array(BroadcastTargetResultSchema),
  createdAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type BroadcastResult = z.infer<typeof BroadcastResultSchema>;

/** GET /v1/admin/broadcasts — the last 50, newest first (audit trail: who sent what where). */
export const BroadcastHistorySchema = z.object({
  items: z.array(
    z.extend(BroadcastResultSchema, {
      title: z.nullable(z.string()),
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
      reason: z.nullable(z.string()),
      /** Stable code for `reason` so the client can localize. */
      reasonCode: z.nullable(z.enum(['not_configured', 'no_subscribers', 'paid_feature'])),
      /** X only: the paid-feature note applies. */
      paidFeature: z.boolean(),
    }),
  ),
});
export type BroadcastTargetsStatus = z.infer<typeof BroadcastTargetsStatusSchema>;

/** POST /v1/admin/me/password — the signed-in admin changes their own password; other sessions are signed out. */
export const ChangePasswordBodySchema = z
  .object({
    currentPassword: z.string().check(z.minLength(1), z.maxLength(200)),
    newPassword: z.string().check(z.minLength(10), z.maxLength(200)),
  })
  .check(
    z.refine((b) => b.currentPassword !== b.newPassword, {
      message: 'The new password must be different',
      path: ['newPassword'],
    }),
  );
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;
