import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface VercelConfig {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

/** The share picture draws FPL photos on a canvas: they must come same-origin (`/fplimg/`), or the canvas is tainted. */
describe('vercel.json: /fplimg proxy for the share image', () => {
  it('rewrites to the FPL image CDN', () => {
    expect(vercel.rewrites).toContainEqual({
      source: '/fplimg/:path*',
      destination: 'https://resources.premierleague.com/:path*',
    });
  });
  it('sources use only the plain :path* parameter (Vercel rejects regex characters and then skips every deploy)', () => {
    const sources = [...vercel.rewrites, ...vercel.headers]
      .map((r) => r.source)
      .filter((s) => s.startsWith('/fplimg'));
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const s of sources) expect(s, s).toMatch(/^\/fplimg\/:path\*$/);
  });
  it('has long cache headers with rewrite caching on', () => {
    const rule = vercel.headers.find((h) => h.source === '/fplimg/:path*');
    const header = (k: string) =>
      rule?.headers.find((h) => h.key.toLowerCase() === k.toLowerCase())?.value ?? '';
    expect(header('x-vercel-enable-rewrite-caching')).toBe('1');
    expect(header('Cache-Control')).toMatch(/max-age=31536000/);
    expect(header('CDN-Cache-Control')).toMatch(/max-age=\d{6,}/);
  });
});
