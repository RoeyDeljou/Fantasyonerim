import { isAllowedAssistantScriptUrl } from '@fant/shared';
import { readPref, writePref } from '../prefs';
import { clearFplLadAuth, FPL_LAD_AUTH_KEY } from './authStorage';

/**
 * FPL Lad /chat host bridge — the ONLY file that knows the postMessage protocol of FPL Lad's /chat page when it runs
 * inside our in-app panel (components/assistant/AlfiePanel.tsx). docs/INTEGRATIONS.md §7 ("Staying signed in")
 * documents it for FPL Lad.
 *
 * Why: in a home-screen PWA on iPhone the third-party iframe's (partitioned) storage does not survive the app being
 * closed, so a fan who signed in to Alfie with Google was signed out again on the next visit. Their page already
 * talks to its parent window:
 *   - after sign-in it posts `{ type: 'fpl-auth-complete', user, embedToken, cookies }` to the parent;
 *   - it accepts the same message FROM the parent and restores the signed-in state from it (without echoing back).
 * So we keep that payload in OUR first-party storage and post it back into the frame each time the panel loads.
 *
 * Rules: only messages from the panel's own iframe (`event.source`) on an fpl-lad.com origin (the fallback URL's
 * origin, or its apex/www twin) are accepted; the payload is shape- and size-checked; it is posted back only to
 * the frame's exact origin (never "*"); it is never sent to our API or anywhere else; it is cleared when the fan
 * signs out of our app or deletes their account (lib/session.tsx), and when FPL Lad tell us they signed out
 * (`fpl-auth-signout` / `fpl-signout` — not sent by them yet, harmless until they do).
 */

export const AUTH_COMPLETE = 'fpl-auth-complete';
const SIGN_OUT_TYPES: readonly string[] = ['fpl-auth-signout', 'fpl-signout'];

/** Size limits for a payload we are willing to store and replay. */
export const LIMITS = { totalChars: 32 * 1024, cookies: 20, userIdChars: 200 } as const;

/**
 * When to hand the stored sign-in back after the frame's `load`. FPL Lad's /chat attaches its message listener some
 * time after `load` (measured ~70–610 ms with CPU throttling ×1–×6) and posts nothing to say it is ready, so we post
 * on timers: one comfortably after a normal start, one more for a slow iPhone cold start.
 */
export const REPLAY_DELAYS_MS: readonly number[] = [1_500, 4_000];

/** At most this many hand-backs per frame load (the timers + one on a message from the frame). */
export const MAX_REPLAYS_PER_LOAD = 3;

export interface FplLadCookie {
  name: string;
  value: string;
}

/** `fpl-auth-complete` as FPL Lad send it; kept exactly as received (incl. any extra fields) after validation. */
export interface FplLadAuthPayload {
  type: typeof AUTH_COMPLETE;
  user: { id: string; [k: string]: unknown };
  embedToken?: string;
  cookies?: FplLadCookie[];
  [k: string]: unknown;
}

export interface StoredFplLadAuth {
  payload: FplLadAuthPayload;
  savedAt: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCookie(v: unknown): v is FplLadCookie {
  return isRecord(v) && typeof v.name === 'string' && v.name.length > 0 && typeof v.value === 'string';
}

/**
 * A validated, JSON-clean copy of an `fpl-auth-complete` message, else null: `user.id` a non-empty string,
 * `embedToken` a string if present, `cookies` ≤ 20 `{name, value}` strings if present, all of it < 32 KB as JSON.
 */
export function parseAuthComplete(data: unknown): FplLadAuthPayload | null {
  if (!isRecord(data) || data.type !== AUTH_COMPLETE) return null;
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return null; // a cycle / BigInt: not something FPL Lad send
  }
  if (json.length >= LIMITS.totalChars) return null;
  const copy: unknown = JSON.parse(json);
  if (!isRecord(copy)) return null;
  const user = copy.user;
  if (!isRecord(user) || typeof user.id !== 'string') return null;
  if (user.id.length === 0 || user.id.length > LIMITS.userIdChars) return null;
  if (copy.embedToken !== undefined && typeof copy.embedToken !== 'string') return null;
  if (copy.cookies !== undefined) {
    if (!Array.isArray(copy.cookies) || copy.cookies.length > LIMITS.cookies) return null;
    if (!copy.cookies.every(isCookie)) return null;
  }
  return copy as FplLadAuthPayload;
}

/** FPL Lad telling us the visitor signed out of Alfie (type only; not sent by them yet). */
export function isSignOutMessage(data: unknown): boolean {
  return isRecord(data) && typeof data.type === 'string' && SIGN_OUT_TYPES.includes(data.type);
}

/** Any message of their protocol (`fpl-…`): proof the frame's page is up and listening. */
export function isFplLadMessage(data: unknown): boolean {
  return isRecord(data) && typeof data.type === 'string' && data.type.startsWith('fpl-');
}

/** `https://www.fpl-lad.com` → `fpl-lad.com`: the apex/www twins compare equal. */
function siteKey(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (!isAllowedAssistantScriptUrl(u.href)) return null; // https + an fpl-lad.com host only
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}:${u.port}`;
  } catch {
    return null;
  }
}

/** The origin the panel frames (`fallbackUrl`'s), or null when it isn't FPL Lad's (then there is no bridge). */
export function bridgeOrigin(fallbackUrl: string): string | null {
  try {
    const origin = new URL(fallbackUrl).origin;
    return siteKey(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** A message origin we accept for a frame of `expected`: exactly it, or its apex/www twin on fpl-lad.com. */
export function acceptsOrigin(origin: string, expected: string): boolean {
  if (origin === expected) return siteKey(origin) !== null;
  const a = siteKey(origin);
  return a !== null && a === siteKey(expected);
}

/** Our first-party storage, injected so tests use a map. */
export interface AuthStorage {
  read(): string | null;
  write(value: string): void;
  remove(): void;
}

export const prefsAuthStorage: AuthStorage = {
  read: () => readPref(FPL_LAD_AUTH_KEY),
  write: (v) => writePref(FPL_LAD_AUTH_KEY, v),
  remove: clearFplLadAuth,
};

export function readStoredAuth(storage: AuthStorage): StoredFplLadAuth | null {
  try {
    const raw = storage.read();
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const payload = isRecord(parsed) ? parseAuthComplete(parsed.payload) : null;
    if (!payload || !isRecord(parsed) || typeof parsed.savedAt !== 'number') {
      storage.remove(); // corrupt or from an older shape: drop it
      return null;
    }
    return { payload, savedAt: parsed.savedAt };
  } catch {
    try {
      storage.remove();
    } catch {
      // ignore
    }
    return null;
  }
}

export function saveAuth(storage: AuthStorage, payload: FplLadAuthPayload, now: number): void {
  try {
    storage.write(JSON.stringify({ payload, savedAt: now } satisfies StoredFplLadAuth));
  } catch {
    // storage full / blocked: Alfie just won't remember the sign-in
  }
}

/** The subset of a MessageEvent the bridge looks at. */
export interface BridgeMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface BridgeDeps {
  /** `bridgeOrigin(fallbackUrl)`. */
  origin: string;
  /** The panel iframe's `contentWindow` right now (null while it isn't mounted). */
  frame(): FrameWindow | null;
  storage: AuthStorage;
  now(): number;
}

/**
 * The bridge for one panel iframe. Readiness is timer-based today: the host calls `onReplayTimer()` at each of
 * `REPLAY_DELAYS_MS` after every `load`. If the frame ever messages us (any `fpl-…`, e.g. a future `fpl-ready`), the
 * first such message per load triggers a hand-back too. At most `MAX_REPLAYS_PER_LOAD` posts per load; their handler
 * tolerates repeats. A fresh sign-in or a sign-out from the frame stops the hand-backs for that load.
 */
export class FplLadBridge {
  /** The frame's actual origin, once it has messaged us (www vs apex). */
  private frameOrigin: string | null = null;
  private posts = 0;
  private repliedToMessage = false;
  /** The frame just signed in or out: nothing (more) to hand back for this load. */
  private done = false;
  private loads = 0;

  constructor(private readonly deps: BridgeDeps) {}

  /** Handles a window `message` event; true when it was from the panel's frame and accepted. */
  onMessage(e: BridgeMessage): boolean {
    const frame = this.deps.frame();
    if (!frame || e.source !== frame) return false;
    if (!acceptsOrigin(e.origin, this.deps.origin)) return false;
    if (!isFplLadMessage(e.data)) return false;
    const type = (e.data as { type: string }).type;
    const payload = type === AUTH_COMPLETE ? parseAuthComplete(e.data) : null;
    if (type === AUTH_COMPLETE && !payload) return false; // malformed / oversized: ignored entirely
    this.frameOrigin = e.origin;
    if (payload) {
      saveAuth(this.deps.storage, payload, this.deps.now());
      this.done = true; // they just signed in: no need to hand it back
    } else if (isSignOutMessage(e.data)) {
      this.deps.storage.remove();
      this.done = true;
    } else if (!this.repliedToMessage) {
      this.repliedToMessage = true;
      this.replay();
    }
    return true;
  }

  /**
   * The iframe fired `load`. Their page could message us before its own `load` fires, so the first load keeps what
   * already happened; a later load is a new page in the frame and starts over.
   */
  onFrameLoad(): void {
    if (this.loads++ === 0) return;
    this.posts = 0;
    this.repliedToMessage = false;
    this.done = false;
    this.frameOrigin = null;
  }

  /** One of the `REPLAY_DELAYS_MS` timers after `load` fired. */
  onReplayTimer(): void {
    this.replay();
  }

  /** Posts the stored sign-in into the frame, to its exact origin. False when nothing was sent. */
  private replay(): boolean {
    if (this.done || this.posts >= MAX_REPLAYS_PER_LOAD) return false;
    const stored = readStoredAuth(this.deps.storage);
    const frame = this.deps.frame();
    if (!stored || !frame) return false;
    try {
      frame.postMessage(stored.payload, this.frameOrigin ?? this.deps.origin);
      this.posts++;
      return true;
    } catch {
      return false;
    }
  }
}
