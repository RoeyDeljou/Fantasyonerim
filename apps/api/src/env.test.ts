import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
const production = {
  ...base,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.example',
  SECRETS_KEY: randomBytes(32).toString('base64'),
  CRON_SECRET: 'c'.repeat(32),
  VAPID_PUBLIC_KEY: 'p'.repeat(60),
  VAPID_PRIVATE_KEY: 'k'.repeat(40),
  VAPID_SUBJECT: 'mailto:ops@example.com',
  API_PUBLIC_URL: 'https://api.example',
  WEB_APP_URL: 'https://app.example',
  MEDIA_STORE: 's3',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'media',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_PUBLIC_BASE_URL: 'https://media.example',
};

describe('env', () => {
  it('treats blank values (KEY= in .env) as unset', () => {
    const env = loadEnv({ ...base, FPL_USER_AGENT: '', SECRETS_KEY: '', CRON_SECRET: '  ', PORT: '' });
    expect(env.SECRETS_KEY).toBeUndefined();
    expect(env.CRON_SECRET).toBeUndefined();
    expect(env.PORT).toBe(4000);
  });

  it('applies defaults in development', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ PORT: 4000, HOST: '0.0.0.0', FPL_MODE: 'live', NODE_ENV: 'development' });
  });

  it('refuses "*" CORS and a missing SECRETS_KEY in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /CORS_ORIGINS[\s\S]*SECRETS_KEY/,
    );
    const ok = loadEnv(production);
    expect(ok.CORS_ORIGINS).toBe('https://app.example');
  });

  it('requires push, cron, URLs and S3 media in production', () => {
    for (const key of [
      'CRON_SECRET',
      'VAPID_PUBLIC_KEY',
      'VAPID_PRIVATE_KEY',
      'VAPID_SUBJECT',
      'API_PUBLIC_URL',
      'WEB_APP_URL',
      'S3_BUCKET',
      'S3_PUBLIC_BASE_URL',
    ]) {
      expect(() => loadEnv({ ...production, [key]: '' }), key).toThrow(new RegExp(key));
    }
    expect(() => loadEnv({ ...production, MEDIA_STORE: 'local' })).toThrow(/MEDIA_STORE: must be "s3"/);
    const env = loadEnv({ ...production, API_PUBLIC_URL: 'https://api.example/' });
    expect(env.API_PUBLIC_URL).toBe('https://api.example');
    expect(env.JOBS_ENABLED).toBe(true);
  });

  it('Phase 2 vars: blank = unset, paired vars validated, local media by default', () => {
    const env = loadEnv({ ...base, VAPID_PUBLIC_KEY: '', META_APP_ID: ' ', JOBS_ENABLED: 'false' });
    expect(env).toMatchObject({
      MEDIA_STORE: 'local',
      MEDIA_DIR: './.media',
      S3_REGION: 'auto',
      JOBS_ENABLED: false,
    });
    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(() => loadEnv({ ...base, VAPID_PUBLIC_KEY: 'x'.repeat(40) })).toThrow(/VAPID_PRIVATE_KEY/);
    expect(() => loadEnv({ ...base, META_APP_ID: '123' })).toThrow(/META_APP_SECRET/);
    expect(() => loadEnv({ ...base, MEDIA_STORE: 's3' })).toThrow(/S3_ENDPOINT/);
    expect(() => loadEnv({ ...base, VAPID_SUBJECT: 'me@example.com' })).toThrow(/VAPID_SUBJECT/);
  });

  it('validates SECRETS_KEY length and paired admin bootstrap vars', () => {
    expect(() => loadEnv({ ...base, SECRETS_KEY: randomBytes(8).toString('base64') })).toThrow(/SECRETS_KEY/);
    expect(() => loadEnv({ ...base, ADMIN_BOOTSTRAP_USERNAME: 'boss' })).toThrow(/ADMIN_BOOTSTRAP/);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
