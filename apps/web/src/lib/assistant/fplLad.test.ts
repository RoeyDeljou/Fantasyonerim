import { describe, expect, it } from 'vitest';
import { FplLadEmbed, buildOptions, visitorTokenOf } from './fplLad';
import type { EmbedHost, FplLadOptions } from './fplLad';

const SCRIPT = 'https://www.fpl-lad.com/embed.js';

/** A fake page: virtual clock, recorded script tags, and a script "body" that runs on inject. */
function fakeHost(onInject?: (global: Record<string, unknown>) => void, fail = false) {
  const state = {
    now: 0,
    injected: [] as Array<{ src: string; partner: string | null }>,
    warnings: [] as string[],
  };
  const global: Record<string, unknown> = {};
  const host: EmbedHost = {
    global,
    injectScript(src, partner) {
      state.injected.push({ src, partner });
      if (fail) return Promise.reject(new Error('404'));
      onInject?.(global);
      return Promise.resolve();
    },
    sleep(ms) {
      state.now += ms;
      return Promise.resolve();
    },
    now: () => state.now,
    warn: (m) => state.warnings.push(m),
  };
  return { host, state, global };
}

/** A recording window.FPLLad, as we expect FPL Lad to ship it. */
function fakeApi({ withOn = true, withUpdate = true, initThrows = false } = {}) {
  const calls: Array<[string, unknown?]> = [];
  const listeners: Record<string, (p: unknown) => void> = {};
  const api: Record<string, unknown> = {
    init: (o: FplLadOptions) => {
      calls.push(['init', o]);
      if (initThrows) throw new Error('bad partner');
    },
    open: () => calls.push(['open']),
    close: () => calls.push(['close']),
  };
  if (withUpdate) api.update = (o: FplLadOptions) => calls.push(['update', o]);
  if (withOn)
    api.on = (e: string, cb: (p: unknown) => void) => {
      listeners[e] = cb;
    };
  return { api, calls, listeners };
}

const options = (over: Partial<Parameters<typeof buildOptions>[0]> = {}) =>
  buildOptions(
    { partner: 'fantasyonerim', teamId: 1000003, locale: 'he', theme: 'light', ...over },
    { colors: { primary: 'p', onPrimary: 'o', surface: 's' }, zIndex: 60, bottomOffset: 64 },
  );

function handlers() {
  const events = { closed: 0, tokens: [] as string[] };
  return {
    events,
    h: { onClose: () => events.closed++, onIdentity: (t: string) => events.tokens.push(t) },
  };
}

describe('FplLadEmbed (the FPL Lad script adapter)', () => {
  it('no script URL → our panel, nothing injected', async () => {
    const { host, state } = fakeHost();
    const r = await new FplLadEmbed(host).open(null, 'fantasyonerim', options(), handlers().h);
    expect(r).toEqual({ kind: 'fallback' });
    expect(state.injected).toEqual([]);
  });

  it('a script on a non-FPL-Lad host is never injected', async () => {
    const { host, state } = fakeHost();
    const r = await new FplLadEmbed(host).open('https://evil.example/x.js', null, options(), handlers().h);
    expect(r).toEqual({ kind: 'fallback' });
    expect(state.injected).toEqual([]);
    expect(state.warnings).toHaveLength(1);
  });

  it('injects the script once, then init(options) + open(); events reach our handlers', async () => {
    const fake = fakeApi();
    const { host, state } = fakeHost((g) => (g.FPLLad = fake.api));
    const embed = new FplLadEmbed(host);
    const { h, events } = handlers();
    const r = await embed.open(SCRIPT, 'fantasyonerim', options(), h);
    expect(r).toEqual({ kind: 'widget', tracksClose: true });
    expect(state.injected).toEqual([{ src: SCRIPT, partner: 'fantasyonerim' }]);
    expect(fake.calls.map((c) => c[0])).toEqual(['init', 'open']);
    expect(fake.calls[0]?.[1]).toMatchObject({
      partner: 'fantasyonerim',
      teamId: 1000003,
      locale: 'he',
      lang: 'he',
      theme: 'light',
      launcher: false,
      zIndex: 60,
      bottomOffset: 64,
    });
    fake.listeners.close?.(undefined);
    fake.listeners.identity?.({ visitorToken: 'vt_123' });
    fake.listeners.identity?.({ nope: true });
    expect(events).toEqual({ closed: 1, tokens: ['vt_123'] });

    // Second tap: no second init / script; changed options go through update().
    await embed.open(SCRIPT, 'fantasyonerim', options({ locale: 'en' }), h);
    expect(state.injected).toHaveLength(1);
    expect(fake.calls.map((c) => c[0])).toEqual(['init', 'open', 'update', 'open']);
    expect(fake.calls[2]?.[1]).toMatchObject({ locale: 'en', lang: 'en' });
    expect(state.warnings).toEqual([]);
  });

  it('concurrent taps share one script tag', async () => {
    const fake = fakeApi();
    const { host, state } = fakeHost((g) => (g.FPLLad = fake.api));
    const embed = new FplLadEmbed(host);
    await Promise.all([embed.load(SCRIPT, null), embed.load(SCRIPT, null)]);
    expect(state.injected).toHaveLength(1);
  });

  it('tolerates other global spellings and a widget without on()', async () => {
    const fake = fakeApi({ withOn: false, withUpdate: false });
    const { host } = fakeHost((g) => (g.fplLad = fake.api));
    const r = await new FplLadEmbed(host).open(SCRIPT, null, options(), handlers().h);
    expect(r).toEqual({ kind: 'widget', tracksClose: false });
  });

  it('the global never appears → falls back after the timeout, warns once, never waits again', async () => {
    const { host, state } = fakeHost(() => undefined);
    const embed = new FplLadEmbed(host, 8_000, 100);
    expect(await embed.open(SCRIPT, null, options(), handlers().h)).toEqual({ kind: 'fallback' });
    expect(state.now).toBeGreaterThanOrEqual(8_000);
    const t = state.now;
    expect(await embed.open(SCRIPT, null, options(), handlers().h)).toEqual({ kind: 'fallback' });
    expect(state.now).toBe(t);
    expect(state.injected).toHaveLength(1);
    expect(state.warnings).toHaveLength(1);
  });

  it('the script fails to load → falls back without waiting the full timeout', async () => {
    const { host, state } = fakeHost(undefined, true);
    const r = await new FplLadEmbed(host, 8_000, 100).open(SCRIPT, null, options(), handlers().h);
    expect(r).toEqual({ kind: 'fallback' });
    expect(state.now).toBeLessThan(8_000);
    expect(state.warnings).toHaveLength(1);
  });

  it('init throwing → our panel', async () => {
    const fake = fakeApi({ initThrows: true });
    const { host, state } = fakeHost((g) => (g.FPLLad = fake.api));
    const r = await new FplLadEmbed(host).open(SCRIPT, null, options(), handlers().h);
    expect(r).toEqual({ kind: 'fallback' });
    expect(fake.calls.map((c) => c[0])).toEqual(['init']);
    expect(state.warnings).toHaveLength(1);
  });

  it('a changed script URL starts over with the new script', async () => {
    const fake = fakeApi();
    const { host, state } = fakeHost((g) => (g.FPLLad = fake.api));
    const embed = new FplLadEmbed(host);
    await embed.load(SCRIPT, null);
    delete host.global.FPLLad;
    await embed.load('https://cdn.fpl-lad.com/v2/embed.js', null);
    expect(state.injected.map((i) => i.src)).toEqual([SCRIPT, 'https://cdn.fpl-lad.com/v2/embed.js']);
  });
});

describe('buildOptions / visitorTokenOf', () => {
  it('omits an unknown teamId and an absent visitor token', () => {
    const o = options({ teamId: undefined });
    expect('teamId' in o).toBe(false);
    expect('visitorToken' in o).toBe(false);
  });
  it('passes a stored visitor token back', () => {
    const o = buildOptions(
      { partner: 'p', teamId: undefined, locale: 'en', theme: 'dark' },
      { colors: { primary: '', onPrimary: '', surface: '' }, zIndex: 1, bottomOffset: 0, visitorToken: 'vt' },
    );
    expect(o.visitorToken).toBe('vt');
  });
  it('accepts only a short non-empty string token', () => {
    expect(visitorTokenOf({ visitorToken: 'abc' })).toBe('abc');
    expect(visitorTokenOf({ visitorToken: '' })).toBeNull();
    expect(visitorTokenOf({ visitorToken: 'x'.repeat(513) })).toBeNull();
    expect(visitorTokenOf({ visitorToken: 5 })).toBeNull();
    expect(visitorTokenOf(null)).toBeNull();
  });
});
