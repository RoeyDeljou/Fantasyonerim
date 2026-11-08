/**
 * Where bearer tokens live. The interface is async so the Capacitor shell can swap in
 * `@capacitor/preferences` (or the Keychain) without touching any caller.
 *
 * Two slots: `session` is the active token; `fan` holds a fan's token while an admin session is active on the
 * same device, so signing out of admin restores the fan instead of logging them out.
 */
export type TokenSlot = 'session' | 'fan';

export interface TokenStore {
  get(slot?: TokenSlot): Promise<string | null>;
  set(token: string, slot?: TokenSlot): Promise<void>;
  clear(slot?: TokenSlot): Promise<void>;
}

const KEYS: Record<TokenSlot, string> = { session: 'fant.token', fan: 'fant.token.fan' };
const memory: Record<TokenSlot, string | null> = { session: null, fan: null };

export const localStorageTokenStore: TokenStore = {
  async get(slot = 'session') {
    let token: string | null;
    try {
      token = window.localStorage.getItem(KEYS[slot]) ?? memory[slot];
    } catch {
      return memory[slot];
    }
    if (slot !== 'session') return token;
    if (token === null) return adoptHandoff();
    refreshHandoffOnce();
    return token;
  },
  async set(token, slot = 'session') {
    memory[slot] = token;
    try {
      window.localStorage.setItem(KEYS[slot], token);
    } catch {
      // storage blocked (private mode) — the token lives only in memory for this tab
    }
    syncHandoff();
  },
  async clear(slot = 'session') {
    memory[slot] = null;
    try {
      window.localStorage.removeItem(KEYS[slot]);
    } catch {
      // ignore
    }
    syncHandoff();
  },
};

// ---------- browser → home-screen hand-off ----------
//
// On iOS a home-screen app gets its own, empty localStorage, but Safari's cookies are copied into it once, when
// "Add to Home Screen" is tapped. So the signed-in account is mirrored into a cookie and the home-screen app adopts
// it on its first launch — nobody has to type a recovery code after installing. The cookie is scoped to
// /handoff/ (a tiny static page): it is never sent with app, API, /cdn or /media requests, and it is read through
// a hidden same-origin iframe of that page. Auth itself stays a bearer token.

export const HANDOFF_COOKIE = 'fant_handoff';
export const HANDOFF_PATH = '/handoff/';
/** Set once the home-screen hand-off has been tried on this device's storage (it only ever applies once). */
const HANDOFF_CHECKED = 'fant.handoff.checked';
const HANDOFF_TIMEOUT_MS = 2500;
const YEAR_S = 365 * 24 * 3600;

function handoffSupported(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  // The native shell has one storage for everything; nothing to hand off.
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !(cap?.isNativePlatform?.() ?? false);
}

function writeHandoffCookie(token: string | null): void {
  if (!handoffSupported()) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  try {
    document.cookie =
      token === null
        ? `${HANDOFF_COOKIE}=; Path=${HANDOFF_PATH}; Max-Age=0; SameSite=Strict${secure}`
        : `${HANDOFF_COOKIE}=${encodeURIComponent(token)}; Path=${HANDOFF_PATH}; Max-Age=${YEAR_S}; SameSite=Strict${secure}`;
  } catch {
    // cookies blocked — the recovery code still works
  }
}

/** The account to hand off: the fan's own session when an admin session is stacked on top of it. */
function syncHandoff(): void {
  try {
    const fan = window.localStorage.getItem(KEYS.fan) ?? memory.fan;
    const session = window.localStorage.getItem(KEYS.session) ?? memory.session;
    writeHandoffCookie(fan ?? session);
  } catch {
    writeHandoffCookie(memory.fan ?? memory.session);
  }
}

let refreshed = false;
/** Safari caps script-set cookies at 7 days: re-write it on each app start so it is fresh when they install. */
function refreshHandoffOnce(): void {
  if (refreshed) return;
  refreshed = true;
  syncHandoff();
}

export function parseHandoffCookie(cookie: string): string | null {
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== HANDOFF_COOKIE) continue;
    const value = rest.join('=');
    if (value === '') return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads the hand-off cookie through a hidden iframe of /handoff/ (the only document that can see it). */
function readHandoffCookie(): Promise<string | null> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      frame.remove();
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), HANDOFF_TIMEOUT_MS);
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.onload = () => {
      try {
        done(parseHandoffCookie(frame.contentDocument?.cookie ?? ''));
      } catch {
        done(null);
      }
    };
    frame.onerror = () => done(null);
    frame.src = HANDOFF_PATH;
    document.body.appendChild(frame);
  });
}

let adopting: Promise<string | null> | null = null;
/** No session on this storage: once, look for an account handed over from the browser. */
function adoptHandoff(): Promise<string | null> {
  if (!handoffSupported() || document.body === null) return Promise.resolve(null);
  try {
    if (window.localStorage.getItem(HANDOFF_CHECKED) !== null) return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  adopting ??= readHandoffCookie().then((token) => {
    try {
      window.localStorage.setItem(HANDOFF_CHECKED, '1');
      if (token !== null) window.localStorage.setItem(KEYS.session, token);
    } catch {
      // storage blocked — use it for this tab only
    }
    if (token !== null) memory.session = token;
    return token;
  });
  return adopting;
}

let active: TokenStore = localStorageTokenStore;

/** The store every caller uses. Swap with `setTokenStore()` at boot (e.g. in the native shell). */
export const tokenStore: TokenStore = {
  get: (slot) => active.get(slot),
  set: (token, slot) => active.set(token, slot),
  clear: (slot) => active.clear(slot),
};

export function setTokenStore(store: TokenStore): void {
  active = store;
}
