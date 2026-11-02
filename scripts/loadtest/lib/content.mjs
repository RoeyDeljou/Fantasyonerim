// Offline stand-ins for the content platforms the jobs poll (no network during a load test): the client's
// real podcast RSS (recorded, expanded back to its live size of 62 episodes), the real YouTube channel feed
// and the real Apple lookup. Everything else (Spotify, media downloads) answers 404, which the jobs treat as
// "unavailable" and skip.
/* global Response -- Node.js globals (eslint's .mjs config lists only a few) */
import { realAppleLookup } from '../../../packages/integrations/dist/__fixtures__/apple-lookup.js';
import { realPodcastRss } from '../../../packages/integrations/dist/__fixtures__/podcast-rss.js';
import { realYouTubeFeed } from '../../../packages/integrations/dist/__fixtures__/youtube.js';

function expandRss(rss, target) {
  const items = rss.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  if (items.length === 0) return rss;
  const extra = [];
  for (let i = items.length; i < target; i += 1) {
    const src = items[i % items.length];
    extra.push(
      src.replace(
        /<guid([^>]*)>([\s\S]*?)<\/guid>/,
        (_m, attrs, guid) => `<guid${attrs}>${guid}-lt${i}</guid>`,
      ),
    );
  }
  const last = rss.lastIndexOf('</item>') + '</item>'.length;
  return rss.slice(0, last) + extra.join('') + rss.slice(last);
}

const RSS = expandRss(realPodcastRss, 62);
const APPLE = typeof realAppleLookup === 'string' ? realAppleLookup : JSON.stringify(realAppleLookup);

/** @returns {typeof fetch} */
export function createContentFetch() {
  return async (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === 'anchor.fm') {
      return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/feeds/videos.xml') {
      return new Response(realYouTubeFeed, {
        status: 200,
        headers: { 'content-type': 'application/atom+xml' },
      });
    }
    if (url.hostname === 'itunes.apple.com') {
      return new Response(APPLE, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
}
