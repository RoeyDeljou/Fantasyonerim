/**
 * Cold start without a waterfall. Normally a tab's API requests start only after every JS chunk has downloaded and
 * React has hydrated — on mobile data that is the slowest part of opening the app. This inline <head> script starts
 * the tab's main GETs while the bundle is still downloading; lib/api.ts then adopts the in-flight response instead
 * of sending the same request again (`takeEarlyResponse`). Same base URL rule as lib/api.ts.
 *
 * Only requests the screen is certain to make for a signed-in user are started here (never one that can 404 on a
 * fresh install, like the league), and an answer is adopted only by a request for the exact same path with the
 * same token within EARLY_MAX_AGE_MS — anything else is ignored and fetched normally.
 */
const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export const EARLY_KEY = '__fantEarly';
export const EARLY_MAX_AGE_MS = 15_000;
/**
 * The paths a tab reads first, given its pathname and the saved News filter chip. Serialized into the inline
 * script with `toString()`, so it must stay self-contained (literals only — the page sizes are NEWS_PAGE_SIZE and
 * COMMUNITY_PAGE_SIZE in lib/queries.ts; earlyFetch.test.ts checks they match what lib/api.ts requests).
 */
export function earlyPaths(pathname: string, newsFilter: string | null): string[] {
  const paths = ['/v1/me'];
  if (pathname.startsWith('/news')) {
    const f = newsFilter && newsFilter !== 'all' ? `&filter=${encodeURIComponent(newsFilter)}` : '';
    paths.push('/v1/news?limit=15' + f, '/v1/news/stories', '/v1/news/filters');
  } else if (pathname.startsWith('/community')) {
    paths.push('/v1/community/posts?limit=20');
  } else if (pathname.startsWith('/my-team')) {
    paths.push('/v1/fpl/bootstrap');
  } else if (pathname.startsWith('/live')) {
    paths.push('/v1/config', '/v1/fpl/bootstrap');
  } else if (pathname.startsWith('/table')) {
    paths.push('/v1/config');
  } else {
    return [];
  }
  return paths;
}

/** The inline script: `earlyPaths` + fetch, with no dependencies (runs before any bundle). */
export const EARLY_FETCH_SCRIPT = `(function(){try{
var tok=localStorage.getItem('fant.token');if(!tok)return;
if(/[?&]post=/.test(location.search))return;
var paths=(${earlyPaths.toString()})(location.pathname,localStorage.getItem('fant.news.filter'));
var e={};window.${EARLY_KEY}=e;
for(var i=0;i<paths.length;i++){e[paths[i]]={at:Date.now(),token:tok,res:fetch(${JSON.stringify(API)}+paths[i],{headers:{accept:'application/json',authorization:'Bearer '+tok}})};e[paths[i]].res.catch(function(){});}
}catch(x){}})();`;

interface EarlyEntry {
  at: number;
  token: string;
  res: Promise<Response>;
}

/**
 * The response the inline script already requested for this exact path (`/v1/news?limit=15`) and token, at most
 * once; null when there is none (or it is stale) — the caller then fetches normally.
 */
export function takeEarlyResponse(pathWithSearch: string, token: string | null): Promise<Response> | null {
  if (typeof window === 'undefined' || !token) return null;
  const all = (window as unknown as Record<string, Record<string, EarlyEntry> | undefined>)[EARLY_KEY];
  const hit = all?.[pathWithSearch];
  if (!all || !hit) return null;
  delete all[pathWithSearch];
  if (hit.token !== token || Date.now() - hit.at > EARLY_MAX_AGE_MS) return null;
  return hit.res;
}
