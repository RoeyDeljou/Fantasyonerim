import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api';
import { PRODUCTION_SITE_URL, proxiedPhotoUrls, resolveSiteOrigin } from './shareCaptains';

describe('proxiedPhotoUrls', () => {
  it('tries the API photo route first (absolute, on the API origin), then the same-origin proxy', () => {
    expect(proxiedPhotoUrls('223094', 'https://api.example.com/')).toEqual([
      'https://api.example.com/v1/fpl/photo/223094.png',
      '/fplimg/premierleague25/photos/players/110x140/223094.png',
    ]);
  });
  it('strips a .png / .jpg suffix from the photo code', () => {
    expect(proxiedPhotoUrls('223094.jpg', 'https://api.example.com')).toEqual([
      'https://api.example.com/v1/fpl/photo/223094.png',
      '/fplimg/premierleague25/photos/players/110x140/223094.png',
    ]);
  });
  it('defaults to the configured API base URL', () => {
    const [first] = proxiedPhotoUrls('1.png');
    expect(first).toBe(`${API_BASE_URL}/v1/fpl/photo/1.png`);
    expect(first).toMatch(/^https?:\/\//);
  });
});

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
