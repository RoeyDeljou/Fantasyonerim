import type { AdminInvite as AdminInviteDto } from '@fant/shared';
import type { AdminInvite, Prisma } from '@prisma/client';
import { badRequest } from '../errors.js';
import { generateSessionToken, hashToken } from './tokens.js';

export const ADMIN_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVALID_INVITE_MESSAGE = 'This invite link is no longer valid';

/** 32 random bytes, base64url — same strength as a session token; only the SHA-256 is stored. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = generateSessionToken();
  return { token, tokenHash: hashToken(token) };
}

export function inviteStatus(invite: AdminInvite, now: Date): AdminInviteDto['status'] {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.usedAt !== null) return 'used';
  if (invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export function pendingInviteWhere(now: Date): Prisma.AdminInviteWhereInput {
  return { usedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

/**
 * Atomically marks the invite used by `user` (a single conditional UPDATE: of two concurrent redemptions exactly
 * one matches). Throws 400 when the token is unknown, used, expired or revoked — callers run it inside the
 * transaction that grants the role, so a failed claim rolls everything back.
 */
export async function claimInvite(
  tx: Prisma.TransactionClient,
  token: string,
  user: { id: string; name: string },
  now: Date,
): Promise<void> {
  const claimed = await tx.adminInvite.updateMany({
    where: { tokenHash: hashToken(token), ...pendingInviteWhere(now) },
    data: { usedAt: now, usedById: user.id, usedByName: user.name },
  });
  if (claimed.count === 0) throw badRequest(INVALID_INVITE_MESSAGE);
}
