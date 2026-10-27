import { describe, expect, it } from 'vitest';
import { X_MAX, xWeightedLength } from './xLength';

describe('xWeightedLength', () => {
  it('counts Latin and Hebrew as 1 per character', () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('גול!')).toBe(4);
  });

  it('counts any URL as 23', () => {
    expect(xWeightedLength('https://example.com/a/very/long/path?with=query')).toBe(23);
    expect(xWeightedLength('ראו https://x.com/a.')).toBe(4 + 23 + 1);
    expect(xWeightedLength('www.fpl.com')).toBe(23);
  });

  it('counts an emoji as 2, including ZWJ sequences and flags', () => {
    expect(xWeightedLength('⚽')).toBe(2);
    expect(xWeightedLength('🅰️')).toBe(2);
    expect(xWeightedLength('👨‍👩‍👧')).toBe(2);
    expect(xWeightedLength('🇮🇱')).toBe(2);
    expect(xWeightedLength('⚽ גול!')).toBe(2 + 1 + 4);
  });

  it('counts CJK as 2', () => {
    expect(xWeightedLength('日本')).toBe(4);
  });

  it('flags text over the limit', () => {
    expect(xWeightedLength('a'.repeat(X_MAX))).toBe(280);
    expect(xWeightedLength('⚽'.repeat(141))).toBeGreaterThan(X_MAX);
  });
});
