import * as z from 'zod/mini';
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
  'payload_too_large',
  'unsupported_media_type',
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

export const DisplayNameSchema = z.string().check(
  z.trim(),
  z.minLength(2),
  z.maxLength(40),
  z.regex(/^[^<>]*$/, 'no angle brackets'),
  // Bidi overrides/isolates (U+202A–202E, U+2066–2069) can make a name render reversed or spoof another.
  z.regex(/^[^\u202A-\u202E\u2066-\u2069]*$/, 'no direction-control characters'),
);

/**
 * An email address, normalized (trimmed, lower-cased). Used to sign back in together with the FPL Team ID. Not
 * verified (owner decision, Nov 2026): typos are fixed by an admin in Admin → Users.
 */
export const EmailSchema = z
  .string()
  .check(
    z.trim(),
    z.toLowerCase(),
    z.maxLength(254),
    z.regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/, 'must be an email address'),
  );

/**
 * The exact 409 message when an email is already on another account (register, PATCH /v1/me, admin edit). Register
 * can also 409 for an already-registered Team ID; clients tell the two apart by comparing with this constant.
 */
export const EMAIL_TAKEN_MESSAGE = 'This email is already used by another account.';

export const MeSchema = z.object({
  id: UserIdSchema,
  /** Output: any stored name (input rules may tighten over time); inputs use DisplayNameSchema. */
  name: z.string().check(z.minLength(1), z.maxLength(80)),
  /** Null only for admin-only accounts that never linked an FPL team. */
  entryId: z.nullable(FplEntryIdSchema),
  /** FPL team name, cached at registration and refreshed in the background. */
  teamName: z.nullable(z.string()),
  /** Null for accounts made before email was required: the app asks for it once (pop-up). */
  email: z.nullable(z.string()),
  role: RoleSchema,
  locale: LocaleSchema,
  /** False while banned: the user can read but not post, comment, like, report or upload. */
  canPost: z.boolean(),
  createdAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type Me = z.infer<typeof MeSchema>;

/** POST /v1/auth/register — the only signup: name + FPL Team ID + email. No password. */
export const RegisterBodySchema = z.object({
  name: DisplayNameSchema,
  entryId: FplEntryIdSchema,
  email: EmailSchema,
  locale: z.optional(LocaleSchema),
  /** From an admin invite link (`/onboarding/?invite=<token>`): the new account is created as an admin. */
  inviteToken: z.optional(z.string().check(z.minLength(20), z.maxLength(200))),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

/** POST /v1/auth/email-login — sign back in (new device, after signing out): the account's email + its Team ID. */
export const EmailLoginBodySchema = z.object({
  email: EmailSchema,
  entryId: FplEntryIdSchema,
});
export type EmailLoginBody = z.infer<typeof EmailLoginBodySchema>;

export const AdminLoginBodySchema = z.object({
  username: z.string().check(z.trim(), z.minLength(3), z.maxLength(40)),
  password: z.string().check(z.minLength(8), z.maxLength(200)),
});
export type AdminLoginBody = z.infer<typeof AdminLoginBodySchema>;

/** Returned by register / email-login / admin-login. Token is long-lived (sliding 1 year). */
export const AuthResponseSchema = z.object({ token: z.string().check(z.minLength(20)), user: MeSchema });
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const UpdateMeBodySchema = z.object({
  name: z.optional(DisplayNameSchema),
  locale: z.optional(LocaleSchema),
  /** Add or change the account's email (the pop-up for older accounts, Profile). */
  email: z.optional(EmailSchema),
});
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;

// ---------- app config (public) ----------
/** Only https links are accepted for anything we render as a link (blocks javascript:, http:, data:). */
export const HttpsUrlSchema = z.string().check(
  z.trim(),
  z.url(),
  z.maxLength(500),
  z.refine((v) => v.startsWith('https://'), 'must be an https:// link'),
);

/** GET /v1/config — public, unauthenticated; what the client needs to render tabs. */
/** An FPL classic-league invite code, e.g. "KJJGKB" (6 letters/digits). */
export const LeagueCodeSchema = z
  .string()
  .check(z.trim(), z.regex(/^[A-Za-z0-9]{6}$/, 'must be a 6-character league code'));

/**
 * How a fan joins the podcast league: the code plus FPL's official invite link
 * (https://fantasy.premierleague.com/leagues/auto-join/<code>), which opens the FPL app or site and asks to join.
 */
export const LeagueJoinSchema = z.object({ code: z.string(), url: HttpsUrlSchema });
export type LeagueJoin = z.infer<typeof LeagueJoinSchema>;

export const PublicConfigSchema = z.object({
  league: z.nullable(z.object({ id: FplLeagueIdSchema, name: z.nullable(z.string()) })),
  /** null until an admin sets the league code. Optional on input so older responses still parse. */
  leagueJoin: z._default(z.nullable(LeagueJoinSchema), null),
  captainBattleEvent: z.nullable(GameweekSchema),
  socials: z.object({
    spotifyUrl: z.nullable(HttpsUrlSchema),
    appleUrl: z.nullable(HttpsUrlSchema),
    instagramUrl: z.nullable(HttpsUrlSchema),
    xUrl: z.nullable(HttpsUrlSchema),
    whatsappUrl: z.nullable(HttpsUrlSchema),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

// ---------- captain battle ----------
export const CaptainBattleEntryKindSchema = z.enum(['community', 'custom']);

const CaptainBattleEntryBase = {
  /** e.g. "הקפטן של דור", "קפטן הקהילה". Free text chosen by the admin. */
  label: z.string().check(z.trim(), z.minLength(1), z.maxLength(40)),
  /** 'community' rows get the community highlight; everything else is 'custom'. */
  kind: CaptainBattleEntryKindSchema,
};

/**
 * A captain battle row is either a player the admin picks by hand ("קפטן הקהילה"), or linked to an FPL team
 * ("הקפטן של דור" → Dor's Team ID) whose captain for the GW is read from that team's picks automatically.
 */
export const CaptainBattleEntryInputSchema = z.discriminatedUnion('source', [
  z.object({ ...CaptainBattleEntryBase, source: z.literal('player'), playerId: FplPlayerIdSchema }),
  z.object({ ...CaptainBattleEntryBase, source: z.literal('entry'), entryId: FplEntryIdSchema }),
]);
export type CaptainBattleEntryInput = z.infer<typeof CaptainBattleEntryInputSchema>;

/** PUT /v1/admin/captain-battle */
export const CaptainBattleConfigSchema = z.object({
  event: GameweekSchema,
  entries: z.array(CaptainBattleEntryInputSchema).check(z.maxLength(20)),
});
export type CaptainBattleConfig = z.infer<typeof CaptainBattleConfigSchema>;

export const CaptainBattleRowSchema = z.object({
  /** Stable row key; "me" for the signed-in user's own captain row. */
  key: z.string(),
  label: z.string(),
  kind: z.enum(['community', 'custom', 'mine']),
  source: z.enum(['player', 'entry', 'mine']),
  /** Set for entry-linked rows and the "mine" row. */
  entryId: z.nullable(FplEntryIdSchema),
  /**
   * Null while unknown: an entry-linked row before the GW deadline (FPL hides picks until then) or when that
   * team's picks couldn't be loaded. Such rows sort last and show "revealed at the deadline".
   */
  playerId: z.nullable(FplPlayerIdSchema),
  /** basePoints × multiplier; 0 while playerId is null. */
  captainPoints: z.number().check(z.int()),
  /** 2 normally, 3 for a linked team / viewer on Triple Captain; 2 for hand-picked players. */
  multiplier: z.number().check(z.int(), z.gte(1), z.lte(3)),
  live: z.nullable(PlayerLiveSchema),
});
export type CaptainBattleRow = z.infer<typeof CaptainBattleRowSchema>;

/** GET /v1/captain-battle — rows sorted by captainPoints desc. */
export const CaptainBattleSchema = z.object({
  event: z.nullable(GameweekSchema),
  rows: z.array(CaptainBattleRowSchema),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type CaptainBattle = z.infer<typeof CaptainBattleSchema>;

// ---------- admin ----------
/** GET/PUT /v1/admin/settings */
export const AdminSettingsSchema = z.object({
  leagueId: z.nullable(FplLeagueIdSchema),
  /** Read-only: resolved from FPL when leagueId is saved. Ignored on PUT. */
  leagueName: z.optional(z.nullable(z.string())),
  /** Minutes before each FPL deadline to send a reminder push, e.g. [1440, 120]. */
  deadlineReminderMinutes: z.array(z.number().check(z.int(), z.gte(5), z.lte(4320))).check(z.maxLength(5)),
  socials: PublicConfigSchema.shape.socials,
  /** The league's invite code (shown in the "Join our league" bar). Optional on PUT: omitted keeps the stored one. */
  leagueCode: z.optional(z.nullable(LeagueCodeSchema)),
});
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

export const CreateAdminBodySchema = z.extend(AdminLoginBodySchema, { name: DisplayNameSchema });
export type CreateAdminBody = z.infer<typeof CreateAdminBodySchema>;
/** username is null for admins who joined via an invite link (they sign in with their app account). */
export const AdminAccountSchema = z.object({
  userId: UserIdSchema,
  username: z.nullable(z.string()),
  name: z.string(),
});
export type AdminAccount = z.infer<typeof AdminAccountSchema>;
export const AdminAccountListSchema = z.array(AdminAccountSchema);

/**
 * DELETE /v1/me — permanently deletes the signed-in account (App Store guideline 5.1.1(v)): the user, sessions,
 * push subscriptions, posts, comments, likes, reports filed, uploads and their stored photos. Fans have no
 * password, so the client must send this exact confirmation phrase. The last remaining admin can't delete itself
 * (409). 204 on success; the token stops working immediately.
 */
export const DeleteAccountBodySchema = z.object({ confirm: z.literal('DELETE') });
export type DeleteAccountBody = z.infer<typeof DeleteAccountBodySchema>;

// ---------- admin invites ----------
/**
 * One-time links that let a specific person (e.g. a podcast host) create their own account as an admin — no
 * username/password: the fan session of the account that redeems the link gets the admin role. Single use,
 * expire after 7 days, revocable. The raw token appears only once (in the create response's `url`).
 */
export const AdminInviteSchema = z.object({
  id: z.string(),
  /** Who it's for, e.g. "Dor". */
  label: z.string(),
  createdBy: z.string(),
  createdAt: z.string().check(z.iso.datetime({ offset: true })),
  expiresAt: z.string().check(z.iso.datetime({ offset: true })),
  usedAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  usedByName: z.nullable(z.string()),
  revokedAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  status: z.enum(['pending', 'used', 'expired', 'revoked']),
});
export type AdminInvite = z.infer<typeof AdminInviteSchema>;

/** POST /v1/admin/invites */
export const CreateAdminInviteBodySchema = z.object({
  label: z.string().check(z.trim(), z.minLength(1), z.maxLength(40)),
});
export type CreateAdminInviteBody = z.infer<typeof CreateAdminInviteBodySchema>;

/** 201 — `url` = `${WEB_APP_URL}/onboarding/?invite=<token>`; the only time the token is visible. */
export const AdminInviteCreatedSchema = z.object({
  invite: AdminInviteSchema,
  url: z.string().check(z.url()),
});
export type AdminInviteCreated = z.infer<typeof AdminInviteCreatedSchema>;

/** GET /v1/admin/invites — newest first. DELETE /v1/admin/invites/:id → 204 (revoke a pending invite). */
export const AdminInviteListSchema = z.object({ items: z.array(AdminInviteSchema) });

/**
 * GET /v1/admin-invites/:token (public) — lets onboarding show "You're invited as an admin" before signing up.
 * 404 when the token is unknown, used, expired or revoked (one generic message — no oracle).
 */
export const AdminInvitePreviewSchema = z.object({
  label: z.string(),
  expiresAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type AdminInvitePreview = z.infer<typeof AdminInvitePreviewSchema>;

/** POST /v1/me/admin-invite — an already-registered user redeems an invite; returns the upgraded Me. */
export const RedeemAdminInviteBodySchema = z.object({
  token: z.string().check(z.minLength(20), z.maxLength(200)),
});
export type RedeemAdminInviteBody = z.infer<typeof RedeemAdminInviteBodySchema>;
