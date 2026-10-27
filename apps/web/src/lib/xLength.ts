/**
 * Client-side approximation of X's weighted tweet length, for the live-update composer's counter only — the API
 * is the authority and rejects an over-long X post per target. Rules (after twitter-text v3):
 *   - every URL counts as 23 (t.co wrapping), whatever its real length;
 *   - an emoji counts as 2, however many code points it is built from (ZWJ sequences, flags, skin tones);
 *   - Latin, Hebrew, Arabic and other scripts in the low ranges count as 1; CJK and the rest count as 2.
 */
export const X_MAX = 280;
const URL_WEIGHT = 23;

// http(s)://… or a bare www.… / domain.tld[/path] (common TLDs), as X auto-links them.
const URL_RE =
  /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|il|uk|me|ly|fm|tv|app|dev|gg|link)\b(?:\/[^\s]*)?/gi;

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** X's "weight 1" code point ranges (everything else is 2). */
function isLight(cp: number): boolean {
  return (
    (cp >= 0 && cp <= 4351) ||
    (cp >= 8192 && cp <= 8205) ||
    (cp >= 8208 && cp <= 8223) ||
    (cp >= 8242 && cp <= 8247)
  );
}

function graphemes(s: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s), (g) => g.segment);
  }
  return Array.from(s);
}

function textWeight(s: string): number {
  let n = 0;
  for (const g of graphemes(s)) {
    if (EMOJI_RE.test(g)) {
      n += 2;
      continue;
    }
    for (const ch of g) n += isLight(ch.codePointAt(0) ?? 0) ? 1 : 2;
  }
  return n;
}

export function xWeightedLength(text: string): number {
  const s = text.normalize('NFC');
  let total = 0;
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const start = m.index;
    // Trailing sentence punctuation isn't part of the link.
    const url = m[0].replace(/[.,!?;:)\]]+$/, '');
    total += textWeight(s.slice(last, start)) + URL_WEIGHT;
    last = start + url.length;
  }
  return total + textWeight(s.slice(last));
}
