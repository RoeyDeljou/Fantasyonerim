/**
 * Approximation of X's weighted character count (twitter-text v3 config): URLs count 23; code points
 * in the "light" ranges (Latin, Hebrew, Arabic, Cyrillic, … = U+0000–U+10FF, general punctuation)
 * count 1; everything else — CJK, emoji (one per grapheme, incl. ZWJ sequences / flags / skin tones) —
 * counts 2. The limit is 280 weighted characters.
 */
export const X_MAX_WEIGHTED_LENGTH = 280;
export const X_URL_WEIGHT = 23;

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/giu;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function codePointWeight(cp: number): number {
  if (cp <= 0x10ff) return 1;
  if ((cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)) {
    return 1;
  }
  return 2;
}

export function xWeightedLength(text: string): number {
  const normalized = text.normalize('NFC');
  let total = 0;
  let last = 0;
  for (const m of normalized.matchAll(URL_RE)) {
    total += weighPlain(normalized.slice(last, m.index));
    total += X_URL_WEIGHT;
    last = m.index + m[0].length;
  }
  return total + weighPlain(normalized.slice(last));
}

function weighPlain(s: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (EMOJI_RE.test(segment)) {
      total += 2;
      continue;
    }
    for (const ch of segment) total += codePointWeight(ch.codePointAt(0) ?? 0);
  }
  return total;
}
