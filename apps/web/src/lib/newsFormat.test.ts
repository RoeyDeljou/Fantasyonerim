import { describe, expect, it } from 'vitest';
import {
  applePodcastId,
  episodeTitle,
  expiresWithin,
  formatDuration,
  linkify,
  relativeParts,
  spotifyShowId,
  xUsername,
} from './newsFormat';

describe('formatDuration', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(4403)).toBe('1:13:23');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(-3)).toBe('0:00');
  });
});

describe('relativeParts', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  it('buckets by unit', () => {
    expect(relativeParts('2026-10-26T11:59:40Z', now)).toBe('now');
    expect(relativeParts('2026-10-26T11:55:00Z', now)).toEqual({ value: -5, unit: 'minute' });
    expect(relativeParts('2026-10-26T09:00:00Z', now)).toEqual({ value: -3, unit: 'hour' });
    expect(relativeParts('2026-10-24T12:00:00Z', now)).toEqual({ value: -2, unit: 'day' });
    expect(relativeParts('2026-10-01T12:00:00Z', now)).toBeNull();
  });
});

describe('linkify', () => {
  it('finds urls, mentions and Hebrew hashtags for X', () => {
    const tokens = linkify('פרק חדש! https://spoti.fi/abc. @Fantasyonerim #פנטזי_ליג', 'x');
    expect(tokens).toEqual([
      { kind: 'text', value: 'פרק חדש! ' },
      { kind: 'url', value: 'https://spoti.fi/abc', href: 'https://spoti.fi/abc' },
      { kind: 'text', value: '. ' },
      { kind: 'mention', value: '@Fantasyonerim', href: 'https://x.com/Fantasyonerim' },
      { kind: 'text', value: ' ' },
      {
        kind: 'hashtag',
        value: '#פנטזי_ליג',
        href: 'https://x.com/hashtag/%D7%A4%D7%A0%D7%98%D7%96%D7%99_%D7%9C%D7%99%D7%92',
      },
    ]);
  });
  it('ignores emails and leaves mentions as text when the platform is unknown', () => {
    expect(linkify('mail dor@example.com', 'x')).toEqual([{ kind: 'text', value: 'mail dor@example.com' }]);
    expect(linkify('hi @dor', 'none')).toEqual([{ kind: 'text', value: 'hi @dor' }]);
  });
  it('links instagram handles to instagram', () => {
    const [, m] = linkify('w/ @fantasyonerimfpl.', 'instagram');
    expect(m).toEqual({
      kind: 'mention',
      value: '@fantasyonerimfpl',
      href: 'https://www.instagram.com/fantasyonerimfpl/',
    });
  });
  it('adds https to www links', () => {
    expect(linkify('www.fpl.com', 'none')).toEqual([
      { kind: 'url', value: 'www.fpl.com', href: 'https://www.fpl.com' },
    ]);
  });
});

describe('settings parsers', () => {
  it('extracts a Spotify show id', () => {
    expect(spotifyShowId('https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk?si=x')).toBe(
      '4rOoJ6Egrf8K2IrywzwOMk',
    );
    expect(spotifyShowId('spotify:show:4rOoJ6Egrf8K2IrywzwOMk')).toBe('4rOoJ6Egrf8K2IrywzwOMk');
    expect(spotifyShowId('4rOoJ6Egrf8K2IrywzwOMk')).toBe('4rOoJ6Egrf8K2IrywzwOMk');
    expect(spotifyShowId('nope')).toBeNull();
  });
  it('extracts an Apple podcast id', () => {
    expect(applePodcastId('https://podcasts.apple.com/il/podcast/x/id1819558192')).toBe('1819558192');
    expect(applePodcastId('1819558192')).toBe('1819558192');
    expect(applePodcastId('abc')).toBeNull();
  });
  it('normalizes an X username', () => {
    expect(xUsername('@Fantasyonerim')).toBe('Fantasyonerim');
    expect(xUsername('https://x.com/Fantasyonerim')).toBe('Fantasyonerim');
    expect(xUsername('bad name')).toBeNull();
  });
  it('detects near expiry', () => {
    const now = Date.parse('2026-10-26T00:00:00Z');
    expect(expiresWithin('2026-11-01T00:00:00Z', 14, now)).toBe(true);
    expect(expiresWithin('2027-01-01T00:00:00Z', 14, now)).toBe(false);
    expect(expiresWithin(null, 14, now)).toBe(false);
  });
});

describe('episodeTitle', () => {
  it('drops a prefix that repeats the episode number', () => {
    expect(episodeTitle("פרק 62 - אין צ'יפים, נגמרו הצ'יפים", 62)).toBe("אין צ'יפים, נגמרו הצ'יפים");
    expect(episodeTitle('Ep. 5: Wildcard time', 5)).toBe('Wildcard time');
    expect(episodeTitle('פרק 61 - משהו', 62)).toBe('פרק 61 - משהו');
    expect(episodeTitle('פרק 62', 62)).toBe('פרק 62');
    expect(episodeTitle('Title', null)).toBe('Title');
  });
});
