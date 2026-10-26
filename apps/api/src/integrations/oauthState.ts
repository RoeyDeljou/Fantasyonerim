import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Signed OAuth `state`: `<base64url(JSON {u, n, e})>.<base64url(HMAC-SHA256)>`, keyed by a key derived
 * from SECRETS_KEY. Binds the callback to the admin who started it, expires after 10 minutes.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const PayloadSchema = z.object({ u: z.string().min(1), n: z.string().min(8), e: z.number().int() });

function hmacKey(secretsKey: Buffer): Buffer {
  return createHmac('sha256', secretsKey).update('oauth-state:v1').digest();
}

function sign(secretsKey: Buffer, body: string): string {
  return createHmac('sha256', hmacKey(secretsKey)).update(body).digest('base64url');
}

export function createOAuthState(secretsKey: Buffer, userId: string, nowMs: number): string {
  const body = Buffer.from(
    JSON.stringify({ u: userId, n: randomBytes(16).toString('base64url'), e: nowMs + OAUTH_STATE_TTL_MS }),
  ).toString('base64url');
  return `${body}.${sign(secretsKey, body)}`;
}

export type OAuthStateResult = { ok: true; userId: string } | { ok: false; reason: 'invalid_state' | 'expired_state' };

export function verifyOAuthState(secretsKey: Buffer, state: string, nowMs: number): OAuthStateResult {
  const parts = state.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid_state' };
  const [body, mac] = parts as [string, string];
  const expected = Buffer.from(sign(secretsKey, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'invalid_state' };
  }
  let payload: z.infer<typeof PayloadSchema>;
  try {
    payload = PayloadSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    return { ok: false, reason: 'invalid_state' };
  }
  if (payload.e <= nowMs) return { ok: false, reason: 'expired_state' };
  return { ok: true, userId: payload.u };
}
