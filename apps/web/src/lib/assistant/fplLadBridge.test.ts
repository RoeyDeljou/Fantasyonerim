import { describe, expect, it } from 'vitest';
import {
  acceptsOrigin,
  bridgeOrigin,
  FplLadBridge,
  isSignOutMessage,
  LIMITS,
  MAX_REPLAYS_PER_LOAD,
  parseAuthComplete,
  readStoredAuth,
  REPLAY_DELAYS_MS,
  saveAuth,
} from './fplLadBridge';
import type { AuthStorage, FrameWindow } from './fplLadBridge';

const ORIGIN = 'https://www.fpl-lad.com';

const auth = (over: Record<string, unknown> = {}) => ({
  type: 'fpl-auth-complete',
  user: { id: 'u-1', email: 'fan@example.com', user_metadata: { name: 'Fan' } },
  embedToken: 'et-1',
  cookies: [
    { name: 'sb-abc-auth-token.0', value: 'base64-aaa' },
    { name: 'sb-abc-auth-token.1', value: 'bbb' },
  ],
  ...over,
});

function memoryStorage(initial: string | null = null) {
  const s = { value: initial, writes: 0, removes: 0 };
  const storage: AuthStorage = {
    read: () => s.value,
    write: (v) => {
      s.writes++;
      s.value = v;
    },
    remove: () => {
      s.removes++;
      s.value = null;
    },
  };
  return { s, storage };
}

function fakeFrame() {
  const posted: Array<{ message: unknown; target: string }> = [];
  const win: FrameWindow = { postMessage: (message, target) => posted.push({ message, target }) };
  return { win, posted };
}

function setup(stored: unknown = null) {
  const { s, storage } = memoryStorage(stored === null ? null : JSON.stringify(stored));
  const frame = fakeFrame();
  let mounted: FrameWindow | null = frame.win;
  const bridge = new FplLadBridge({ origin: ORIGIN, frame: () => mounted, storage, now: () => 1234 });
  return {
    bridge,
    s,
    storage,
    frame,
    unmount: () => {
      mounted = null;
    },
    fromFrame: (data: unknown, origin = ORIGIN) => bridge.onMessage({ origin, source: frame.win, data }),
  };
}

describe('parseAuthComplete', () => {
  it('accepts FPL Lad’s payload and keeps it as received (extra fields included)', () => {
    const p = parseAuthComplete(auth({ extra: 1 }));
    expect(p).toEqual(auth({ extra: 1 }));
  });

  it('accepts the minimal shape (user.id only)', () => {
    expect(parseAuthComplete({ type: 'fpl-auth-complete', user: { id: 'x' } })).toEqual({
      type: 'fpl-auth-complete',
      user: { id: 'x' },
    });
  });

  it('returns a copy, not the received object', () => {
    const msg = auth();
    const p = parseAuthComplete(msg);
    expect(p).not.toBe(msg);
    expect(p?.user).not.toBe(msg.user);
  });

  it.each([
    ['not an object', 'fpl-auth-complete'],
    ['null', null],
    ['an array', [auth()]],
    ['another type', auth({ type: 'fpl-render-height' })],
    ['no user', auth({ user: undefined })],
    ['user not an object', auth({ user: 'u-1' })],
    ['user.id missing', auth({ user: { email: 'x' } })],
    ['user.id a number', auth({ user: { id: 7 } })],
    ['user.id empty', auth({ user: { id: '' } })],
    ['user.id too long', auth({ user: { id: 'x'.repeat(LIMITS.userIdChars + 1) } })],
    ['embedToken not a string', auth({ embedToken: 5 })],
    ['cookies not an array', auth({ cookies: { name: 'a', value: 'b' } })],
    ['a cookie without a value', auth({ cookies: [{ name: 'a' }] })],
    ['a cookie with an empty name', auth({ cookies: [{ name: '', value: 'b' }] })],
    ['a cookie value not a string', auth({ cookies: [{ name: 'a', value: 1 }] })],
    [
      'too many cookies',
      auth({
        cookies: Array.from({ length: LIMITS.cookies + 1 }, (_, i) => ({ name: `c${i}`, value: 'v' })),
      }),
    ],
    ['too large', auth({ embedToken: 'x'.repeat(LIMITS.totalChars) })],
  ])('rejects %s', (_, data) => {
    expect(parseAuthComplete(data)).toBeNull();
  });

  it('accepts exactly the cookie limit', () => {
    const cookies = Array.from({ length: LIMITS.cookies }, (_, i) => ({ name: `c${i}`, value: 'v' }));
    expect(parseAuthComplete(auth({ cookies }))?.cookies).toHaveLength(LIMITS.cookies);
  });

  it('rejects a cyclic object instead of throwing', () => {
    const msg: Record<string, unknown> = auth();
    msg.self = msg;
    expect(parseAuthComplete(msg)).toBeNull();
  });
});

describe('isSignOutMessage', () => {
  it('knows the (future) sign-out types', () => {
    expect(isSignOutMessage({ type: 'fpl-auth-signout' })).toBe(true);
    expect(isSignOutMessage({ type: 'fpl-signout' })).toBe(true);
    expect(isSignOutMessage({ type: 'fpl-auth-complete' })).toBe(false);
    expect(isSignOutMessage('fpl-signout')).toBe(false);
  });
});

describe('origins', () => {
  it('bridges only an fpl-lad.com fallback URL', () => {
    expect(bridgeOrigin('https://www.fpl-lad.com/chat')).toBe(ORIGIN);
    expect(bridgeOrigin('https://fpl-lad.com/chat?x=1')).toBe('https://fpl-lad.com');
    expect(bridgeOrigin('https://example.com/chat')).toBeNull();
    expect(bridgeOrigin('http://www.fpl-lad.com/chat')).toBeNull();
    expect(bridgeOrigin('https://www.fpl-lad.com.evil.test/chat')).toBeNull();
    expect(bridgeOrigin('not a url')).toBeNull();
  });

  it('accepts the exact origin and its apex/www twin, nothing else', () => {
    expect(acceptsOrigin(ORIGIN, ORIGIN)).toBe(true);
    expect(acceptsOrigin('https://fpl-lad.com', ORIGIN)).toBe(true);
    expect(acceptsOrigin(ORIGIN, 'https://fpl-lad.com')).toBe(true);
    expect(acceptsOrigin('https://chat.fpl-lad.com', ORIGIN)).toBe(false);
    expect(acceptsOrigin('http://www.fpl-lad.com', ORIGIN)).toBe(false);
    expect(acceptsOrigin('https://www.fpl-lad.com:8443', ORIGIN)).toBe(false);
    expect(acceptsOrigin('https://www.fpl-lad.com.evil.test', ORIGIN)).toBe(false);
    expect(acceptsOrigin('https://evil.test', ORIGIN)).toBe(false);
    expect(acceptsOrigin('null', ORIGIN)).toBe(false);
    expect(acceptsOrigin('https://example.com', 'https://example.com')).toBe(false);
  });
});

describe('stored auth', () => {
  it('round-trips with savedAt', () => {
    const { storage } = memoryStorage();
    saveAuth(storage, parseAuthComplete(auth())!, 42);
    expect(readStoredAuth(storage)).toEqual({ payload: auth(), savedAt: 42 });
  });

  it.each([
    ['{nope'],
    ['"str"'],
    [JSON.stringify({ payload: auth() })],
    [JSON.stringify({ payload: { type: 'x' }, savedAt: 1 })],
  ])('drops a corrupt entry (%s)', (raw) => {
    const { s, storage } = memoryStorage(raw);
    expect(readStoredAuth(storage)).toBeNull();
    expect(s.value).toBeNull();
  });

  it('survives storage that throws', () => {
    const boom: AuthStorage = {
      read: () => {
        throw new Error('blocked');
      },
      write: () => {
        throw new Error('full');
      },
      remove: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredAuth(boom)).toBeNull();
    expect(() => saveAuth(boom, parseAuthComplete(auth())!, 1)).not.toThrow();
  });
});

describe('FplLadBridge', () => {
  /** A frame load followed by both timers, as the hook schedules them. */
  const loadAndTimers = (t: ReturnType<typeof setup>) => {
    t.bridge.onFrameLoad();
    for (const _ of REPLAY_DELAYS_MS) t.bridge.onReplayTimer();
  };

  it('schedules hand-backs after +1.5 s and +4 s (a slow iPhone cold start), at most 3 per load', () => {
    expect(REPLAY_DELAYS_MS).toEqual([1500, 4000]);
    expect(MAX_REPLAYS_PER_LOAD).toBe(3);
  });

  it('stores a valid fpl-auth-complete from the frame, with savedAt, and does not echo it back', () => {
    const t = setup();
    expect(t.fromFrame(auth())).toBe(true);
    expect(JSON.parse(t.s.value!)).toEqual({ payload: auth(), savedAt: 1234 });
    loadAndTimers(t);
    expect(t.frame.posted).toEqual([]);
  });

  it('a fresh sign-in mid-load stops the remaining timer hand-backs', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.bridge.onFrameLoad();
    t.bridge.onReplayTimer();
    t.fromFrame(auth({ user: { id: 'u-2' } }));
    t.bridge.onReplayTimer();
    expect(t.frame.posted).toHaveLength(1);
  });

  it('accepts the apex twin of the fallback origin', () => {
    const t = setup();
    expect(t.fromFrame(auth(), 'https://fpl-lad.com')).toBe(true);
    expect(t.s.value).not.toBeNull();
  });

  it('ignores another origin, another window, the top page itself, and junk', () => {
    const t = setup();
    expect(t.fromFrame(auth(), 'https://evil.test')).toBe(false);
    expect(t.fromFrame(auth(), 'https://www.fpl-lad.com.evil.test')).toBe(false);
    expect(t.bridge.onMessage({ origin: ORIGIN, source: {}, data: auth() })).toBe(false); // another fpl-lad frame
    expect(t.bridge.onMessage({ origin: ORIGIN, source: null, data: auth() })).toBe(false);
    expect(t.bridge.onMessage({ origin: 'http://localhost:3000', source: 'self', data: auth() })).toBe(false);
    expect(t.fromFrame(auth({ user: { id: 3 } }))).toBe(false);
    expect(t.fromFrame({ type: 'not-ours' })).toBe(false);
    expect(t.fromFrame('fpl-auth-complete')).toBe(false);
    expect(t.s.writes).toBe(0);
    expect(t.frame.posted).toEqual([]);
  });

  it('ignores everything once the frame is gone, and posts nothing to it', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.unmount();
    expect(t.fromFrame({ type: 'fpl-auth-signout' })).toBe(false);
    loadAndTimers(t);
    expect(t.frame.posted).toEqual([]);
    expect(t.s.value).not.toBeNull();
  });

  it('hands the stored payload back on each timer (the real page never messages first), to the exact origin', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    loadAndTimers(t);
    expect(t.frame.posted).toEqual([
      { message: auth(), target: ORIGIN },
      { message: auth(), target: ORIGIN },
    ]);
  });

  it('also hands back on the first fpl-* message (e.g. a future fpl-ready), once per load, within the cap', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.bridge.onFrameLoad();
    t.fromFrame({ type: 'fpl-ready' });
    t.fromFrame({ type: 'fpl-ready' });
    t.bridge.onReplayTimer();
    t.bridge.onReplayTimer();
    t.bridge.onReplayTimer(); // a stray extra timer: over the cap
    expect(t.frame.posted).toHaveLength(MAX_REPLAYS_PER_LOAD);
  });

  it('hands back to the origin the frame actually messaged from (apex vs www)', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.bridge.onFrameLoad();
    t.fromFrame({ type: 'fpl-ready' }, 'https://fpl-lad.com');
    t.bridge.onReplayTimer();
    expect(t.frame.posted.map((p) => p.target)).toEqual(['https://fpl-lad.com', 'https://fpl-lad.com']);
  });

  it('a message before the first load event still counts as the one message hand-back', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.fromFrame({ type: 'fpl-ready' });
    t.bridge.onFrameLoad();
    t.fromFrame({ type: 'fpl-ready' });
    for (const _ of REPLAY_DELAYS_MS) t.bridge.onReplayTimer();
    expect(t.frame.posted).toHaveLength(3);
  });

  it('starts over on a later load (a new page in the frame)', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.bridge.onFrameLoad();
    t.fromFrame({ type: 'fpl-ready' }, 'https://fpl-lad.com');
    t.bridge.onReplayTimer();
    t.bridge.onReplayTimer();
    t.bridge.onReplayTimer();
    expect(t.frame.posted).toHaveLength(3);
    t.bridge.onFrameLoad();
    t.bridge.onReplayTimer();
    expect(t.frame.posted.map((p) => p.target)).toEqual([
      'https://fpl-lad.com',
      'https://fpl-lad.com',
      'https://fpl-lad.com',
      ORIGIN,
    ]);
  });

  it('posts nothing when nothing is stored', () => {
    const t = setup();
    loadAndTimers(t);
    t.fromFrame({ type: 'fpl-ready' });
    expect(t.frame.posted).toEqual([]);
  });

  it('a newer sign-in replaces the stored one and is what gets handed back next time', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.fromFrame(auth({ user: { id: 'u-2' } }));
    const next = setup(JSON.parse(t.s.value!));
    loadAndTimers(next);
    expect(next.frame.posted[0]?.message).toEqual(auth({ user: { id: 'u-2' } }));
  });

  it('clears on a sign-out message from the frame (and only from the frame)', () => {
    const t = setup({ payload: auth(), savedAt: 1 });
    t.bridge.onMessage({ origin: 'https://evil.test', source: t.frame.win, data: { type: 'fpl-signout' } });
    expect(t.s.value).not.toBeNull();
    expect(t.fromFrame({ type: 'fpl-auth-signout' })).toBe(true);
    expect(t.s.value).toBeNull();
    t.bridge.onReplayTimer();
    expect(t.frame.posted).toEqual([]);
  });

  it('drops a corrupt stored entry instead of posting it', () => {
    const { storage, s } = memoryStorage('{"payload":{"type":"fpl-auth-complete","user":{}},"savedAt":1}');
    const frame = fakeFrame();
    const b = new FplLadBridge({ origin: ORIGIN, frame: () => frame.win, storage, now: () => 0 });
    b.onFrameLoad();
    b.onReplayTimer();
    expect(frame.posted).toEqual([]);
    expect(s.value).toBeNull();
  });
});
