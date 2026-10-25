import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Opaque bearer token: 32 random bytes, base64url (43 chars). Only its SHA-256 is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** No 0/O, 1/I/L — easy to read aloud and type on a phone. */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Recovery code in the form `XXXX-XXXX` (matches RecoverBodySchema). ~39 bits; recover is rate-limited. */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}
