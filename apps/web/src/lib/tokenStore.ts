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
    try {
      return window.localStorage.getItem(KEYS[slot]) ?? memory[slot];
    } catch {
      return memory[slot];
    }
  },
  async set(token, slot = 'session') {
    memory[slot] = token;
    try {
      window.localStorage.setItem(KEYS[slot], token);
    } catch {
      // storage blocked (private mode) — the token lives only in memory for this tab
    }
  },
  async clear(slot = 'session') {
    memory[slot] = null;
    try {
      window.localStorage.removeItem(KEYS[slot]);
    } catch {
      // ignore
    }
  },
};

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
