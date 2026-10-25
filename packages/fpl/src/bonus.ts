export interface BpsScore {
  element: number;
  value: number;
}

/**
 * Bonus points from a single fixture's BPS list, following FPL's tie rules:
 *
 * - rank players by BPS (highest first) and award 3 / 2 / 1;
 * - players tied on BPS share the higher award, and the places they occupy are consumed:
 *   - tie for 1st → both get 3, the next player gets 1;
 *   - three-way tie for 1st → all get 3, nobody else scores;
 *   - tie for 2nd → both get 2, nobody gets 1;
 *   - tie for 3rd → all tied players get 1.
 *
 * Pure. Returns element id → bonus (only elements that earn bonus are present).
 */
export function bonusFromBps(scores: readonly BpsScore[]): Map<number, number> {
  const sorted = [...scores].sort((a, b) => b.value - a.value || a.element - b.element);
  const awards = new Map<number, number>();
  let placed = 0;
  let i = 0;
  while (i < sorted.length && placed < 3) {
    const value = (sorted[i] as BpsScore).value;
    let j = i;
    while (j < sorted.length && (sorted[j] as BpsScore).value === value) j++;
    const award = 3 - placed;
    for (let k = i; k < j; k++) awards.set((sorted[k] as BpsScore).element, award);
    placed += j - i;
    i = j;
  }
  return awards;
}
