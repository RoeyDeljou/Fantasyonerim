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
import { MEDIA_LAYOUT, firstImageOf } from './images';
import { CDN_JSON, CDN_PATHS } from './cdn';

/**
 * A warm start (this build's persisted cache holds `me`) skips the early `/v1/me`: lib/meRevalidate.ts asks later.
 * lib/persist.ts's key, repeated here because the root layout (a server component) inlines this script and can't
 * read a client module's values (earlyFetch.test.ts keeps them equal). The buster — the build id — is read from
 * `<html data-build>` at run time, so the script text is the same for every build.
 */
export const PERSIST_KEY = 'fant.queryCache';
import type { FirstImage } from './images';

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

/**
 * The image the first card of a feed page renders (usually the screen's LCP), with the exact `srcset` / `sizes`
 * the card's <img> uses, so the preload is reused instead of a second download. News: `firstImageOf` +
 * `MEDIA_LAYOUT` (lib/images.ts), the very function and map the cards render with — a source whose card shows no
 * media never preloads. Community: the post photo (full width). Serialized into the inline script: self-contained,
 * with `firstImage` / `layouts` passed in.
 */
export function lcpImageOf(
  body: unknown,
  feed: 'news' | 'community',
  firstImage: typeof firstImageOf,
  layouts: Readonly<Record<string, string>>,
): FirstImage | null {
  const list = body && typeof body === 'object' ? (body as { items?: unknown }).items : null;
  const items: unknown[] = Array.isArray(list) ? list : [];
  if (feed === 'community') {
    const first = items[0] as
      | {
          image?: {
            url: string;
            width: number;
            height: number;
            variants?: { url: string; width: number }[];
          } | null;
        }
      | undefined;
    const img = first && first.image;
    if (!img) return null;
    return firstImage(
      { source: 'community', media: [{ kind: 'image', posterUrl: null, ...img }] },
      { community: 'carousel' },
    );
  }
  const first = items.filter((i) => (i as { source?: string }).source !== 'instagram_story')[0] as
    Parameters<typeof firstImageOf>[0] | undefined;
  return first && Array.isArray(first.media) ? firstImage(first, layouts) : null;
}

/**
 * The inline script: `earlyPaths` + fetch, with no dependencies (runs before any bundle). On News and Community it
 * also preloads the first card's image as soon as the feed JSON arrives — the LCP download then overlaps the
 * bundle instead of waiting for React to render the card.
 */
export const EARLY_FETCH_SCRIPT = `(function(){try{
var tok=localStorage.getItem('fant.token');if(!tok)return;
if(/[?&]post=/.test(location.search))return;
var paths=(${earlyPaths.toString()})(location.pathname,localStorage.getItem('fant.news.filter'));
var pc=localStorage.getItem('${PERSIST_KEY}');
var bid=document.documentElement.getAttribute('data-build');
if(pc&&bid&&pc.indexOf('{"buster":'+JSON.stringify(bid))===0&&pc.indexOf('"queryKey":["me"]')>0)paths=paths.filter(function(p){return p!=='/v1/me'});
var cdn=${JSON.stringify(CDN_JSON)}&&!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
var CDN=${JSON.stringify(CDN_PATHS)};
var e={};window.${EARLY_KEY}=e;
for(var i=0;i<paths.length;i++){var pub=cdn&&CDN.indexOf(paths[i])>=0;e[paths[i]]={at:Date.now(),token:tok,res:fetch(pub?location.origin+'/cdn'+paths[i]+'/':${JSON.stringify(API)}+paths[i],{headers:pub?{accept:'application/json'}:{accept:'application/json',authorization:'Bearer '+tok}})};e[paths[i]].res.catch(function(){});}
var fp=paths.filter(function(p){return p.indexOf('/v1/news?')===0||p.indexOf('/v1/community/posts?')===0})[0];
var feed=fp?(fp.indexOf('/v1/news?')===0?'news':'community'):null;
if(feed)e[fp].res.then(function(r){return r.ok?r.clone().json():null}).then(function(b){
var img=(${lcpImageOf.toString()})(b,feed,${firstImageOf.toString()},${JSON.stringify(MEDIA_LAYOUT)});if(!img)return;
var l=document.createElement('link');l.rel='preload';l.as='image';l.href=img.src;l.setAttribute('fetchpriority','high');
if(img.srcSet){l.setAttribute('imagesrcset',img.srcSet);l.setAttribute('imagesizes',img.sizes);}
document.head.appendChild(l);}).catch(function(){});
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
