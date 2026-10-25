/**
 * A fake `fetch` that serves recorded raw FPL JSON, keyed by the API path relative to the base URL —
 * e.g. `bootstrap-static/`, `fixtures/?event=9`, `entry/1000001/event/9/picks/`,
 * `leagues-classic/314159/standings/?page_standings=1`. Unknown paths answer 404 (FPL's own
 * `{"detail":"Not found."}`), which the service maps to FplNotFoundError.
 *
 * Routes are either a plain object (exact key match: path + query first, then path alone) or a resolver
 * function for generated datasets. A route value may be `replayStatus(503)` to simulate failures.
 */

const REPLAY_STATUS = Symbol('replayStatus');

export interface ReplayStatus {
  readonly [REPLAY_STATUS]: true;
  readonly status: number;
  readonly body: unknown;
}

/** A route value that answers with an HTTP status (e.g. 503 "The game is being updated."). */
export function replayStatus(status: number, body: unknown = null): ReplayStatus {
  return { [REPLAY_STATUS]: true, status, body };
}

function isReplayStatus(v: unknown): v is ReplayStatus {
  return typeof v === 'object' && v !== null && REPLAY_STATUS in v;
}

/** Return `undefined` for "no such route" (→ 404). */
export type ReplayResolver = (path: string, query: URLSearchParams) => unknown;
export type ReplayRoutes = Readonly<Record<string, unknown>> | ReplayResolver;

export interface ReplayFetchOptions {
  /** Path prefix stripped before matching. Defaults to `/api/` (the FPL base path). */
  basePath?: string;
  /** Called for every request, e.g. to count calls in tests. */
  onRequest?: (key: string) => void;
}

export function createReplayFetch(routes: ReplayRoutes, options: ReplayFetchOptions = {}): typeof fetch {
  const basePath = options.basePath ?? '/api/';
  const replay = async (input: RequestInfo | URL): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://fantasy.premierleague.com');
    let path = url.pathname;
    if (path.startsWith(basePath)) path = path.slice(basePath.length);
    path = path.replace(/^\/+/, '');
    const query = url.searchParams;
    const key = query.size > 0 ? `${path}?${query.toString()}` : path;
    options.onRequest?.(key);

    const value = typeof routes === 'function' ? routes(path, query) : (routes[key] ?? routes[path]);
    if (value === undefined) return json({ detail: 'Not found.' }, 404);
    if (isReplayStatus(value)) {
      return value.body === null
        ? new Response('', { status: value.status })
        : json(value.body, value.status);
    }
    return json(value, 200);
  };
  return replay as typeof fetch;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
