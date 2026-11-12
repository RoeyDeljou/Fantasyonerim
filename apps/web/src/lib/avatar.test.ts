import { describe, expect, it } from 'vitest';
import type { FplEntryId } from '@fant/shared';
import { AVATAR_MAX_BYTES, avatarMap, avatarProblem, checkAvatarFile } from './avatar';
import { ApiRequestError } from './api';
import { CDN_PATHS } from './cdn';

const id = (n: number) => n as FplEntryId;

describe('checkAvatarFile', () => {
  it('accepts images up to 10 MB', () => {
    expect(checkAvatarFile({ type: 'image/jpeg', name: 'a.jpg', size: 1_000 })).toBeNull();
    expect(checkAvatarFile({ type: 'image/png', name: 'a.png', size: AVATAR_MAX_BYTES })).toBeNull();
  });
  it('accepts HEIC by extension when the browser gives no type', () => {
    expect(checkAvatarFile({ type: '', name: 'IMG_0001.HEIC', size: 5_000 })).toBeNull();
    expect(checkAvatarFile({ type: '', name: 'x.heif', size: 5_000 })).toBeNull();
  });
  it('rejects non-images and files over the limit', () => {
    expect(checkAvatarFile({ type: 'application/pdf', name: 'a.pdf', size: 10 })).toBe('type');
    expect(checkAvatarFile({ type: 'image/jpeg', name: 'a.jpg', size: AVATAR_MAX_BYTES + 1 })).toBe('size');
  });
});

describe('avatarProblem', () => {
  it('maps the API answers to messages', () => {
    expect(avatarProblem(new ApiRequestError('payload_too_large', 413, ''))).toBe('size');
    expect(avatarProblem(new ApiRequestError('unsupported_media_type', 415, ''))).toBe('type');
    expect(avatarProblem(new ApiRequestError('rate_limited', 429, ''))).toBe('rateLimited');
    expect(avatarProblem(new ApiRequestError('forbidden', 403, ''))).toBe('banned');
    expect(avatarProblem(new ApiRequestError('network', 0, ''))).toBe('network');
    expect(avatarProblem(new ApiRequestError('internal', 500, ''))).toBe('generic');
    expect(avatarProblem(new Error('x'))).toBe('generic');
    expect(avatarProblem(null)).toBe('generic');
  });
});

describe('avatarMap', () => {
  const list = [
    { entryId: id(1), url: 'https://m.test/1.jpg' },
    { entryId: id(2), url: 'https://m.test/2.jpg' },
  ];
  it('maps entryId to URL', () => {
    const m = avatarMap(list, undefined);
    expect(m.get(id(1))).toBe('https://m.test/1.jpg');
    expect(m.get(id(3))).toBeUndefined();
  });
  it("the signed-in fan's own entry follows Me (new photo, or removed)", () => {
    expect(avatarMap(list, { entryId: id(2), avatarUrl: 'https://m.test/new.jpg' }).get(id(2))).toBe(
      'https://m.test/new.jpg',
    );
    expect(avatarMap(list, { entryId: id(3), avatarUrl: 'https://m.test/3.jpg' }).get(id(3))).toBe(
      'https://m.test/3.jpg',
    );
    expect(avatarMap(list, { entryId: id(1), avatarUrl: null }).has(id(1))).toBe(false);
    expect(avatarMap(list, { entryId: null, avatarUrl: 'https://m.test/x.jpg' }).size).toBe(2);
  });
});

describe('league avatars are CDN JSON', () => {
  it('GET /v1/league/avatars goes through the same-origin CDN path on the web build', () => {
    expect(CDN_PATHS).toContain('/v1/league/avatars');
  });
});
