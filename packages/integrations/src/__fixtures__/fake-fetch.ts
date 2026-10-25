import type { IntegrationContext } from '../types.js';

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
}

export type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;

/** A fake `fetch` that answers from routes (first match wins) and records every request. */
export function fakeContext(routes: Route[], nowMs = Date.parse('2026-10-25T12:00:00Z')) {
  const requests: RecordedRequest[] = [];
  let now = nowMs;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: RecordedRequest = {
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    requests.push(req);
    for (const route of routes) {
      const res = await route(req);
      if (res !== undefined) return res;
    }
    throw new TypeError(`fetch failed: no route for ${req.method} ${req.url.href}`);
  };
  const ctx: IntegrationContext = { fetch: fetchImpl as typeof fetch, now: () => now };
  return {
    ctx,
    requests,
    advance(ms: number) {
      now += ms;
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

/** Route helper: matches on host + pathname (+ optional method). */
export function on(
  method: string,
  hostAndPath: string | RegExp,
  respond: (req: RecordedRequest) => Response | Promise<Response>,
): Route {
  return (req) => {
    const target = `${req.url.host}${req.url.pathname}`;
    const matches = typeof hostAndPath === 'string' ? target === hostAndPath : hostAndPath.test(target);
    return matches && req.method === method ? respond(req) : undefined;
  };
}
