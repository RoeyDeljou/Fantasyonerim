import { describe, expect, it } from 'vitest';
import {
  IDLE_AFTER_MS,
  MAX_AUTO_RELOADS,
  RELOAD_WINDOW_MS,
  SETTLE_AFTER_MS,
  canAutoReload,
  canChunkReload,
  decideUpdate,
  isChunkLoadError,
  isNewBuild,
  isOwnAssetUrl,
  parseChunkMark,
  parseReloadLog,
  parseVersionFile,
  recordReload,
} from './appVersion';
import type { UpdateContext } from './appVersion';

describe('parseVersionFile / isNewBuild', () => {
  it('reads the build id and rejects anything else', () => {
    expect(parseVersionFile({ buildId: 'abc123-lx9', builtAt: '2026-10-28T10:00:00Z' })).toBe('abc123-lx9');
    expect(parseVersionFile({ buildId: '' })).toBeNull();
    expect(parseVersionFile({ buildId: 42 })).toBeNull();
    expect(parseVersionFile({ buildId: '<html>' })).toBeNull();
    expect(parseVersionFile('abc')).toBeNull();
    expect(parseVersionFile(null)).toBeNull();
  });

  it('any difference is an update; unknown on either side is not', () => {
    expect(isNewBuild('a', 'b')).toBe(true);
    expect(isNewBuild('b', 'a')).toBe(true); // a rollback is a deploy too
    expect(isNewBuild('a', 'a')).toBe(false);
    expect(isNewBuild(null, 'a')).toBe(false);
    expect(isNewBuild('a', null)).toBe(false);
    expect(isNewBuild(undefined, undefined)).toBe(false);
  });
});

describe('decideUpdate', () => {
  const ctx = (over: Partial<UpdateContext>): UpdateContext => ({
    trigger: 'interval',
    hasDraft: false,
    idleMs: 0,
    afterDraft: false,
    ...over,
  });

  it('reloads right away when the app was just resumed or is being hidden', () => {
    expect(decideUpdate(ctx({ trigger: 'resume' }))).toBe('reload');
    expect(decideUpdate(ctx({ trigger: 'hidden' }))).toBe('reload');
  });

  it('never reloads over a draft', () => {
    for (const trigger of ['resume', 'hidden', 'interval', 'settle'] as const) {
      expect(decideUpdate(ctx({ trigger, hasDraft: true, idleMs: 10 * IDLE_AFTER_MS }))).toBe('prompt');
    }
  });

  it('while in use: prompts, then reloads once idle', () => {
    expect(decideUpdate(ctx({ idleMs: 5_000 }))).toBe('prompt');
    expect(decideUpdate(ctx({ trigger: 'settle', idleMs: IDLE_AFTER_MS - 1 }))).toBe('prompt');
    expect(decideUpdate(ctx({ trigger: 'settle', idleMs: IDLE_AFTER_MS }))).toBe('reload');
  });

  it('after a draft is done, a short pause is enough', () => {
    expect(decideUpdate(ctx({ trigger: 'settle', afterDraft: true, idleMs: SETTLE_AFTER_MS - 1 }))).toBe(
      'prompt',
    );
    expect(decideUpdate(ctx({ trigger: 'settle', afterDraft: true, idleMs: SETTLE_AFTER_MS }))).toBe(
      'reload',
    );
  });
});

describe('reload-loop guard', () => {
  const t0 = 1_700_000_000_000;

  it('allows one auto-reload per target build', () => {
    let log = parseReloadLog(null);
    expect(canAutoReload(log, 'B', t0)).toBe(true);
    log = recordReload(log, 'B', t0);
    // reloaded, but version.json still says B and we are still on A (CDN rollout): stop
    expect(canAutoReload(log, 'B', t0 + 5_000)).toBe(false);
    // a different, newer deploy may still be reached
    expect(canAutoReload(log, 'C', t0 + 5_000)).toBe(true);
  });

  it('retries a stuck target once the window has passed', () => {
    const log = recordReload([], 'B', t0);
    expect(canAutoReload(log, 'B', t0 + RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(canAutoReload(log, 'B', t0 + RELOAD_WINDOW_MS)).toBe(true);
  });

  it('caps reloads per window even when the target keeps flip-flopping', () => {
    let log = parseReloadLog(null);
    const targets = ['B', 'A', 'C', 'D'];
    let done = 0;
    for (const [i, target] of targets.entries()) {
      if (!canAutoReload(log, target, t0 + i)) break;
      log = recordReload(log, target, t0 + i);
      done++;
    }
    expect(done).toBe(MAX_AUTO_RELOADS);
  });

  it('prunes old entries and survives corrupt storage', () => {
    const log = recordReload([{ to: 'old', at: t0 - RELOAD_WINDOW_MS * 2 }], 'B', t0);
    expect(log).toEqual([{ to: 'B', at: t0 }]);
    expect(parseReloadLog(JSON.stringify(log))).toEqual(log);
    expect(parseReloadLog('{nope')).toEqual([]);
    expect(parseReloadLog('{"to":"B"}')).toEqual([]);
    expect(parseReloadLog('[{"to":"B"},{"to":"C","at":5},7]')).toEqual([{ to: 'C', at: 5 }]);
  });
});

describe('chunk-load errors', () => {
  it('recognises webpack, Turbopack and native dynamic-import failures', () => {
    const named = Object.assign(new Error('Loading chunk 123 failed.'), { name: 'ChunkLoadError' });
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 7 failed. (/_next/static/css/a.css)'))).toBe(true);
    expect(
      isChunkLoadError(new Error('Failed to load chunk /_next/static/chunks/abc.js from module 1')),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/_next/a.js')),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError('error loading dynamically imported module')).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false); // an API call, not a chunk
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });

  it('only our own hashed assets count as chunks', () => {
    const origin = 'https://app.example';
    expect(isOwnAssetUrl('https://app.example/_next/static/chunks/a.js', origin)).toBe(true);
    expect(isOwnAssetUrl('/_next/static/css/b.css', origin)).toBe(true);
    expect(isOwnAssetUrl('https://cdn.example/_next/static/chunks/a.js', origin)).toBe(false);
    expect(isOwnAssetUrl('https://app.example/icons/icon-192.png', origin)).toBe(false);
  });

  it('reloads once per running build, no loop', () => {
    const t0 = 1_700_000_000_000;
    expect(canChunkReload(null, 'A', t0)).toBe(true);
    const mark = parseChunkMark(JSON.stringify({ build: 'A', at: t0 }));
    expect(canChunkReload(mark, 'A', t0 + 1_000)).toBe(false); // the reload did not help: stop
    expect(canChunkReload(mark, 'B', t0 + 1_000)).toBe(true); // a new build may recover once too
    expect(canChunkReload(mark, 'A', t0 + RELOAD_WINDOW_MS)).toBe(true);
    expect(parseChunkMark('garbage')).toBeNull();
  });
});
