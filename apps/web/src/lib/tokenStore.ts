/**
 * Where the bearer token lives. The interface is async so the Capacitor shell can swap in
 * `@capacitor/preferences` (or the Keychain) without touching any caller.
 */
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'fant.token';

export const localStorageTokenStore: TokenStore = {
  async get() {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  async set(token) {
    try {
      window.localStorage.setItem(KEY, token);
    } catch {
      // storage blocked (private mode) — the session lives only in memory for this tab
      memoryToken = token;
    }
  },
  async clear() {
    memoryToken = null;
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  },
};

let memoryToken: string | null = null;

let active: TokenStore = localStorageTokenStore;

/** The store every caller uses. Swap with `setTokenStore()` at boot (e.g. in the native shell). */
export const tokenStore: TokenStore = {
  get: async () => (await active.get()) ?? memoryToken,
  set: (token) => active.set(token),
  clear: () => active.clear(),
};

export function setTokenStore(store: TokenStore): void {
  active = store;
}
