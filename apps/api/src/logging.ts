import type { FastifyRequest, FastifyServerOptions } from 'fastify';

const INVITE_PATH = /^\/v1\/admin-invites\/.*/;

/**
 * What a logged URL may contain: never the query string (it can carry tokens), and never anything after
 * `/v1/admin-invites/` (older clients/links put the raw invite token in the path).
 */
export function redactUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return INVITE_PATH.test(path) ? '/v1/admin-invites/[redacted]' : path;
}

/** Replaces Fastify's default `req` serializer (method, url, host, remote address — no headers). */
export function safeRequestSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket.remotePort ?? 0,
  };
}

type LoggerOption = FastifyServerOptions['logger'];
type LoggerConfig = Exclude<LoggerOption, undefined>;

/** Adds the safe `req` serializer to any logger config (true / options object); false stays false. */
export function withSafeLogging(logger: LoggerOption): LoggerConfig {
  if (logger === undefined || logger === false) return false;
  const base = logger === true ? {} : logger;
  return { ...base, serializers: { ...base.serializers, req: safeRequestSerializer } };
}
