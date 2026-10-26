import type { FastifyRequest } from 'fastify';
import type { Auth, AuthContext } from '../auth/session.js';
import { forbidden } from '../errors.js';

export const BANNED_MESSAGE = "Your account can't post right now";

/** Every community write: signed in and not banned (banned users can still read). */
export async function requireWriter(auth: Auth, request: FastifyRequest): Promise<AuthContext> {
  const result = await auth.requireUser(request);
  if (result.user.bannedAt !== null) throw forbidden(BANNED_MESSAGE);
  return result;
}

/** Rate-limit key: the signed-in user (so limits follow the account, not the IP), else the IP. */
export function userRateLimitKey(auth: Auth) {
  return async (request: FastifyRequest): Promise<string> => {
    const result = await auth.resolve(request);
    return result === null ? `ip:${request.ip}` : `user:${result.user.id}`;
  };
}
