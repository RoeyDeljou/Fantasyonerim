import { randomUUID } from 'node:crypto';
import { UploadResponseSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import { requireWriter } from '../community/guard.js';
import { MAX_UPLOAD_BYTES, processUpload } from '../community/images.js';
import type { AppContext } from '../context.js';
import { ApiHttpError, badRequest } from '../errors.js';
import { serialize } from '../validate.js';

/** Unused uploads (never attached to a post) are deleted by the hourly cleanup job after this. */
export const UNUSED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function isFileTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

/**
 * POST /v1/uploads — multipart field "file". The bytes are sniffed (never the header/filename), decoded and
 * re-encoded to webp with every metadata block dropped, then stored as `uploads/<userId>/<uploadId>.webp`.
 */
export function uploadRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, limit: object): void {
  const { prisma } = ctx;

  app.post('/v1/uploads', { config: { rateLimit: limit } }, async (request, reply) => {
    const { user } = await requireWriter(auth, request);
    if (!request.isMultipart()) throw badRequest('Send the image as multipart/form-data field "file"');

    let bytes: Buffer;
    try {
      const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });
      if (file === undefined || file.fieldname !== 'file') {
        throw badRequest('Send the image as multipart/form-data field "file"');
      }
      bytes = await file.toBuffer();
    } catch (err) {
      if (isFileTooLarge(err)) {
        throw new ApiHttpError(413, 'bad_request', 'The image is larger than 10 MB');
      }
      throw err;
    }
    if (bytes.length === 0) throw badRequest('file: empty upload');

    const image = await processUpload(bytes);
    const uploadId = randomUUID();
    const storageKey = `uploads/${user.id}/${uploadId}.webp`;
    const url = await ctx.media.put(storageKey, image.bytes, image.contentType);
    try {
      await prisma.upload.create({
        data: {
          id: uploadId,
          ownerId: user.id,
          storageKey,
          url,
          width: image.width,
          height: image.height,
          contentType: image.contentType,
          createdAt: ctx.clock.now(),
        },
      });
    } catch (err) {
      await ctx.media.delete(storageKey).catch(() => undefined);
      throw err;
    }
    return reply.code(201).send(
      serialize(UploadResponseSchema, {
        uploadId,
        image: { url, width: image.width, height: image.height },
      }),
    );
  });
}
