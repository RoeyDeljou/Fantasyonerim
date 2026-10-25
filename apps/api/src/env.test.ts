import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('env', () => {
  it('applies defaults in development', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ PORT: 4000, HOST: '0.0.0.0', FPL_MODE: 'live', NODE_ENV: 'development' });
  });

  it('refuses "*" CORS and a missing SECRETS_KEY in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /CORS_ORIGINS[\s\S]*SECRETS_KEY/,
    );
    const ok = loadEnv({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example',
      SECRETS_KEY: randomBytes(32).toString('base64'),
    });
    expect(ok.CORS_ORIGINS).toBe('https://app.example');
  });

  it('validates SECRETS_KEY length and paired admin bootstrap vars', () => {
    expect(() => loadEnv({ ...base, SECRETS_KEY: randomBytes(8).toString('base64') })).toThrow(/SECRETS_KEY/);
    expect(() => loadEnv({ ...base, ADMIN_BOOTSTRAP_USERNAME: 'boss' })).toThrow(/ADMIN_BOOTSTRAP/);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
