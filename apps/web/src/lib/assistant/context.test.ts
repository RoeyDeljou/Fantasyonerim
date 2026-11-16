import { describe, expect, it } from 'vitest';
import { DEFAULT_PARTNER, assistantUrl, partnerOf, resolveTeamId } from './context';
import type { AssistantContext } from './context';

const ctx: AssistantContext = { partner: 'fantasyonerim', teamId: 1234567, locale: 'he', theme: 'dark' };

describe('assistantUrl (in-app panel + "open in a new tab")', () => {
  it("embed URL: FPL Lad's example order — teamId, lang, embed=1, partner, theme", () => {
    expect(assistantUrl('https://www.fpl-lad.com/chat', { ...ctx, teamId: 28060 }, { embed: true })).toBe(
      'https://www.fpl-lad.com/chat?teamId=28060&lang=he&embed=1&partner=fantasyonerim&theme=dark',
    );
  });
  it('sends lang, never locale', () => {
    const u = new URL(
      assistantUrl('https://www.fpl-lad.com/chat', { ...ctx, locale: 'en' }, { embed: true }),
    );
    expect(u.searchParams.get('lang')).toBe('en');
    expect(u.searchParams.has('locale')).toBe(false);
  });
  it('the new-tab link has no embed flag; no teamId when unknown', () => {
    expect(
      assistantUrl('https://www.fpl-lad.com/chat?embed=1', { ...ctx, teamId: undefined }, { embed: false }),
    ).toBe('https://www.fpl-lad.com/chat?lang=he&partner=fantasyonerim&theme=dark');
  });
  it('keeps parameters already on the URL (first); ours win on a clash; a stale locale is dropped', () => {
    const u = new URL(
      assistantUrl(
        'https://chat.fpl-lad.com/alfie?ref=x&lang=fr&locale=fr&teamId=1',
        { ...ctx, locale: 'en' },
        { embed: true },
      ),
    );
    expect(u.pathname).toBe('/alfie');
    expect([...u.searchParams.keys()]).toEqual(['ref', 'teamId', 'lang', 'embed', 'partner', 'theme']);
    expect(u.searchParams.get('ref')).toBe('x');
    expect(u.searchParams.get('lang')).toBe('en');
    expect(u.searchParams.get('teamId')).toBe('1234567');
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
