// Performance budget for the static export: first-load JS per route, gzipped, as a phone on mobile data
// downloads it on a cold start (every <script src> + <link rel=preload as=script> in the route's HTML).
//
//   node scripts/perf-budget.mjs [outDir=out] [--budget=240] [--json]
//
// Fails (exit 1) when a fan route (the five tabs) ships more than the budget, or when a fan route's JS contains
// admin console code (admin code must never load for fans). Every other route is listed for information. Runs after
// every build (package.json "postbuild").
//
// The budget is a regression guard set just above today's figure; the target is 200 KB, and the gap is the Zod
// runtime pulled in by @fant/shared (docs/PERFORMANCE.md, Web).
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find((a) => !a.startsWith('--'));
const out = path.resolve(WEB_DIR, outArg ?? 'out');
const budgetKb = Number(args.find((a) => a.startsWith('--budget='))?.split('=')[1] ?? 240);
const asJson = args.includes('--json');
const TARGET_KB = 200;
const print = (line) => process.stdout.write(`${line}\n`);

/** The five tabs a fan opens: they carry the budget. */
const FAN_ROUTES = ['news', 'live', 'my-team', 'table', 'community'];
/** Listed, not budgeted. */
const OTHER_ROUTES = ['', 'profile', 'onboarding', 'terms', 'admin', 'admin/login'];

const gzCache = new Map();
function gzipKb(file) {
  if (!gzCache.has(file)) {
    const buf = readFileSync(path.join(out, file));
    gzCache.set(file, { raw: buf.length / 1024, gz: gzipSync(buf, { level: 9 }).length / 1024 });
  }
  return gzCache.get(file);
}

function scriptsOf(route) {
  const html = readFileSync(path.join(out, route, 'index.html'), 'utf8');
  const srcs = new Set();
  // noModule = legacy polyfills, never downloaded by a modern browser (iOS Safari 11+, any Chromium).
  for (const m of html.matchAll(/<script([^>]*)\ssrc="(\/_next\/[^"]+\.js)"([^>]*)>/g)) {
    if (!/noModule/i.test(m[1] + m[3])) srcs.add(m[2]);
  }
  for (const m of html.matchAll(/<link[^>]*rel="preload"[^>]*as="script"[^>]*href="(\/_next\/[^"]+\.js)"/g))
    srcs.add(m[1]);
  const css = new Set();
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(\/_next\/[^"]+\.css)"/g))
    css.add(m[1]);
  return { js: [...srcs], css: [...css] };
}

if (!existsSync(path.join(out, 'news', 'index.html'))) {
  console.error(`perf-budget: no static export in ${out} (run the build first)`);
  process.exit(1);
}

const routes = [...FAN_ROUTES, ...OTHER_ROUTES].filter((r) => existsSync(path.join(out, r, 'index.html')));
const report = routes.map((r) => {
  const { js, css } = scriptsOf(r);
  const sum = (files) =>
    files.reduce(
      (s, f) => {
        const k = gzipKb(f);
        return { raw: s.raw + k.raw, gz: s.gz + k.gz };
      },
      { raw: 0, gz: 0 },
    );
  return { route: `/${r}${r ? '/' : ''}`, key: r, js, jsKb: sum(js), cssKb: sum(css), chunks: js.length };
});

// Chunks used by the admin console and by no route a fan can open.
const fanFacing = new Set(report.filter((r) => !r.key.startsWith('admin')).flatMap((r) => r.js));
const adminRoutes = report.filter((r) => r.key.startsWith('admin'));
const adminOnly = new Set(adminRoutes.flatMap((r) => r.js).filter((f) => !fanFacing.has(f)));

const failures = [];
for (const r of report) {
  if (!FAN_ROUTES.includes(r.key)) continue;
  if (r.jsKb.gz > budgetKb)
    failures.push(`${r.route} ships ${r.jsKb.gz.toFixed(1)} KB gzipped JS (budget ${budgetKb} KB)`);
}
// Admin-only content must not leak in through a shared chunk: look for the admin screen's marker in fan chunks.
const ADMIN_MARKER = 'data-admin-console';
for (const f of fanFacing) {
  if (readFileSync(path.join(out, f), 'utf8').includes(ADMIN_MARKER))
    failures.push(`${f} (loaded by a fan route) contains admin console code`);
}

if (asJson) {
  print(JSON.stringify({ budgetKb, report, adminOnlyChunks: [...adminOnly], failures }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (n) => n.toFixed(1).padStart(8);
  print(`perf-budget: first-load JS per route (${path.relative(WEB_DIR, out) || '.'}), KB`);
  print(
    `${pad('route', 16)}${pad('chunks', 8)}${'js raw'.padStart(8)}${'js gz'.padStart(8)}${'css gz'.padStart(8)}`,
  );
  for (const r of report) {
    const mark = FAN_ROUTES.includes(r.key) ? (r.jsKb.gz > budgetKb ? ' ✗' : ' ✓') : '';
    print(
      `${pad(r.route, 16)}${pad(r.chunks, 8)}${num(r.jsKb.raw)}${num(r.jsKb.gz)}${num(r.cssKb.gz)}${mark}`,
    );
  }
  print(
    `budget: fan routes ≤ ${budgetKb} KB gzipped JS (target ${TARGET_KB} KB); admin-only chunks: ${adminOnly.size}`,
  );
}
if (failures.length) {
  for (const f of failures) console.error(`perf-budget: ✗ ${f}`);
  process.exit(1);
}
if (!asJson) print('perf-budget: ✓ within budget');
