import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_CONFIG } from '@fant/shared';
import { draftOf, parseAssistantDraft } from './draft';

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
        fallbackUrl: 'https://www.fpl-lad.com/',
      },
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
