import type { Session, User } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { generateSessionToken, hashToken } from './tokens.js';

/** Sliding expiry: every authenticated request pushes expiry to now + 1 year. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** The sliding-expiry DB write happens at most once per hour per session. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface AuthContext {
  user: User;
  session: Session;
}

export interface Auth {
  /** Resolves the bearer token (if any). Invalid/expired tokens resolve to null. Cached per request. */
  resolve(request: FastifyRequest): Promise<AuthContext | null>;
  requireUser(request: FastifyRequest): Promise<AuthContext>;
  requireAdmin(request: FastifyRequest): Promise<AuthContext>;
  issueSession(userId: string, request: FastifyRequest): Promise<string>;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function createAuth(ctx: AppContext): Auth {
  const cache = new WeakMap<FastifyRequest, Promise<AuthContext | null>>();

  async function lookup(request: FastifyRequest): Promise<AuthContext | null> {
    const token = bearerToken(request);
    if (!token) return null;
    const session = await ctx.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session) return null;
    const now = ctx.clock.now();
    if (session.expiresAt.getTime() <= now.getTime()) {
      await ctx.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    const { user, ...rest } = session;
    let current: Session = rest;
    if (now.getTime() - session.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      current = await ctx.prisma.session.update({
        where: { id: session.id },
        data: { lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
      });
    }
    return { user, session: current };
  }

  const auth: Auth = {
    resolve(request) {
      let pending = cache.get(request);
      if (!pending) {
        pending = lookup(request);
        cache.set(request, pending);
      }
      return pending;
    },
    async requireUser(request) {
      const hasToken = bearerToken(request) !== null;
      const result = await auth.resolve(request);
      if (!result)
        throw unauthorized(hasToken ? 'Session expired or invalid — please sign in again' : undefined);
      return result;
    },
    async requireAdmin(request) {
      const result = await auth.requireUser(request);
      if (result.user.role !== 'ADMIN') throw forbidden();
      return result;
    },
    async issueSession(userId, request) {
      const token = generateSessionToken();
      const now = ctx.clock.now();
      const userAgent = request.headers['user-agent']?.slice(0, 300) ?? null;
      await ctx.prisma.session.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          createdAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          userAgent,
        },
      });
      return token;
    },
  };
  return auth;
}
