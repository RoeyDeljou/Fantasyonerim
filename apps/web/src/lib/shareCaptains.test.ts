import { describe, expect, it } from 'vitest';
import { PRODUCTION_SITE_URL, resolveSiteOrigin } from './shareCaptains';

describe('resolveSiteOrigin', () => {
  it('the env override wins', () => {
    expect(resolveSiteOrigin('https://x.example', 'localhost', 'http://localhost:3000')).toBe(
      'https://x.example',
    );
  });
  it('localhost and 127.0.0.1 use their own origin', () => {
    expect(resolveSiteOrigin(undefined, 'localhost', 'http://localhost:5300')).toBe('http://localhost:5300');
    expect(resolveSiteOrigin('', '127.0.0.1', 'http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });
  it('previews and native shells share the production address', () => {
    expect(resolveSiteOrigin(undefined, 'app-git-x.vercel.app', 'https://app-git-x.vercel.app')).toBe(
      PRODUCTION_SITE_URL,
    );
    expect(resolveSiteOrigin(undefined, 'localhost.example', 'capacitor://localhost')).toBe(
      PRODUCTION_SITE_URL,
    );
    expect(PRODUCTION_SITE_URL).toBe('https://fantasyonerim.vercel.app');
  });
});
