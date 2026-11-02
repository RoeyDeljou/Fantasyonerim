import type { Session, User } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { generateSessionToken, hashToken } from './tokens.js';

/** Sliding expiry: every authenticated request pushes expiry to now + 1 year. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** The sliding-expiry DB write happens at most once per hour per session. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/**
 * A resolved session is reused from memory for this long by GET/HEAD requests (every poll carries the bearer
 * token, and the rate limiter keys on it). Logout, ban, account deletion, profile/role changes evict it at once
 * (`auth.forgetUser`); writes and admin routes always re-read the user from the database.
 */
export const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
export const SESSION_CACHE_MAX = 5000;

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
  /** Evicts every cached session of a user (after a change to the user or their sessions). */
  forgetUser(userId: string): void;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function createAuth(ctx: AppContext): Auth {
  const cache = new WeakMap<FastifyRequest, Promise<AuthContext | null>>();
  // tokenHash → resolved session (bounded LRU by insertion order).
  const sessions = new Map<string, { at: number; value: AuthContext }>();
  // One database lookup per token at a time (a poll round fires 2–3 requests at once).
  const loading = new Map<string, Promise<AuthContext | null>>();
  // Bumped by forgetUser: a lookup that started before an eviction must not put the old session back.
  let generation = 0;

  async function lookup(request: FastifyRequest, fresh = false): Promise<AuthContext | null> {
    const token = bearerToken(request);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const nowMs = ctx.clock.now().getTime();
    // Reads (the polled traffic) may use the cached session; writes always re-read the user and session, so a
    // ban, logout or role change applies to them immediately even if it was made outside this process.
    const cacheable = !fresh && (request.method === 'GET' || request.method === 'HEAD');
    const hit = cacheable ? sessions.get(tokenHash) : undefined;
    if (
      hit !== undefined &&
      nowMs - hit.at < SESSION_CACHE_TTL_MS &&
      hit.value.session.expiresAt.getTime() > nowMs
    ) {
      return hit.value;
    }
    sessions.delete(tokenHash);
    const startedAt = generation;
    let pending = cacheable ? loading.get(tokenHash) : undefined;
    if (pending === undefined) {
      const load = loadSession(tokenHash);
      pending = load;
      if (cacheable) {
        loading.set(tokenHash, load);
        void load
          .finally(() => {
            if (loading.get(tokenHash) === load) loading.delete(tokenHash);
          })
          .catch(() => undefined);
      }
    }
    const found = await pending;
    if (found !== null && cacheable && generation === startedAt) {
      sessions.set(tokenHash, { at: nowMs, value: found });
      while (sessions.size > SESSION_CACHE_MAX) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
    }
    return found;
  }

  async function loadSession(tokenHash: string): Promise<AuthContext | null> {
    const session = await ctx.prisma.session.findUnique({
      where: { tokenHash },
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
      // Always from the database: a revoked admin loses access on their very next request.
      const hasToken = bearerToken(request) !== null;
      const result = await lookup(request, true);
      if (!result)
        throw unauthorized(hasToken ? 'Session expired or invalid — please sign in again' : undefined);
      cache.set(request, Promise.resolve(result));
      if (result.user.role !== 'ADMIN') throw forbidden();
      return result;
    },
    forgetUser(userId) {
      generation += 1;
      loading.clear();
      for (const [key, entry] of sessions) if (entry.value.user.id === userId) sessions.delete(key);
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
