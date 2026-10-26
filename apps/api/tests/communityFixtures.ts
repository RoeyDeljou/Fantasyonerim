import { randomBytes } from 'node:crypto';
import {
  CommentSchema,
  CommunityPostSchema,
  EntryPicksSchema,
  UploadResponseSchema,
  type Comment,
  type CommunityPost,
  type EntryPicks,
  type UploadResponse,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { bearer } from './helpers.js';

/** A full 15-man squad (players 1..15, captain = first). */
export function makeFullPicks(entryId: number, event: number, points = 64, firstPlayer = 1): EntryPicks {
  return EntryPicksSchema.parse({
    entryId,
    event,
    activeChip: null,
    chipsUsed: [],
    picks: Array.from({ length: 15 }, (_, i) => ({
      playerId: firstPlayer + i,
      slot: i + 1,
      multiplier: i === 0 ? 2 : i < 11 ? 1 : 0,
      isCaptain: i === 0,
      isViceCaptain: i === 1,
    })),
    points,
    pointsOnBench: 4,
    transfersMade: 0,
    transfersCost: 0,
    bank: 5,
    value: 1003,
    overallRank: 4321,
    rankInGameweek: 100,
  });
}

export interface MultipartPart {
  field?: string;
  filename?: string;
  contentType?: string;
  bytes: Uint8Array;
}

/** Builds a multipart/form-data body for app.inject. */
export function multipart(parts: MultipartPart | MultipartPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----fant${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of Array.isArray(parts) ? parts : [parts]) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.field ?? 'file'}"; filename="${
          p.filename ?? 'photo.jpg'
        }"\r\nContent-Type: ${p.contentType ?? 'image/jpeg'}\r\n\r\n`,
      ),
      Buffer.from(p.bytes),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** A solid-colour image; `exif` adds EXIF orientation + GPS + camera tags (like a phone photo). */
export async function makeImage(
  format: 'jpeg' | 'png' | 'webp',
  width: number,
  height: number,
  options: { orientation?: number; exif?: boolean } = {},
): Promise<Buffer> {
  let img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 90 } },
  });
  if (options.exif === true) {
    img = img.withExif({
      IFD0: { Make: 'TestPhone', Model: 'Secret Model', Copyright: 'someone' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '34/1 46/1 0/1' },
    });
  }
  if (options.orientation !== undefined) img = img.withMetadata({ orientation: options.orientation });
  return img.toFormat(format).toBuffer();
}

export async function upload(
  app: FastifyInstance,
  token: string,
  bytes: Uint8Array,
  part: Omit<MultipartPart, 'bytes'> = {},
): Promise<UploadResponse> {
  const body = multipart({ ...part, bytes });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/uploads',
    headers: { ...bearer(token), ...body.headers },
    payload: body.payload,
  });
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  return UploadResponseSchema.parse(res.json());
}

export async function createPost(
  app: FastifyInstance,
  token: string,
  payload: Record<string, unknown> = { text: 'Who are you captaining?' },
): Promise<CommunityPost> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/community/posts',
    headers: bearer(token),
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`create post failed: ${res.statusCode} ${res.body}`);
  return CommunityPostSchema.parse(res.json());
}

export async function createComment(
  app: FastifyInstance,
  token: string,
  postId: string,
  text = 'Salah obviously',
): Promise<Comment> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/community/posts/${postId}/comments`,
    headers: bearer(token),
    payload: { text },
  });
  if (res.statusCode !== 201) throw new Error(`create comment failed: ${res.statusCode} ${res.body}`);
  return CommentSchema.parse(res.json());
}
