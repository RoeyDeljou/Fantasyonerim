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
  it('the header source uses the proven `(.*)` form, the rewrite the plain :path* form', () => {
    // Vercel rejects header sources with any other regex characters and then skips every deploy.
    expect(vercel.headers.filter((h) => h.source.startsWith('/fplimg')).map((h) => h.source)).toEqual([
      '/fplimg/(.*)',
    ]);
    expect(vercel.rewrites.filter((r) => r.source.startsWith('/fplimg')).map((r) => r.source)).toEqual([
      '/fplimg/:path*',
    ]);
  });
  it('has long cache headers with rewrite caching on', () => {
    const rule = vercel.headers.find((h) => h.source === '/fplimg/(.*)');
    const header = (k: string) =>
      rule?.headers.find((h) => h.key.toLowerCase() === k.toLowerCase())?.value ?? '';
    expect(header('x-vercel-enable-rewrite-caching')).toBe('1');
    expect(header('Cache-Control')).toMatch(/max-age=31536000/);
    expect(header('CDN-Cache-Control')).toMatch(/max-age=\d{6,}/);
  });
});
