import sharp, { type Sharp } from 'sharp';
import { ApiHttpError } from '../errors.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 2048;
export const WEBP_QUALITY = 82;
/** Decompression-bomb guard (~100 MP; a 48 MP phone photo is fine). */
const MAX_INPUT_PIXELS = 100_000_000;

export type SniffedImage = 'jpeg' | 'png' | 'webp' | 'heic';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif']);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Detects the format from magic bytes only — the filename and Content-Type header are never trusted. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 12))) return 'heic';
  return null;
}

export const unsupportedMedia = (message: string) => new ApiHttpError(415, 'unsupported_media_type', message);

export interface ProcessedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  contentType: 'image/webp';
}

/**
 * Re-encodes an uploaded photo: auto-rotates by EXIF orientation, drops ALL metadata (EXIF, GPS, XMP,
 * ICC — sharp keeps none unless asked), fits it inside 2048×2048 (never upscales) and writes webp.
 * Animated inputs keep only their first frame.
 */
export async function processUpload(input: Uint8Array): Promise<ProcessedImage> {
  return decodeAndEncode(input, async (img) => {
    const { data, info } = await img
      .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      width: info.width,
      height: info.height,
      contentType: 'image/webp' as const,
    };
  });
}

/** Profile photos: one square JPEG of this side (2× a 128 px circle on a retina screen). */
export const AVATAR_SIDE = 256;
export const AVATAR_JPEG_QUALITY = 82;

export interface ProcessedAvatar {
  bytes: Uint8Array;
  contentType: 'image/jpeg';
}

/**
 * Re-encodes a profile photo with the same sniffing / decoding rules as processUpload: auto-rotates by EXIF
 * orientation, centre-crops to a square, resizes to 256×256 (small images are upscaled so every avatar has the
 * same size) and writes a JPEG with ALL metadata dropped (sharp keeps none unless asked).
 */
export async function processAvatar(input: Uint8Array): Promise<ProcessedAvatar> {
  return decodeAndEncode(input, async (img) => {
    const data = await img
      .resize(AVATAR_SIDE, AVATAR_SIDE, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: AVATAR_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { bytes: new Uint8Array(data), contentType: 'image/jpeg' as const };
  });
}

/** Sniffs the bytes (415 for anything but JPEG / PNG / WebP / HEIC), decodes + auto-rotates, then `encode`s. */
async function decodeAndEncode<T>(input: Uint8Array, encode: (img: Sharp) => Promise<T>): Promise<T> {
  const kind = sniffImage(input);
  if (kind === null)
    throw unsupportedMedia('Unsupported image type — upload a JPEG, PNG, WebP or HEIC photo');
  try {
    return await encode(sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).rotate());
  } catch {
    throw unsupportedMedia(
      kind === 'heic'
        ? "This HEIC photo couldn't be read — set the camera to “Most Compatible” or upload a JPEG"
        : "This image couldn't be read — it may be damaged",
    );
  }
}
