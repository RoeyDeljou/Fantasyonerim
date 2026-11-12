import { describe, expect, it } from 'vitest';
import { fplImage } from './fplImage';

describe('fplImage', () => {
  it('player photos use the premierleague25 CDN path without the p prefix', () => {
    expect(fplImage.photo('223094')).toBe(
      'https://resources.premierleague.com/premierleague25/photos/players/110x140/223094.png',
    );
    expect(fplImage.photo('223094.jpg')).toBe(
      'https://resources.premierleague.com/premierleague25/photos/players/110x140/223094.png',
    );
    expect(fplImage.photo('223094.PNG')).toBe(
      'https://resources.premierleague.com/premierleague25/photos/players/110x140/223094.png',
    );
  });
  it('club badges are SVGs on the premierleague25 CDN path', () => {
    expect(fplImage.badge(14)).toBe('https://resources.premierleague.com/premierleague25/badges/14.svg');
  });
  it('shirts are unchanged', () => {
    expect(fplImage.shirt(14, false)).toBe(
      'https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_14-66.png',
    );
    expect(fplImage.shirt(14, true)).toBe(
      'https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_14_1-66.png',
    );
  });
});
