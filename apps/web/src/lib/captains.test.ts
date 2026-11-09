import { describe, expect, it } from 'vitest';
import {
  captainBadge,
  customTag,
  defaultTagText,
  isPermanentKind,
  MAX_TAG_LENGTH,
  normalizeTag,
} from './captains';
import { previewRows } from './roundup';

const labels = { mine: 'הקפטן שלי', community: 'קהילה', linkedTeam: 'קבוצת FPL' };

describe('captainBadge', () => {
  it('uses the defaults when no tag is set', () => {
    expect(captainBadge({ kind: 'community', source: 'player', tag: null }, labels)).toEqual({
      text: 'קהילה',
      logo: false,
    });
    expect(captainBadge({ kind: 'custom', source: 'entry' }, labels)).toEqual({
      text: 'קבוצת FPL',
      logo: false,
    });
    expect(captainBadge({ kind: 'mine', source: 'mine' }, labels)).toEqual({
      text: 'הקפטן שלי',
      logo: false,
    });
  });
  it('a hand-picked custom player has no badge by default', () => {
    expect(captainBadge({ kind: 'custom', source: 'player', tag: '' }, labels)).toEqual({
      text: null,
      logo: false,
    });
  });
  it('a set tag replaces the default (a custom captain never reads "community")', () => {
    expect(captainBadge({ kind: 'custom', source: 'entry', tag: ' Legend ' }, labels)).toEqual({
      text: 'Legend',
      logo: false,
    });
    expect(captainBadge({ kind: 'community', tag: 'הקהל' }, labels).text).toBe('הקהל');
  });
  it('FPL Lad: the logo alone by default, the logo then the text with a tag', () => {
    expect(captainBadge({ kind: 'fpl_lad', source: 'player', tag: null }, labels)).toEqual({
      text: null,
      logo: true,
    });
    expect(captainBadge({ kind: 'fpl_lad', source: 'player', tag: 'Pro' }, labels)).toEqual({
      text: 'Pro',
      logo: true,
    });
  });
  it('the viewer’s own row ignores any tag', () => {
    expect(captainBadge({ kind: 'mine', tag: 'x' }, labels).text).toBe('הקפטן שלי');
  });
});

describe('tag helpers', () => {
  it('blank tags are not set', () => {
    expect(customTag('   ')).toBeNull();
    expect(customTag(null)).toBeNull();
    expect(customTag(undefined)).toBeNull();
    expect(customTag(' a ')).toBe('a');
  });
  it('normalizeTag trims, caps at 24 and maps blank to null', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('  hi  ')).toBe('hi');
    expect(normalizeTag('x'.repeat(40))).toHaveLength(MAX_TAG_LENGTH);
  });
  it('default text per kind', () => {
    expect(defaultTagText('fpl_lad', 'player', labels)).toBeNull();
    expect(defaultTagText('community', 'player', labels)).toBe('קהילה');
    expect(defaultTagText('custom', 'player', labels)).toBeNull();
  });
  it('only community and fpl_lad are permanent', () => {
    expect(isPermanentKind('community')).toBe(true);
    expect(isPermanentKind('fpl_lad')).toBe(true);
    expect(isPermanentKind('custom')).toBe(false);
  });
});

describe('season list preview', () => {
  const rows = Array.from({ length: 30 }, (_, i) => i);
  it('shows the top 10 collapsed and everything expanded', () => {
    expect(previewRows(rows, false)).toHaveLength(10);
    expect(previewRows(rows, true)).toHaveLength(30);
  });
  it('a short list is shown whole (no one- or two-row tease)', () => {
    expect(previewRows(rows.slice(0, 12), false)).toHaveLength(12);
  });
});
