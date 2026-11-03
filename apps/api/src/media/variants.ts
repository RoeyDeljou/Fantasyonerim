import { setImmediate as nextTurn } from 'node:timers/promises';
import sharp from 'sharp';
import { z } from 'zod';
import type { MediaUrlMapper } from './publicUrl.js';
import type { MediaStore } from './store.js';

/**
 * Smaller WebP copies of every re-hosted image, for `srcset` (a phone list view needs 320–640 px, not a
 * 1080–2048 px original). Written next to the original as `<key>.w320.webp` / `<key>.w640.webp`, so the `/media`
 * CDN rules for the original's folder apply unchanged (immutable for platform copies, 5 minutes for `uploads/`).
 */
export const VARIANT_WIDTHS = [320, 640] as const;
export const VARIANT_QUALITY = 75;
/** Decompression-bomb guard, as for uploads (~100 MP). */
const MAX_INPUT_PIXELS = 100_000_000;

export interface VariantImage {
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** As stored on NewsMedia.variants / Upload.variants (JSON). `url` is the MediaStore URL (mapped when served). */
// A type (not an interface) so it is assignable to Prisma's JSON input type.
export type StoredVariant = {
  width: number;
  url: string;
  key: string;
};

const StoredVariantsSchema = z.array(
  z.object({ width: z.number().int().positive(), url: z.string().min(1), key: z.string().min(1) }),
);

export function variantKey(key: string, width: number): string {
  return `${key}.w${width}.webp`;
}

/** The original's key plus every variant key it may have — for deletes (a missing object is not an error). */
export function mediaKeysWithVariants(key: string): string[] {
  return [key, ...VARIANT_WIDTHS.map((w) => variantKey(key, w))];
}

/** Deletes an original and its variants. */
export async function deleteWithVariants(media: MediaStore, key: string): Promise<void> {
  for (const k of mediaKeysWithVariants(key)) await media.delete(k);
}

/**
 * Prepares sharp for a small host (0.1 CPU): one libvips worker thread and a small operation cache. Called once
 * at boot; tests keep sharp's defaults.
 */
export function configureSharpForSmallHost(): void {
  sharp.concurrency(1);
  sharp.cache({ memory: 16, files: 0, items: 20 });
}

// One image at a time across the whole process (jobs, backfill, uploads): sharp is native and fast, but on a
// 0.1-CPU host two decodes at once only make every request wait longer.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Encodes the variants of one image: auto-oriented, every metadata block dropped (sharp keeps none unless
 * asked), WebP q75, at each VARIANT_WIDTHS width strictly smaller than the original — never upscaled. Animated
 * inputs keep their first frame. Yields to the event loop between widths. Unreadable input → [].
 */
export function generateVariants(input: Uint8Array): Promise<VariantImage[]> {
  return exclusive(async () => {
    let width: number;
    try {
      const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      width = meta.autoOrient?.width ?? meta.width ?? 0;
    } catch {
      return [];
    }
    const out: VariantImage[] = [];
    for (const target of VARIANT_WIDTHS) {
      if (target >= width) break;
      await nextTurn();
      try {
        const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({ width: target, withoutEnlargement: true })
          .webp({ quality: VARIANT_QUALITY })
          .toBuffer({ resolveWithObject: true });
        out.push({ width: info.width, height: info.height, bytes: new Uint8Array(data) });
      } catch {
        break;
      }
    }
    return out;
  });
}

/** Generates and stores the variants of the image stored at `key`. Returns what to save on the row. */
export async function storeVariants(
  media: MediaStore,
  key: string,
  bytes: Uint8Array,
): Promise<StoredVariant[]> {
  const variants = await generateVariants(bytes);
  const stored: StoredVariant[] = [];
  for (const v of variants) {
    const k = variantKey(key, v.width);
    stored.push({ width: v.width, key: k, url: await media.put(k, v.bytes, 'image/webp') });
  }
  return stored;
}

/** The variants column (null = not generated yet; [] = generated, nothing smaller worth making). */
export function readStoredVariants(json: unknown): StoredVariant[] | null {
  if (json === null || json === undefined) return null;
  const parsed = StoredVariantsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** The contract's `variants` (smallest first, client URLs), or undefined when there are none. */
export function variantsForClient(
  json: unknown,
  mediaUrl: MediaUrlMapper,
): { url: string; width: number }[] | undefined {
  const stored = readStoredVariants(json);
  if (stored === null || stored.length === 0) return undefined;
  return [...stored].sort((a, b) => a.width - b.width).map((v) => ({ url: mediaUrl(v.url), width: v.width }));
}
