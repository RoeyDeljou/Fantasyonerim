import { createHash, randomBytes } from 'node:crypto';

/** Opaque bearer token: 32 random bytes, base64url (43 chars). Only its SHA-256 is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
