// Post-build step for the static export (runs as `postbuild`, and from e2e/run.mjs for its own copy):
//   - reads the build id the HTML was rendered with (<html data-build="…">, set from NEXT_PUBLIC_BUILD_ID)
//   - writes <out>/version.json  → { buildId, builtAt }  (served no-store; installed apps poll it)
//   - stamps <out>/sw.js         → replaces __BUILD_ID__ so every deploy gets fresh cache names and the browser
//                                  sees a byte-different worker (that is what triggers a service worker update)
//
//   node scripts/stamp-build.mjs [outDir=out]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(WEB_DIR, process.argv[2] ?? 'out');

const html = readFileSync(path.join(out, 'index.html'), 'utf8');
const match = /<html[^>]*\sdata-build="([^"]+)"/.exec(html);
if (!match) {
  console.error(`stamp-build: no <html data-build> in ${out}/index.html`);
  process.exit(1);
}
const buildId = match[1];
if (!/^[\w.-]{1,80}$/.test(buildId)) {
  console.error(`stamp-build: unexpected build id "${buildId}"`);
  process.exit(1);
}

writeFileSync(
  path.join(out, 'version.json'),
  JSON.stringify({ buildId, builtAt: new Date().toISOString() }) + '\n',
);

const swPath = path.join(out, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
if (!sw.includes('__BUILD_ID__')) {
  console.error('stamp-build: sw.js has no __BUILD_ID__ placeholder (already stamped?)');
  process.exit(1);
}
writeFileSync(swPath, sw.replaceAll('__BUILD_ID__', buildId));
console.warn(`stamp-build: ${path.relative(WEB_DIR, out)} → build ${buildId}`);
