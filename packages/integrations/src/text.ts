/**
 * Text helpers shared by every source: HTML → plain text (episode descriptions) and title normalization
 * for cross-platform episode matching (RSS ↔ Spotify ↔ Apple). Hebrew-safe: works on Unicode letters,
 * never on ASCII-only character classes.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  shy: '',
  zwj: '‍',
  zwnj: '‌',
  lrm: '‎',
  rlm: '‏',
};

/** Decodes named (common subset) and numeric HTML entities. Unknown entities are left as-is. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = 'p|div|li|ul|ol|h[1-6]|blockquote|section|article|tr|table|pre';

/**
 * HTML → readable plain text. Paragraphs / `<br>` become line breaks (one `<p>` per line, the way
 * Spotify for Creators writes descriptions; an empty `<p><br></p>` becomes a blank line), list items get
 * a bullet, links keep their URL when the link text doesn't already show it, entities are decoded,
 * whitespace inside lines is collapsed and at most one blank line is kept between blocks.
 */
export function htmlToPlainText(html: string): string {
  let s = html.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // Source newlines are insignificant in HTML.
  s = s.replace(/\s*\n\s*/g, ' ');
  s = s.replace(
    /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, _q, dq, sq, inner) => {
      const href = decodeHtmlEntities(String(dq ?? sq ?? '')).trim();
      const label = String(inner);
      const labelText = decodeHtmlEntities(label.replace(/<[^>]*>/g, '')).trim();
      if (labelText === '') return href;
      const labelIsUrl =
        /^\S+\.\S+$/u.test(labelText) && href.includes(labelText.replace(/^https?:\/\//i, ''));
      if (!/^https?:\/\//i.test(href) || labelText.includes(href) || labelIsUrl) return label;
      return `${label} (${href})`;
    },
  );
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li\s*>/gi, '');
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), (tag) =>
    tag.startsWith('</') || /^<(ul|ol|table)/i.test(tag) ? '\n' : '',
  );
  s = s.replace(/<[^>]*>/g, '');
  s = decodeHtmlEntities(s);
  const lines = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim());
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NormalizeTitleOptions {
  /** Drop a leading "פרק 62 -", "Episode 62:", "Ep. 62 |", "#62" before comparing. Default false. */
  stripEpisodePrefix?: boolean;
}

const EPISODE_PREFIX = /^\s*(?:פרק|episode|ep\.?|#)\s*(\d+)\s*[-–—:|.,)]*\s*/iu;

/** Episode number written in a title ("פרק 62 - …", "Episode 62", "#62"), or null. */
export function episodeNumberFromTitle(title: string): number | null {
  const m = EPISODE_PREFIX.exec(title.normalize('NFKC')) ?? /(?:פרק|episode|ep\.?)\s*(\d+)/iu.exec(title);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Comparable form of an episode title: Unicode NFKC, lowercase, Hebrew points (niqqud/cantillation)
 * removed, apostrophe/geresh variants (' ’ ׳ ״ ") removed so "צ'יפים" = "צ׳יפים", every run of
 * non-letters/non-digits (punctuation, emoji, whitespace variance) collapsed to one space, trimmed.
 */
export function normalizeTitle(title: string, options: NormalizeTitleOptions = {}): string {
  let s = title.normalize('NFKC');
  if (options.stripEpisodePrefix === true) s = s.replace(EPISODE_PREFIX, '');
  s = s.toLowerCase();
  s = s.replace(/[֑-ׇ]/g, '');
  s = s.replace(/['’‘`´׳״"“”]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.trim();
}

/** Both normalized forms of a title, for tolerant matching. */
export function titleKeys(title: string): string[] {
  const full = normalizeTitle(title);
  const stripped = normalizeTitle(title, { stripEpisodePrefix: true });
  return full === stripped || stripped === '' ? [full] : [full, stripped];
}
