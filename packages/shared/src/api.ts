import { z } from 'zod';
import {
  FplEntryIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  UserIdSchema,
} from './ids.js';
import { PlayerLiveSchema } from './fpl.js';

/**
 * REST contract between apps/api and apps/web (and the future native shells).
 * Every route lives under /v1. Auth is `Authorization: Bearer <token>` — no cookies, so the same
 * contract works from a Capacitor/native shell. See docs/API.md for the route table.
 */

// ---------- errors ----------
export const ApiErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'upstream_unavailable',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export const ApiErrorSchema = z.object({
  error: z.object({ code: ApiErrorCodeSchema, message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------- users & auth ----------
export const LocaleSchema = z.enum(['he', 'en']);
export type Locale = z.infer<typeof LocaleSchema>;

export const RoleSchema = z.enum(['user', 'admin']);
export type Role = z.infer<typeof RoleSchema>;

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[^<>]*$/, 'no angle brackets');

export const MeSchema = z.object({
  id: UserIdSchema,
  name: DisplayNameSchema,
  /** Null only for admin-only accounts that never linked an FPL team. */
  entryId: FplEntryIdSchema.nullable(),
  /** FPL team name, cached at registration and refreshed in the background. */
  teamName: z.string().nullable(),
  role: RoleSchema,
  locale: LocaleSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type Me = z.infer<typeof MeSchema>;

/** POST /v1/auth/register — the only signup: name + FPL Team ID. No email, no password. */
export const RegisterBodySchema = z.object({
  name: DisplayNameSchema,
  entryId: FplEntryIdSchema,
  locale: LocaleSchema.optional(),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

/**
 * Sign back in on a new device. The recovery code is shown to the user in Profile; it is the only
 * secret tying a person to their account.
 */
export const RecoverBodySchema = z.object({
  entryId: FplEntryIdSchema,
  recoveryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
});
export type RecoverBody = z.infer<typeof RecoverBodySchema>;

export const AdminLoginBodySchema = z.object({
  username: z.string().trim().min(3).max(40),
  password: z.string().min(8).max(200),
});
export type AdminLoginBody = z.infer<typeof AdminLoginBodySchema>;

/** Returned by register / recover / admin-login. Token is long-lived (sliding 1 year). */
export const AuthResponseSchema = z.object({ token: z.string().min(20), user: MeSchema });
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const UpdateMeBodySchema = z.object({
  name: DisplayNameSchema.optional(),
  locale: LocaleSchema.optional(),
});
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;

export const RecoveryCodeResponseSchema = z.object({ recoveryCode: z.string() });
export type RecoveryCodeResponse = z.infer<typeof RecoveryCodeResponseSchema>;

// ---------- app config (public) ----------
/** GET /v1/config — public, unauthenticated; what the client needs to render tabs. */
export const PublicConfigSchema = z.object({
  league: z.object({ id: FplLeagueIdSchema, name: z.string().nullable() }).nullable(),
  captainBattleEvent: GameweekSchema.nullable(),
  socials: z.object({
    spotifyUrl: z.string().url().nullable(),
    appleUrl: z.string().url().nullable(),
    instagramUrl: z.string().url().nullable(),
    xUrl: z.string().url().nullable(),
    whatsappUrl: z.string().url().nullable(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

// ---------- captain battle ----------
export const CaptainBattleEntryKindSchema = z.enum(['community', 'custom']);

export const CaptainBattleEntryInputSchema = z.object({
  /** e.g. "Community captain", "Dor's captain". */
  label: z.string().trim().min(1).max(40),
  playerId: FplPlayerIdSchema,
  kind: CaptainBattleEntryKindSchema,
});
export type CaptainBattleEntryInput = z.infer<typeof CaptainBattleEntryInputSchema>;

/** PUT /v1/admin/captain-battle */
export const CaptainBattleConfigSchema = z.object({
  event: GameweekSchema,
  entries: z.array(CaptainBattleEntryInputSchema).max(20),
});
export type CaptainBattleConfig = z.infer<typeof CaptainBattleConfigSchema>;

export const CaptainBattleRowSchema = z.object({
  /** Stable row key; "me" for the signed-in user's own captain row. */
  key: z.string(),
  label: z.string(),
  kind: z.enum(['community', 'custom', 'mine']),
  playerId: FplPlayerIdSchema,
  /** Captain points = basePoints × 2 (× 3 when the viewer's own row is a triple captain). */
  captainPoints: z.number().int(),
  multiplier: z.number().int().min(1).max(3),
  live: PlayerLiveSchema,
});
export type CaptainBattleRow = z.infer<typeof CaptainBattleRowSchema>;

/** GET /v1/captain-battle — rows sorted by captainPoints desc. */
export const CaptainBattleSchema = z.object({
  event: GameweekSchema.nullable(),
  rows: z.array(CaptainBattleRowSchema),
  updatedAt: z.string().datetime({ offset: true }),
});
export type CaptainBattle = z.infer<typeof CaptainBattleSchema>;

// ---------- admin ----------
/** GET/PUT /v1/admin/settings */
export const AdminSettingsSchema = z.object({
  leagueId: FplLeagueIdSchema.nullable(),
  /** Read-only: resolved from FPL when leagueId is saved. Ignored on PUT. */
  leagueName: z.string().nullable().optional(),
  /** Minutes before each FPL deadline to send a reminder push, e.g. [1440, 120]. */
  deadlineReminderMinutes: z.array(z.number().int().min(5).max(4320)).max(5),
  socials: PublicConfigSchema.shape.socials,
});
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

export const CreateAdminBodySchema = AdminLoginBodySchema.extend({ name: DisplayNameSchema });
export type CreateAdminBody = z.infer<typeof CreateAdminBodySchema>;
export const AdminAccountSchema = z.object({ userId: UserIdSchema, username: z.string(), name: z.string() });
export type AdminAccount = z.infer<typeof AdminAccountSchema>;
export const AdminAccountListSchema = z.array(AdminAccountSchema);
