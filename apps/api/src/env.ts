import { z } from 'zod';

const DEFAULT_DEV_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

const SecretsKeySchema = z
  .string()
  .trim()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((v) => /^https?:\/\//.test(v), 'must be an http(s) URL')
  .transform((v) => v.replace(/\/+$/, ''));

const VAPID_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;
const S3_VARS = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE_URL',
] as const;

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

    // ---- Phase 2 ----
    /** Public base URL of this API (OAuth redirect, local media URLs), e.g. https://api.example.com */
    API_PUBLIC_URL: HttpUrlSchema.optional(),
    /** Public base URL of the web app (OAuth callback redirects back here). */
    WEB_APP_URL: HttpUrlSchema.optional(),
    /** In-process scheduler (every 30 s while awake). The cron tick endpoint works either way. */
    JOBS_ENABLED: z.stringbool().default(true),
    /** Web push (VAPID). `npm run vapid -w @fant/api` prints a fresh pair. */
    VAPID_PUBLIC_KEY: z.string().trim().min(20).optional(),
    VAPID_PRIVATE_KEY: z.string().trim().min(20).optional(),
    /** mailto: or https: contact for push services. */
    VAPID_SUBJECT: z
      .string()
      .trim()
      .regex(/^(mailto:|https:\/\/)/, 'must start with mailto: or https://')
      .optional(),
    /**
     * Optional: Spotify app credentials seeded into the Spotify integration on first boot (encrypted in the DB).
     * Ignored once an admin has saved Spotify keys in the console.
     */
    SPOTIFY_CLIENT_ID: z.string().trim().min(1).optional(),
    SPOTIFY_CLIENT_SECRET: z.string().trim().min(1).optional(),
    /** Meta app (Instagram via Facebook Login for Business). */
    META_APP_ID: z.string().trim().min(1).optional(),
    META_APP_SECRET: z.string().trim().min(1).optional(),
    /** Where re-hosted media (Instagram images/videos) lives. local = dev only. */
    MEDIA_STORE: z.enum(['local', 's3']).default('local'),
    MEDIA_DIR: z.string().trim().min(1).default('./.media'),
    S3_ENDPOINT: HttpUrlSchema.optional(),
    S3_REGION: z.string().trim().min(1).default('auto'),
    S3_BUCKET: z.string().trim().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    /** Public base URL of the bucket (e.g. the R2 public/custom domain). */
    S3_PUBLIC_BASE_URL: HttpUrlSchema.optional(),
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
      const required = [
        'SECRETS_KEY',
        'CRON_SECRET',
        'API_PUBLIC_URL',
        'WEB_APP_URL',
        ...VAPID_VARS,
      ] as const;
      for (const key of required) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
      }
      if (env.MEDIA_STORE !== 's3') {
        ctx.addIssue({
          code: 'custom',
          path: ['MEDIA_STORE'],
          message: 'must be "s3" in production (the host disk is ephemeral)',
        });
      }
    }
    const vapidSet = VAPID_VARS.filter((k) => env[k] !== undefined);
    if (vapidSet.length > 0 && vapidSet.length < VAPID_VARS.length) {
      for (const key of VAPID_VARS.filter((k) => env[k] === undefined)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'VAPID_* must be set together' });
      }
    }
    if (Boolean(env.SPOTIFY_CLIENT_ID) !== Boolean(env.SPOTIFY_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SPOTIFY_CLIENT_SECRET'],
        message: 'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set together',
      });
    }
    if (Boolean(env.META_APP_ID) !== Boolean(env.META_APP_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['META_APP_SECRET'],
        message: 'META_APP_ID and META_APP_SECRET must be set together',
      });
    }
    if (env.MEDIA_STORE === 's3') {
      for (const key of S3_VARS) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when MEDIA_STORE=s3' });
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
  // `KEY=` in a .env file means "not set", not "set to an empty string".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
