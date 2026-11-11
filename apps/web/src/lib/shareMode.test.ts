import { describe, expect, it } from 'vitest';
import { effectiveShareMode, shareModeInfo, voteCaption } from './shareMode';

const st = (status: 'not_open' | 'open' | 'locked', event: number | null = 11, opens: number | null = 10) =>
  ({ status, event, opensAfterEvent: opens }) as never;

describe('shareModeInfo', () => {
  it('an open vote defaults to the vote poster', () => {
    expect(shareModeInfo(st('open'))).toEqual({ defaultMode: 'vote', voteBlocked: null });
  });
  it('not_open and locked default to the battle and say why the vote is off', () => {
    expect(shareModeInfo(st('not_open'))).toEqual({
      defaultMode: 'battle',
      voteBlocked: { kind: 'not_open', gw: 10 },
    });
    expect(shareModeInfo(st('locked'))).toEqual({
      defaultMode: 'battle',
      voteBlocked: { kind: 'locked', gw: 11 },
    });
  });
  it('no gameweek or no state: blocked', () => {
    expect(shareModeInfo(st('open', null)).voteBlocked).toEqual({ kind: 'no_event' });
    expect(shareModeInfo(undefined).voteBlocked).toEqual({ kind: 'unavailable' });
  });
});

describe('effectiveShareMode', () => {
  const open = shareModeInfo(st('open'));
  const locked = shareModeInfo(st('locked'));
  it('picked beats requested beats default', () => {
    expect(effectiveShareMode(open, null, undefined)).toBe('vote');
    expect(effectiveShareMode(open, 'battle', 'vote')).toBe('battle');
    expect(effectiveShareMode(open, null, 'battle')).toBe('battle');
  });
  it('a blocked vote falls back to the battle', () => {
    expect(effectiveShareMode(locked, null, 'vote')).toBe('battle');
    expect(effectiveShareMode(locked, 'vote', undefined)).toBe('battle');
  });
});

describe('voteCaption', () => {
  const t = {
    withDeadline: 'Vote for GW {gw}! Closes {when}',
    withoutDeadline: 'Vote for GW {gw}!',
  };
  it('names the gameweek and the deadline when known', () => {
    expect(voteCaption(t, 11, '21 Nov at 13:00')).toBe('Vote for GW 11! Closes 21 Nov at 13:00');
    expect(voteCaption(t, 11, null)).toBe('Vote for GW 11!');
  });
});
