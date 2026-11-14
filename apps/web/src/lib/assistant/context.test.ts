import { describe, expect, it } from 'vitest';
import { DEFAULT_PARTNER, assistantUrl, partnerOf, resolveTeamId } from './context';
import type { AssistantContext } from './context';

const ctx: AssistantContext = { partner: 'fantasyonerim', teamId: 1234567, locale: 'he', theme: 'dark' };

describe('assistantUrl (in-app panel + "open in a new tab")', () => {
  it('embed URL carries partner, embed=1, locale, theme and teamId', () => {
    const u = new URL(assistantUrl('https://www.fpl-lad.com/', ctx, { embed: true }));
    expect(u.origin + u.pathname).toBe('https://www.fpl-lad.com/');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      partner: 'fantasyonerim',
      embed: '1',
      locale: 'he',
      theme: 'dark',
      teamId: '1234567',
    });
  });
  it('the new-tab link has no embed flag; no teamId when unknown', () => {
    const u = new URL(
      assistantUrl('https://www.fpl-lad.com/?embed=1', { ...ctx, teamId: undefined }, { embed: false }),
    );
    expect(u.searchParams.has('embed')).toBe(false);
    expect(u.searchParams.has('teamId')).toBe(false);
    expect(u.searchParams.get('locale')).toBe('he');
  });
  it('keeps parameters already on the URL; ours win on a clash', () => {
    const u = new URL(
      assistantUrl(
        'https://chat.fpl-lad.com/alfie?ref=x&locale=fr',
        { ...ctx, locale: 'en' },
        { embed: true },
      ),
    );
    expect(u.pathname).toBe('/alfie');
    expect(u.searchParams.get('ref')).toBe('x');
    expect(u.searchParams.get('locale')).toBe('en');
  });
});

describe('partnerOf / resolveTeamId', () => {
  it('partner defaults to fantasyonerim', () => {
    expect(partnerOf(null)).toBe(DEFAULT_PARTNER);
    expect(partnerOf('  ')).toBe(DEFAULT_PARTNER);
    expect(partnerOf(' fant-01 ')).toBe('fant-01');
  });
  it('the account entry wins, else a guest draft, digits only', () => {
    expect(resolveTeamId(42, '99')).toBe(42);
    expect(resolveTeamId(null, '99')).toBe(99);
    expect(resolveTeamId(undefined, ' 1000003 ')).toBe(1000003);
    expect(resolveTeamId(null, '')).toBeUndefined();
    expect(resolveTeamId(null, '12a')).toBeUndefined();
    expect(resolveTeamId(null, '0')).toBeUndefined();
    expect(resolveTeamId(0, null)).toBeUndefined();
  });
});
