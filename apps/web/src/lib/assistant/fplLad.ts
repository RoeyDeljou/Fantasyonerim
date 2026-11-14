import { isAllowedAssistantScriptUrl } from '@fant/shared';
import type { AssistantContext } from './context';

/**
 * FPL Lad embed adapter — the ONLY file that knows the API of FPL Lad's embed script ("Ask Alfie" widget). When
 * their real script arrives with a different shape, this is the one file to change (docs/INTEGRATIONS.md, "FPL Lad
 * — Ask Alfie widget", documents what we expect from them).
 *
 * What we expect (and are tolerant about):
 *   - one script tag: `<script async src="{scriptUrl}" data-partner="{partnerId}">` (we inject it on first use);
 *   - it defines a global `window.FPLLad` (also accepted: `window.FplLad`, `window.fplLad`) with
 *       init(options)       — once; may return a promise
 *       open()              — opens Alfie's panel (full-screen slide-up on mobile)
 *       close()             — optional
 *       update(options)     — optional; called when the visitor signs in/out or changes language/theme
 *       on(event, callback) — optional; events: 'close' (panel closed → we show our launcher again) and
 *                              'identity' with `{ visitorToken }` (we keep it on the device and pass it back)
 *   - with `launcher: false` it draws no button of its own (we draw "Ask Alfie").
 *
 * If the script fails to load, or the global doesn't appear within `timeoutMs` (8 s), or init/open throws, the
 * caller falls back to the in-app panel (components/assistant/AlfiePanel.tsx) and we warn once in the console.
 */

/** The options object passed to `FPLLad.init()` / `FPLLad.update()`. */
export interface FplLadOptions {
  partner: string;
  teamId?: number;
  locale: 'he' | 'en';
  theme: 'light' | 'dark';
  /** We render our own launcher button. */
  launcher: false;
  /** The app's current theme colours, read from the CSS variables at runtime. */
  colors: { primary: string; onPrimary: string; surface: string };
  zIndex: number;
  /** Pixels between the bottom of the viewport and the top of our tab bar (0 without one). */
  bottomOffset: number;
  /** Returning-visitor token FPL Lad gave us earlier ('identity' event), stored first-party on this device. */
  visitorToken?: string;
}

export interface FplLadApi {
  init(options: FplLadOptions): unknown;
  open(): unknown;
  close?(): unknown;
  update?(options: FplLadOptions): unknown;
  on?(event: string, callback: (payload: unknown) => void): unknown;
}

export interface FplLadHandlers {
  /** Their panel closed. */
  onClose(): void;
  /** They identified a returning visitor. */
  onIdentity(visitorToken: string): void;
}

export type OpenResult =
  /** Their widget is open. `tracksClose`: they will tell us when it closes ('close' event). */
  | { kind: 'widget'; tracksClose: boolean }
  /** Use our in-app panel. */
  | { kind: 'fallback' };

/** Everything the adapter touches outside itself: injected so tests drive it with a fake window. */
export interface EmbedHost {
  /** Where the script defines its global. */
  global: Record<string, unknown>;
  /** Appends `<script async src data-partner>`; resolves on load, rejects on error. */
  injectScript(src: string, partner: string | null): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  warn(message: string): void;
}

const GLOBAL_NAMES = ['FPLLad', 'FplLad', 'fplLad'] as const;
export const SCRIPT_TIMEOUT_MS = 8_000;

function isApi(v: unknown): v is FplLadApi {
  if ((typeof v !== 'object' && typeof v !== 'function') || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.init === 'function' && typeof o.open === 'function';
}

function findApi(global: Record<string, unknown>): FplLadApi | null {
  for (const name of GLOBAL_NAMES) {
    const v = global[name];
    if (isApi(v)) return v;
  }
  return null;
}

/** The `visitorToken` from an 'identity' event payload (a short opaque string), else null. */
export function visitorTokenOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const t = (payload as Record<string, unknown>).visitorToken;
  return typeof t === 'string' && t.length > 0 && t.length <= 512 ? t : null;
}

export function buildOptions(
  ctx: AssistantContext,
  extra: Pick<FplLadOptions, 'colors' | 'zIndex' | 'bottomOffset'> & { visitorToken?: string | undefined },
): FplLadOptions {
  return {
    partner: ctx.partner,
    ...(ctx.teamId !== undefined ? { teamId: ctx.teamId } : {}),
    locale: ctx.locale,
    theme: ctx.theme,
    launcher: false,
    colors: extra.colors,
    zIndex: extra.zIndex,
    bottomOffset: extra.bottomOffset,
    ...(extra.visitorToken ? { visitorToken: extra.visitorToken } : {}),
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, host: EmbedHost): Promise<T> {
  return Promise.race([
    p,
    host.sleep(ms).then(() => {
      throw new Error(`timed out after ${ms} ms`);
    }),
  ]);
}

export class FplLadEmbed {
  private scriptUrl: string | null = null;
  private loading: Promise<FplLadApi | null> | null = null;
  private api: FplLadApi | null = null;
  private initialized = false;
  private lastOptions = '';
  private warned = false;
  private failed = false;
  private handlers: FplLadHandlers | null = null;

  constructor(
    private readonly host: EmbedHost,
    private readonly timeoutMs = SCRIPT_TIMEOUT_MS,
    private readonly pollMs = 100,
  ) {}

  private warnOnce(reason: string) {
    if (this.warned) return;
    this.warned = true;
    this.host.warn(
      `[Ask Alfie] FPL Lad's script is unavailable (${reason}); using the in-app panel instead.`,
    );
  }

  /** Injects the script once (per URL) and waits for the global. Null = not usable (→ the in-app panel). */
  load(scriptUrl: string, partnerId: string | null): Promise<FplLadApi | null> {
    if (!isAllowedAssistantScriptUrl(scriptUrl)) {
      this.warnOnce('script URL not on an allowed FPL Lad domain');
      return Promise.resolve(null);
    }
    if (this.scriptUrl !== scriptUrl) {
      // A different script (the admin changed it): start over.
      this.scriptUrl = scriptUrl;
      this.loading = null;
      this.api = null;
      this.initialized = false;
      this.failed = false;
      this.lastOptions = '';
    }
    if (this.failed) return Promise.resolve(null);
    this.loading ??= this.fetchApi(scriptUrl, partnerId);
    return this.loading;
  }

  private async fetchApi(scriptUrl: string, partnerId: string | null): Promise<FplLadApi | null> {
    const existing = findApi(this.host.global);
    if (existing) return (this.api = existing);
    const until = this.host.now() + this.timeoutMs;
    let scriptError = false;
    const injected = this.host.injectScript(scriptUrl, partnerId).catch(() => {
      scriptError = true;
    });
    void injected;
    while (this.host.now() < until) {
      const api = findApi(this.host.global);
      if (api) return (this.api = api);
      if (scriptError) break;
      await this.host.sleep(this.pollMs);
    }
    this.failed = true;
    this.warnOnce(scriptError ? 'the script failed to load' : 'window.FPLLad never appeared');
    return null;
  }

  /** Opens their widget, initializing it first; `{ kind: 'fallback' }` whenever anything is off. */
  async open(
    scriptUrl: string | null,
    partnerId: string | null,
    options: FplLadOptions,
    handlers: FplLadHandlers,
  ): Promise<OpenResult> {
    if (!scriptUrl) return { kind: 'fallback' };
    this.handlers = handlers;
    const api = await this.load(scriptUrl, partnerId);
    if (!api) return { kind: 'fallback' };
    try {
      if (!this.initialized) {
        if (typeof api.on === 'function') {
          api.on('close', () => this.handlers?.onClose());
          api.on('identity', (payload) => {
            const token = visitorTokenOf(payload);
            if (token) this.handlers?.onIdentity(token);
          });
        }
        await withTimeout(Promise.resolve(api.init(options)), this.timeoutMs, this.host);
        this.initialized = true;
        this.lastOptions = JSON.stringify(options);
      } else {
        this.update(options);
      }
      await Promise.resolve(api.open());
      return { kind: 'widget', tracksClose: typeof api.on === 'function' };
    } catch (e) {
      this.failed = true;
      this.warnOnce(e instanceof Error ? e.message : 'init/open failed');
      return { kind: 'fallback' };
    }
  }

  /** New options (sign in/out, language, theme) for an initialized widget, if it supports `update`. */
  update(options: FplLadOptions): void {
    const api = this.api;
    if (!api || !this.initialized) return;
    const key = JSON.stringify(options);
    if (key === this.lastOptions) return;
    this.lastOptions = key;
    if (typeof api.update !== 'function') return;
    try {
      void Promise.resolve(api.update(options)).catch(() => undefined);
    } catch {
      // their bug: the widget keeps its old options
    }
  }

  /** Closes their widget (e.g. the app navigates to a screen without the launcher), when supported. */
  close(): void {
    try {
      if (this.api && this.initialized && typeof this.api.close === 'function') void this.api.close();
    } catch {
      // ignore
    }
  }
}

/** The real browser host. */
export function browserHost(): EmbedHost {
  return {
    global: window as unknown as Record<string, unknown>,
    injectScript(src, partner) {
      return new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.async = true;
        s.src = src;
        if (partner) s.dataset.partner = partner;
        s.dataset.fplLad = '';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script error'));
        document.head.appendChild(s);
      });
    },
    sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
    now: () => Date.now(),
    warn: (m) => console.warn(m),
  };
}

let instance: FplLadEmbed | null = null;
/** One adapter per page (the script is injected at most once). */
export function fplLad(): FplLadEmbed {
  return (instance ??= new FplLadEmbed(browserHost()));
}
