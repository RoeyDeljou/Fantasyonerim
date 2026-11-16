import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_CONFIG, FplEntryIdSchema } from '@fant/shared';
import { MAX_ASSISTANT_TESTERS, addTester, draftOf, parseAssistantDraft } from './draft';

const base = draftOf(DEFAULT_ASSISTANT_CONFIG);

describe('parseAssistantDraft (Admin → Settings → Ask Alfie)', () => {
  it('round-trips the defaults; empty script / partner = null', () => {
    expect(parseAssistantDraft(base)).toEqual({ ok: true, config: DEFAULT_ASSISTANT_CONFIG });
  });
  it('accepts a script on fpl-lad.com (any subdomain) and trims fields', () => {
    const r = parseAssistantDraft({
      ...base,
      visibility: 'everyone',
      scriptUrl: ' https://cdn.fpl-lad.com/embed.js ',
      partnerId: ' fant ',
    });
    expect(r).toEqual({
      ok: true,
      config: {
        visibility: 'everyone',
        scriptUrl: 'https://cdn.fpl-lad.com/embed.js',
        partnerId: 'fant',
        fallbackUrl: 'https://www.fpl-lad.com/chat',
        testerEntryIds: [28060],
      },
    });
  });
  it('keeps the tester list as edited (an empty list stays empty — no testers)', () => {
    const one = addTester([], '77');
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(parseAssistantDraft({ ...base, testerEntryIds: one.list })).toEqual({
      ok: true,
      config: { ...DEFAULT_ASSISTANT_CONFIG, testerEntryIds: [77] },
    });
    expect(parseAssistantDraft({ ...base, testerEntryIds: [] })).toEqual({
      ok: true,
      config: { ...DEFAULT_ASSISTANT_CONFIG, testerEntryIds: [] },
    });
  });
  it('rejects a script on another host, over http, or a look-alike domain', () => {
    for (const scriptUrl of [
      'https://evil.example/embed.js',
      'http://www.fpl-lad.com/embed.js',
      'https://fpl-lad.com.evil.example/embed.js',
      'https://notfpl-lad.com/embed.js',
    ]) {
      expect(parseAssistantDraft({ ...base, scriptUrl })).toEqual({ ok: false, errors: { scriptUrl: true } });
    }
  });
  it('rejects a non-https fallback and an over-long partner id', () => {
    expect(parseAssistantDraft({ ...base, fallbackUrl: 'http://x.example' })).toEqual({
      ok: false,
      errors: { fallbackUrl: true },
    });
    expect(parseAssistantDraft({ ...base, partnerId: 'x'.repeat(81) })).toEqual({
      ok: false,
      errors: { partnerId: true },
    });
  });
});

describe('addTester (Ask Alfie → Testers)', () => {
  const ids = (...n: number[]) => n.map((x) => FplEntryIdSchema.parse(x));
  it('adds a positive integer Team ID (trimmed)', () => {
    expect(addTester(ids(28060), ' 123 ')).toEqual({ ok: true, list: ids(28060, 123) });
  });
  it('rejects non-integers, zero, negatives, decimals and empty input', () => {
    for (const input of ['', ' ', 'abc', '0', '-5', '1.5', '1e3', '123456789']) {
      expect(addTester([], input)).toEqual({ ok: false, error: 'invalid' });
    }
  });
  it('rejects a duplicate', () => {
    expect(addTester(ids(28060), '28060')).toEqual({ ok: false, error: 'duplicate' });
  });
  it('caps the list at 50', () => {
    const full = ids(...Array.from({ length: MAX_ASSISTANT_TESTERS }, (_, i) => i + 1));
    expect(addTester(full, '999')).toEqual({ ok: false, error: 'full' });
  });
});
