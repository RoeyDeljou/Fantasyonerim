import { describe, expect, it } from 'vitest';
import { initials } from './text';

describe('initials', () => {
  it('takes the first letters of the first and last word', () => {
    expect(initials('Dor Cohen')).toBe('DC');
    expect(initials('דור דבוש')).toBe('דד');
  });
  it('skips brackets and punctuation', () => {
    expect(initials('רועי [בדיקה]')).toBe('רב');
    expect(initials('Roy -')).toBe('R');
    expect(initials('(Noa)')).toBe('N');
  });
  it('keeps emoji names whole', () => {
    expect(initials('🦁')).toBe('🦁');
    expect(initials('👨‍👩‍👧 Fans')).toBe('F');
  });
  it('pairs from one word only when asked', () => {
    expect(initials('Liverpool', { pairFromOneWord: true })).toBe('LI');
    expect(initials('Liverpool')).toBe('L');
  });
});
