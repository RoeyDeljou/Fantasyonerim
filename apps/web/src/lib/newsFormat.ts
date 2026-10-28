/**
 * Pure helpers for the News tab (no React, no DOM) — unit-tested in newsFormat.test.ts.
 */

/** 4403 → "1:13:23", 125 → "2:05". Negative / non-finite → "0:00". */
export function formatDuration(totalSec: number): string {
  const s = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export type RelativeUnit = 'second' | 'minute' | 'hour' | 'day';

/**
 * Relative time for card headers: "now", "5 minutes ago", "yesterday", "3 days ago"; older than a week returns
 * null so the caller shows a date instead.
 */
export function relativeParts(
  iso: string,
  now: number,
): { value: number; unit: RelativeUnit } | 'now' | null {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'now';
  if (abs < 3600) return { value: Math.round(diffSec / 60), unit: 'minute' };
  if (abs < 86_400) return { value: Math.round(diffSec / 3600), unit: 'hour' };
  if (abs < 7 * 86_400) return { value: Math.round(diffSec / 86_400), unit: 'day' };
  return null;
}

export type TextToken =
  | { kind: 'text'; value: string }
  | { kind: 'url'; value: string; href: string }
  | { kind: 'mention'; value: string; href: string }
  | { kind: 'hashtag'; value: string; href: string };

export type LinkPlatform = 'x' | 'instagram' | 'none';

const TRAILING_PUNCT = /[.,!?;:'")\]}…»״]+$/u;
// URL | @mention | #hashtag (Hebrew-friendly). Mentions/hashtags must not be glued to a preceding word char.
const TOKEN_RE =
  /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)|(?<![\p{L}\p{N}_@])@([A-Za-z0-9_.]{1,30})|(?<![\p{L}\p{N}_&#])#([\p{L}\p{N}_]+)/gu;

function mentionHref(user: string, platform: LinkPlatform): string | null {
  if (platform === 'x') return `https://x.com/${encodeURIComponent(user)}`;
  if (platform === 'instagram') return `https://www.instagram.com/${encodeURIComponent(user)}/`;
  return null;
}

function hashtagHref(tag: string, platform: LinkPlatform): string | null {
  if (platform === 'x') return `https://x.com/hashtag/${encodeURIComponent(tag)}`;
  if (platform === 'instagram') return `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
  return null;
}

/** Splits post text into plain runs and links (URLs always; @mentions/#hashtags per platform). */
export function linkify(text: string, platform: LinkPlatform): TextToken[] {
  const out: TextToken[] = [];
  let last = 0;
  const pushText = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.value += v;
    else out.push({ kind: 'text', value: v });
  };
  for (const m of text.matchAll(TOKEN_RE)) {
    const index = m.index ?? 0;
    const [whole] = m;
    const [, url, mention, tag] = m;
    pushText(text.slice(last, index));
    last = index + whole.length;
    if (url) {
      const trimmed = url.replace(TRAILING_PUNCT, '');
      const rest = url.slice(trimmed.length);
      out.push({
        kind: 'url',
        value: trimmed,
        href: trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed,
      });
      pushText(rest);
      continue;
    }
    if (mention) {
      const user = mention.replace(/\.+$/, '');
      const href = mentionHref(user, platform);
      if (href) {
        out.push({ kind: 'mention', value: `@${user}`, href });
        pushText(mention.slice(user.length));
      } else pushText(whole);
      continue;
    }
    if (tag) {
      const href = hashtagHref(tag, platform);
      if (href) out.push({ kind: 'hashtag', value: `#${tag}`, href });
      else pushText(whole);
    }
  }
  pushText(text.slice(last));
  return out;
}

/** Accepts a Spotify show URL / URI / bare id and returns the 22-char id, or null. */
export function spotifyShowId(input: string): string | null {
  const v = input.trim();
  const m = /(?:open\.spotify\.com\/(?:[a-z-]+\/)?show\/|spotify:show:)([A-Za-z0-9]{22})/.exec(v);
  if (m?.[1]) return m[1];
  return /^[A-Za-z0-9]{22}$/.test(v) ? v : null;
}

/** Accepts an Apple Podcasts URL (…/id1819558192) or the bare number. */
export function applePodcastId(input: string): string | null {
  const v = input.trim();
  const m = /\/id(\d{5,})/.exec(v);
  if (m?.[1]) return m[1];
  return /^\d{5,}$/.test(v) ? v : null;
}

/** "@Fantasyonerim" / "https://x.com/Fantasyonerim" → "Fantasyonerim". */
export function xUsername(input: string): string | null {
  const v = input.trim();
  const m = /(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})/.exec(v);
  const name = m?.[1] ?? v.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(name) ? name : null;
}

/** True when `expiresAt` is set and within `days` of `now` (or already past). */
export function expiresWithin(iso: string | null, days: number, now: number): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() - now < days * 86_400_000;
}

/**
 * Feed titles often repeat the number shown in the badge ("פרק 62 - אין צ'יפים" / "Ep. 62: …"); drop that
 * prefix when it matches `episodeNumber`. Never returns an empty title.
 */
export function episodeTitle(title: string, episodeNumber: number | null): string {
  if (episodeNumber === null) return title;
  const re = new RegExp(`^\\s*(?:פרק|episode|ep\\.?|#)\\s*${episodeNumber}\\s*[-–—:|.]\\s*`, 'iu');
  const stripped = title.replace(re, '').trim();
  return stripped || title;
}

// ---------- YouTube ----------

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOST = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;

/**
 * The 11-character video id from a YouTube link: `youtube.com/shorts/<id>`, `watch?v=<id>`, `youtu.be/<id>`,
 * `/embed/<id>`, `/live/<id>` (www./m. hosts too). Anything else → null.
 */
export function youtubeVideoId(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | null | undefined = null;
  if (host === 'youtu.be') id = parts[0];
  else if (YT_HOST.test(host)) {
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live' || parts[0] === 'v')
      id = parts[1];
  }
  return id && YT_ID.test(id) ? id : null;
}

/** The official privacy-enhanced player, autoplaying inline (only ever loaded after the user taps play). */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0`;
}

/** YouTube's own thumbnail, for items synced without re-hosted media. */
export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

/**
 * Normalizes the admin's "YouTube channel" input: `@handle` / `youtube.com/@handle` → `@handle`,
 * `youtube.com/channel/UC…` / bare `UC…` → the channel id, `youtube.com/c/<name>` / `/user/<name>` → the full
 * URL (the server resolves it). null = not a channel.
 */
export function youtubeChannel(input: string): string | null {
  const v = input.trim();
  if (/^UC[A-Za-z0-9_-]{22}$/.test(v)) return v;
  if (/^@[\w.-]{3,30}$/.test(v)) return v;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  if (!YT_HOST.test(u.hostname)) return null;
  const [first, second] = u.pathname.split('/').filter(Boolean);
  if (first && /^@[\w.-]{3,30}$/.test(decodeURIComponent(first))) return decodeURIComponent(first);
  if (first === 'channel' && second && /^UC[A-Za-z0-9_-]{22}$/.test(second)) return second;
  if ((first === 'c' || first === 'user') && second && /^[\w.-]{1,100}$/.test(second))
    return `https://www.youtube.com/${first}/${second}`;
  return null;
}
