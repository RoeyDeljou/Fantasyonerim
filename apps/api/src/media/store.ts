import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Where re-hosted media lives (Instagram CDN URLs expire, so every Instagram image/video is copied here).
 * Keys are deterministic (`instagram/<mediaId>/<n>.<ext>`) so a re-run overwrites instead of duplicating.
 */
export interface MediaStore {
  /** Stores the bytes and returns their public https URL. Overwrites an existing key. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** Deletes the object; a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Local store only: read back for the GET /media/* route. */
  read?(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export function contentTypeForKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Only [a-z0-9_-./] segments, no "..": keys come from our own code, but never trust a URL path. */
export function isSafeKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 300 &&
    /^[A-Za-z0-9_\-./]+$/.test(key) &&
    !key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  );
}

/** Dev only: files under MEDIA_DIR, served by GET /media/* (the host disk is ephemeral on Render). */
export class LocalDiskMediaStore implements MediaStore {
  private readonly root: string;

  constructor(
    dir: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = resolve(dir);
  }

  private pathOf(key: string): string {
    if (!isSafeKey(key)) throw new Error(`Unsafe media key: ${key}`);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error(`Unsafe media key: ${key}`);
    return path;
  }

  async put(key: string, bytes: Uint8Array, _contentType?: string): Promise<string> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return `${this.publicBaseUrl.replace(/\/+$/, '')}/media/${key}`;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async read(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!isSafeKey(key)) return null;
    try {
      return { bytes: await readFile(this.pathOf(key)), contentType: contentTypeForKey(key) };
    } catch {
      return null;
    }
  }
}

export interface S3MediaStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL of the bucket (R2 public bucket / custom domain). */
  publicBaseUrl: string;
}

/** S3-compatible object storage (Cloudflare R2 in production). */
export class S3MediaStore implements MediaStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3MediaStoreConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    if (!isSafeKey(key)) throw new Error(`Unsafe media key: ${key}`);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.config.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
