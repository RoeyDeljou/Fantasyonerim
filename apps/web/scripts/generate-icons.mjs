// Generates the PWA / favicon / UI icon set from public/brand/logo.png.
// Run with `npm run icons -w @fant/web`; the outputs are committed.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public/brand/logo.png');
const outDir = path.join(root, 'public/icons');
// Brand mint (logo background). Kept in sync with src/app/theme.css and the manifest.
const MINT = { r: 199, g: 239, b: 213, alpha: 1 };

/** The source PNG has a thin dark frame on two edges — trim it off and square the image. */
async function squareLogo() {
  const meta = await sharp(src).metadata();
  const inset = 6;
  const side = Math.min((meta.width ?? 0) - inset * 2, (meta.height ?? 0) - inset * 2);
  return sharp(src)
    .extract({ left: inset, top: inset, width: side, height: side })
    .flatten({ background: MINT })
    .png()
    .toBuffer();
}

async function plain(base, size, file) {
  const buf = await sharp(base).resize(size, size, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(path.join(outDir, file), buf);
  return buf;
}

/** Maskable: the artwork shrunk into the 80% safe zone on a full-bleed mint square. */
async function maskable(base, size, file) {
  const inner = Math.round(size * 0.72);
  const art = await sharp(base).resize(inner, inner).png().toBuffer();
  const buf = await sharp({ create: { width: size, height: size, channels: 4, background: MINT } })
    .composite([{ input: art, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(outDir, file), buf);
}

/** Minimal ICO container holding PNG-encoded images (supported by every modern browser). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

await mkdir(outDir, { recursive: true });
const base = await squareLogo();
await plain(base, 192, 'icon-192.png');
await plain(base, 512, 'icon-512.png');
await maskable(base, 512, 'icon-maskable-512.png');
await plain(base, 180, 'apple-touch-icon.png');
const f32 = await plain(base, 32, 'favicon-32.png');
const f48 = await sharp(base).resize(48, 48).png().toBuffer();
await writeFile(
  path.join(root, 'public/favicon.ico'),
  ico([
    { size: 32, data: f32 },
    { size: 48, data: f48 },
  ]),
);
// Compact copy of the logo for in-app use (top bar, onboarding hero) — the original is ~250 KB.
await sharp(base)
  .resize(320, 320)
  .png({ compressionLevel: 9, palette: true })
  .toFile(path.join(root, 'public/brand/logo-320.png'));
console.warn('icons written to public/icons, public/favicon.ico, public/brand/logo-320.png');
