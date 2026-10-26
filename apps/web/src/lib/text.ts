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

/**
 * Up to two initials: first letter of the first and last word ("Dor Cohen" → "DC"); a single word gives its
 * first two characters only when `pairFromOneWord` (badge fallbacks like "LI"), otherwise one.
 */
export function initials(name: string, { pairFromOneWord = false } = {}): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  const out = last
    ? firstGrapheme(first) + firstGrapheme(last)
    : graphemes(first)
        .slice(0, pairFromOneWord ? 2 : 1)
        .join('');
  return out.toLocaleUpperCase();
}
