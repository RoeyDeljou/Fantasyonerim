/** User-perceived characters (grapheme clusters): an emoji like 🦁 or 👨‍👩‍👧 is one, never half a surrogate pair. */
export function graphemes(s: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s), (x) => x.segment);
  }
  return Array.from(s); // code points — still never splits a surrogate pair
}

export function firstGrapheme(s: string): string {
  return graphemes(s.trim())[0] ?? '';
}

const LETTER = /[\p{L}\p{N}]/u;

/** First grapheme that is a letter or digit ("[Roy]" → "R"); falls back to the first grapheme (emoji names). */
function firstLetter(word: string): string {
  return graphemes(word).find((g) => LETTER.test(g)) ?? firstGrapheme(word);
}

function oneWord(word: string, n: number): string {
  const gs = graphemes(word);
  const start = Math.max(
    0,
    gs.findIndex((g) => LETTER.test(g)),
  );
  return gs
    .slice(start)
    .filter((g, i) => i === 0 || LETTER.test(g))
    .slice(0, n)
    .join('');
}

/**
 * Up to two initials: first letter of the first and last word ("Dor Cohen" → "DC"); a single word gives its
 * first two characters only when `pairFromOneWord` (badge fallbacks like "LI"), otherwise one. Punctuation-only
 * words ("Roy [test]" → "RT", "Roy -" → "R") never produce a bracket or dash initial.
 */
export function initials(name: string, { pairFromOneWord = false } = {}): string {
  const all = name.trim().split(/\s+/).filter(Boolean);
  const lettered = all.filter((w) => LETTER.test(w));
  const words = lettered.length > 0 ? lettered : all;
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  const out = last ? firstLetter(first) + firstLetter(last) : oneWord(first, pairFromOneWord ? 2 : 1);
  return out.toLocaleUpperCase();
}
