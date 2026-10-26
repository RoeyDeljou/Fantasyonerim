/**
 * Downloads a remote media file for re-hosting: timeout, size cap, content-type allow-list.
 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60_000;

const ALLOWED: Record<string, { ext: string; kind: 'image' | 'video' }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/jpg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
};

export class MediaDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaDownloadError';
  }
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

export async function downloadMedia(
  fetchImpl: typeof fetch,
  url: string,
  expected: 'image' | 'video',
  options: { timeoutMs?: number } = {},
): Promise<DownloadedMedia> {
  const max = expected === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new MediaDownloadError(`download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new MediaDownloadError(`download failed with HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const allowed = ALLOWED[contentType];
  if (allowed === undefined || allowed.kind !== expected) {
    await res.body?.cancel().catch(() => undefined);
    throw new MediaDownloadError(`unexpected content type "${contentType || 'none'}" for ${expected}`);
  }
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new MediaDownloadError(`file too large (${declared} bytes, max ${max})`);
  }
  if (res.body === null) throw new MediaDownloadError('empty response body');

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new MediaDownloadError(`file too large (over ${max} bytes)`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MediaDownloadError) throw err;
    throw new MediaDownloadError(`download interrupted: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (total === 0) throw new MediaDownloadError('empty file');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType, ext: allowed.ext };
}
