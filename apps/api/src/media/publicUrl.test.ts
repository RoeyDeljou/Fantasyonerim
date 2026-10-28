import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { createMediaUrlMapper, mapMediaUrl, mediaUrlConfigFromEnv } from './publicUrl.js';

const B2 = 'https://f003.backblazeb2.com/file/fantasyonerim-media';
const CDN = 'https://fantasyonerim.vercel.app/media';

describe('createMediaUrlMapper', () => {
  const map = createMediaUrlMapper(B2, CDN);

  it('maps stored bucket URLs to the CDN base, keeping the key', () => {
    expect(map(`${B2}/instagram/123/0.jpg`)).toBe(`${CDN}/instagram/123/0.jpg`);
    expect(map(`${B2}/spotify/abc/thumbnail.webp`)).toBe(`${CDN}/spotify/abc/thumbnail.webp`);
    expect(map(`${B2}/uploads/u1/p1.webp`)).toBe(`${CDN}/uploads/u1/p1.webp`);
  });

  it('passes CDN URLs, foreign URLs and look-alike prefixes through unchanged', () => {
    expect(map(`${CDN}/instagram/123/0.jpg`)).toBe(`${CDN}/instagram/123/0.jpg`);
    expect(map('https://scontent.cdninstagram.com/v/abc.jpg')).toBe(
      'https://scontent.cdninstagram.com/v/abc.jpg',
    );
    expect(map(`${B2}-other/x.jpg`)).toBe(`${B2}-other/x.jpg`);
    expect(map(B2)).toBe(B2);
  });

  it('is idempotent', () => {
    const once = map(`${B2}/instagram/1/0.jpg`);
    expect(map(once)).toBe(once);
  });

  it('tolerates trailing slashes on either base', () => {
    const m = createMediaUrlMapper(`${B2}/`, `${CDN}//`);
    expect(m(`${B2}/a/b.jpg`)).toBe(`${CDN}/a/b.jpg`);
  });

  it('is the identity when either base is missing', () => {
    for (const m of [
      createMediaUrlMapper(B2, null),
      createMediaUrlMapper(null, CDN),
      createMediaUrlMapper(undefined, undefined),
    ]) {
      expect(m(`${B2}/a/b.jpg`)).toBe(`${B2}/a/b.jpg`);
    }
  });

  it('mapMediaUrl keeps null', () => {
    expect(mapMediaUrl(map, null)).toBeNull();
    expect(mapMediaUrl(map, `${B2}/a.jpg`)).toBe(`${CDN}/a.jpg`);
  });
});

describe('MEDIA_PUBLIC_BASE_URL env', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', S3_PUBLIC_BASE_URL: B2 };

  it('unset → URLs are served exactly as stored (direct bucket URLs)', () => {
    const env = loadEnv(base);
    expect(env.MEDIA_PUBLIC_BASE_URL).toBeUndefined();
    const config = mediaUrlConfigFromEnv(env);
    expect(config).toEqual({ mediaOriginBaseUrl: B2, mediaPublicBaseUrl: null });
    const map = createMediaUrlMapper(config.mediaOriginBaseUrl, config.mediaPublicBaseUrl);
    expect(map(`${B2}/instagram/1/0.jpg`)).toBe(`${B2}/instagram/1/0.jpg`);
  });

  it('blank (KEY= in Render) behaves like unset', () => {
    expect(loadEnv({ ...base, MEDIA_PUBLIC_BASE_URL: '' }).MEDIA_PUBLIC_BASE_URL).toBeUndefined();
  });

  it('set → bucket URLs are served under it (trailing slash trimmed)', () => {
    const env = loadEnv({ ...base, MEDIA_PUBLIC_BASE_URL: `${CDN}/` });
    expect(env.MEDIA_PUBLIC_BASE_URL).toBe(CDN);
    const config = mediaUrlConfigFromEnv(env);
    const map = createMediaUrlMapper(config.mediaOriginBaseUrl, config.mediaPublicBaseUrl);
    expect(map(`${B2}/instagram/1/0.jpg`)).toBe(`${CDN}/instagram/1/0.jpg`);
  });

  it('rejects a non-http value', () => {
    expect(() => loadEnv({ ...base, MEDIA_PUBLIC_BASE_URL: 'ftp://x/media' })).toThrow(
      /MEDIA_PUBLIC_BASE_URL/,
    );
  });
});
