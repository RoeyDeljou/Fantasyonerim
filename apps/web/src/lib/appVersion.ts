/**
 * Pure decisions behind "installed apps always run the latest deploy" (wired up in ./updates.ts). No DOM, no
 * storage, no clock — everything is passed in, so it is unit-tested in appVersion.test.ts.
 */

/** Poll `/version.json` this often while the app is visible (plus on every resume). */
export const VERSION_POLL_MS = 15 * 60_000;
/** Resume events (visibilitychange, pageshow, focus) closer together than this share one check. */
export const RESUME_CHECK_THROTTLE_MS = 5_000;
/** No touch/scroll/key for this long = idle: safe to reload under the user's feet. */
export const IDLE_AFTER_MS = 60_000;
/** After a draft is sent or discarded, reload once the user has been still for this long. */
export const SETTLE_AFTER_MS = 4_000;
/** Reload-loop guard window: inside it, at most one auto-reload per target build and MAX_AUTO_RELOADS overall. */
export const RELOAD_WINDOW_MS = 10 * 60_000;
export const MAX_AUTO_RELOADS = 3;

const BUILD_ID_RE = /^[\w.-]{1,80}$/;

/** `/version.json` → its build id, or null for anything unexpected (an HTML 404 page, a proxy error body…). */
export function parseVersionFile(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const id = (json as { buildId?: unknown }).buildId;
  return typeof id === 'string' && BUILD_ID_RE.test(id) ? id : null;
}

/**
 * Is the deployed build different from the one running? Builds are not ordered — a rollback is a deploy too — so
 * any difference counts. Unknown on either side (dev server, unreadable file) = no update.
 */
export function isNewBuild(running: string | null | undefined, served: string | null | undefined): boolean {
  return !!running && !!served && running !== served;
}

// ---------- when to apply an update ----------

/**
 * What prompted the decision: `resume` = the app was just reopened, `hidden` = it is going to the background,
 * `interval` = the periodic check while in use, `settle` = re-evaluating a pending update.
 */
export type UpdateTrigger = 'resume' | 'hidden' | 'interval' | 'settle';

export interface UpdateContext {
  trigger: UpdateTrigger;
  /** Text typed into a composer, an open sheet with a filled field, or a focused field with content. */
  hasDraft: boolean;
  /** ms since the last touch / scroll / key press. */
  idleMs: number;
  /** The pending update was deferred because of a draft (so "done" = the draft is gone + a short pause). */
  afterDraft: boolean;
}

/** `reload` now, or `prompt` (show the non-blocking "new version" toast and re-check later). */
export function decideUpdate(ctx: UpdateContext): 'reload' | 'prompt' {
  if (ctx.hasDraft) return 'prompt';
  if (ctx.trigger === 'resume' || ctx.trigger === 'hidden') return 'reload';
  return ctx.idleMs >= (ctx.afterDraft ? SETTLE_AFTER_MS : IDLE_AFTER_MS) ? 'reload' : 'prompt';
}

// ---------- reload-loop guard (state kept in sessionStorage by the caller) ----------

export interface ReloadEntry {
  to: string;
  at: number;
}

export function parseReloadLog(raw: string | null): ReloadEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((e: unknown) => {
      if (!e || typeof e !== 'object') return [];
      const { to, at } = e as { to?: unknown; at?: unknown };
      return typeof to === 'string' && typeof at === 'number' && Number.isFinite(at) ? [{ to, at }] : [];
    });
  } catch {
    return [];
  }
}

function recent(log: readonly ReloadEntry[], now: number): ReloadEntry[] {
  return log.filter((e) => now - e.at >= 0 && now - e.at < RELOAD_WINDOW_MS);
}

/**
 * May we reload automatically to reach `target`? No if we already did so recently and are still not on it (the CDN
 * is still rolling out, or the HTML came from the offline cache), or after MAX_AUTO_RELOADS in the window.
 */
export function canAutoReload(log: readonly ReloadEntry[], target: string, now: number): boolean {
  const r = recent(log, now);
  return !r.some((e) => e.to === target) && r.length < MAX_AUTO_RELOADS;
}

/** The log after a reload to `target` (old entries pruned, so storage stays tiny). */
export function recordReload(log: readonly ReloadEntry[], target: string, now: number): ReloadEntry[] {
  return [...recent(log, now), { to: target, at: now }];
}

// ---------- chunk-load errors after a deploy ----------

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading (?:CSS )?chunk [\w/.-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** A lazily loaded chunk of the running build is gone (deleted by a newer deploy) — not an app bug. */
export function isChunkLoadError(err: unknown): boolean {
  if (typeof err === 'string') return CHUNK_ERROR_RE.test(err);
  if (!err || typeof err !== 'object') return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return name === 'ChunkLoadError' || (typeof message === 'string' && CHUNK_ERROR_RE.test(message));
}

/** A `<script>`/`<link>` of our own hashed assets failed to load. */
export function isOwnAssetUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin);
    return u.origin === origin && u.pathname.startsWith('/_next/static/');
  } catch {
    return false;
  }
}

/** Last chunk-error reload: one per running build (and again after the window), so a real outage cannot loop. */
export interface ChunkReloadMark {
  build: string;
  at: number;
}

export function parseChunkMark(raw: string | null): ChunkReloadMark | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const { build, at } = v as { build?: unknown; at?: unknown };
    return typeof build === 'string' && typeof at === 'number' ? { build, at } : null;
  } catch {
    return null;
  }
}

export function canChunkReload(mark: ChunkReloadMark | null, running: string, now: number): boolean {
  if (!mark || mark.build !== running) return true;
  return now - mark.at >= RELOAD_WINDOW_MS || now < mark.at;
}

export const CHUNK_MARK_KEY = 'fant.update.chunkReload';

/**
 * Inline <head> script: the same one-reload-per-build recovery for our own script/style tags failing *before*
 * React hydrates (when the runtime handler in lib/updates.ts isn't wired yet). Shares CHUNK_MARK_KEY, so the two
 * can never reload twice for one build. Skipped in the Capacitor shell (assets are bundled there).
 */
export const CHUNK_GUARD_SCRIPT = `(function(){try{if(window.Capacitor)return;var K='${CHUNK_MARK_KEY}',W=${RELOAD_WINDOW_MS};window.addEventListener('error',function(e){var t=e.target;if(!t||(t.tagName!=='SCRIPT'&&t.tagName!=='LINK'))return;var u=t.src||t.href||'';if(u.indexOf(location.origin+'/_next/static/')!==0)return;var b=document.documentElement.getAttribute('data-build')||'unknown',n=Date.now(),m=null;try{m=JSON.parse(sessionStorage.getItem(K)||'null')}catch(x){}if(m&&m.build===b&&n-m.at>=0&&n-m.at<W)return;sessionStorage.setItem(K,JSON.stringify({build:b,at:n}));location.reload()},true)}catch(e){}})();`;
