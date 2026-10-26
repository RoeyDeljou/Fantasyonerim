import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, downloadMedia } from './download.js';

const respond = (
  body: ConstructorParameters<typeof Response>[0],
  headers: Record<string, string>,
  status = 200,
) => (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

describe('downloadMedia', () => {
  it('returns bytes + extension for allowed types', async () => {
    const file = await downloadMedia(
      respond(new Uint8Array([1, 2]), { 'content-type': 'image/jpeg; charset=x' }),
      'u',
      'image',
    );
    expect(file).toEqual({ bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg', ext: 'jpg' });
  });

  it('rejects wrong types, HTTP errors, oversize and empty files', async () => {
    await expect(downloadMedia(respond('x', { 'content-type': 'video/mp4' }), 'u', 'image')).rejects.toThrow(
      /content type/,
    );
    await expect(
      downloadMedia(respond('x', { 'content-type': 'image/png' }, 403), 'u', 'image'),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      downloadMedia(
        respond('x', { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) }),
        'u',
        'image',
      ),
    ).rejects.toThrow(/too large/);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 10);
    await expect(downloadMedia(respond(big, { 'content-type': 'image/png' }), 'u', 'image')).rejects.toThrow(
      /too large/,
    );
    await expect(
      downloadMedia(respond(new Uint8Array(), { 'content-type': 'image/png' }), 'u', 'image'),
    ).rejects.toThrow(/empty/);
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(downloadMedia(failing, 'u', 'video')).rejects.toThrow(/ECONNRESET/);
  });
});
