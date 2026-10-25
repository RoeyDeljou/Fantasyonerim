import { z } from 'zod';

const DEFAULT_DEV_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

const SecretsKeySchema = z
  .string()
  .trim()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().min(1).default('0.0.0.0'),
    /** Comma-separated list of allowed browser origins. "*" is refused in production. */
    CORS_ORIGINS: z.string().default(DEFAULT_DEV_ORIGINS),
    /** Set to true behind a reverse proxy (Render) so rate limits key on the real client IP. */
    TRUST_PROXY: z.stringbool().default(false),
    FPL_MODE: z.enum(['live', 'demo']).default('live'),
    FPL_USER_AGENT: z.string().min(1).optional(),
    ADMIN_BOOTSTRAP_USERNAME: z.string().trim().min(3).max(40).optional(),
    ADMIN_BOOTSTRAP_PASSWORD: z.string().min(8).max(200).optional(),
    /** 32 random bytes, base64. Required in production. `openssl rand -base64 32` */
    SECRETS_KEY: SecretsKeySchema.optional(),
    /** Guards POST /internal/jobs/tick (Phase 2). */
    CRON_SECRET: z.string().min(16).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    const origins = parseOrigins(env.CORS_ORIGINS);
    if (env.NODE_ENV === 'production') {
      if (origins.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: '"*" is not allowed in production',
        });
      }
      if (origins.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'required in production' });
      }
      if (!env.SECRETS_KEY) {
        ctx.addIssue({ code: 'custom', path: ['SECRETS_KEY'], message: 'required in production' });
      }
    }
    if (Boolean(env.ADMIN_BOOTSTRAP_USERNAME) !== Boolean(env.ADMIN_BOOTSTRAP_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_BOOTSTRAP_PASSWORD'],
        message: 'ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD must be set together',
      });
    }
  });
export type Env = z.infer<typeof EnvSchema>;

export function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** Parses process.env; throws a readable error listing every bad variable. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
