import { randomUUID } from 'node:crypto';
import { UploadResponseSchema } from '@fant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import { requireWriter } from '../community/guard.js';
import { MAX_UPLOAD_BYTES, processUpload } from '../community/images.js';
import type { AppContext } from '../context.js';
import { ApiHttpError, badRequest } from '../errors.js';
import { storeVariants, variantsForClient, type StoredVariant } from '../media/variants.js';
import { serialize } from '../validate.js';

/**
 * The smaller copies are included in the upload response only when they are ready within this budget; otherwise
 * the response goes out and they finish in the background (the post reads them from the Upload row). On a 0.1-CPU
 * host a phone photo's variants take ~2 s, so in production they practically always finish after the response.
 */
export const UPLOAD_VARIANTS_BUDGET_MS = 300;

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
 * Reads the multipart field "file" (≤ MAX_UPLOAD_BYTES) into memory: 400 when it is missing or empty, 413 when
 * too large. The bytes are not trusted in any way yet (processUpload / processAvatar sniff and re-encode them).
 */
export async function readImageFile(request: FastifyRequest): Promise<Buffer> {
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
      throw new ApiHttpError(413, 'payload_too_large', 'The image is larger than 10 MB');
    }
    throw err;
  }
  if (bytes.length === 0) throw badRequest('file: empty upload');
  return bytes;
}

/**
 * POST /v1/uploads — multipart field "file". The bytes are sniffed (never the header/filename), decoded and
 * re-encoded to webp with every metadata block dropped, then stored as `uploads/<userId>/<uploadId>.webp`.
 */
export function uploadRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, limit: object): void {
  const { prisma } = ctx;

  app.post('/v1/uploads', { config: { rateLimit: limit } }, async (request, reply) => {
    const { user } = await requireWriter(auth, request);
    const bytes = await readImageFile(request);
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
    // Smaller copies: one image at a time process-wide (media/variants.ts), saved on the row when done.
    const started = performance.now();
    const variants = storeVariants(ctx.media, storageKey, image.bytes)
      .then(async (stored) => {
        await prisma.upload.updateMany({ where: { id: uploadId }, data: { variants: stored } });
        request.log.info(
          { uploadId, variants: stored.length, ms: Math.round(performance.now() - started) },
          'upload variants stored',
        );
        return stored;
      })
      .catch((err: unknown) => {
        request.log.warn({ err, uploadId }, 'upload variants failed');
        return null;
      });
    const ready = await Promise.race([
      variants,
      new Promise<'later'>((resolve) =>
        setTimeout(() => resolve('later'), UPLOAD_VARIANTS_BUDGET_MS).unref(),
      ),
    ]);
    const done: StoredVariant[] | null = ready === 'later' ? null : ready;
    return reply.code(201).send(
      serialize(UploadResponseSchema, {
        uploadId,
        image: {
          url: ctx.mediaUrl(url),
          width: image.width,
          height: image.height,
          ...(done === null ? {} : optionalVariants(variantsForClient(done, ctx.mediaUrl))),
        },
      }),
    );
  });
}

function optionalVariants(v: { url: string; width: number }[] | undefined) {
  return v === undefined ? {} : { variants: v };
}
