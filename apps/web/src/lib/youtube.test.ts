import { describe, expect, it } from 'vitest';
import { youtubeChannel, youtubeEmbedUrl, youtubeThumbnailUrl, youtubeVideoId } from './newsFormat';

describe('youtubeVideoId', () => {
  it('reads Shorts links', () => {
    expect(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://m.youtube.com/shorts/a-B_c1d2E3f/')).toBe('a-B_c1d2E3f');
  });

  it('reads watch, youtu.be, embed and live links', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ')).toBe('dQw4w9WgXcQ');
  });

  it('rejects anything else', () => {
    expect(youtubeVideoId('https://www.youtube.com/@fantasyonerim')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/shorts/')).toBeNull();
    expect(youtubeVideoId('https://evil.example/shorts/dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('javascript:alert(1)')).toBeNull();
    expect(youtubeVideoId('dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('')).toBeNull();
  });
});

describe('youtube urls', () => {
  it('builds the nocookie autoplay embed', () => {
    expect(youtubeEmbedUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0',
    );
  });
  it('builds the thumbnail url', () => {
    expect(youtubeThumbnailUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });
});

describe('youtubeChannel', () => {
  it('accepts handles in any form', () => {
    expect(youtubeChannel('@Fantasyonerim')).toBe('@Fantasyonerim');
    expect(youtubeChannel('youtube.com/@Fantasyonerim')).toBe('@Fantasyonerim');
    expect(youtubeChannel('https://www.youtube.com/@Fantasyonerim/videos')).toBe('@Fantasyonerim');
  });
  it('accepts channel ids and legacy urls', () => {
    const id = 'UC1234567890abcdefghijAB';
    expect(youtubeChannel(id)).toBe(id);
    expect(youtubeChannel(`https://www.youtube.com/channel/${id}`)).toBe(id);
    expect(youtubeChannel('https://youtube.com/c/Fantasyonerim')).toBe(
      'https://www.youtube.com/c/Fantasyonerim',
    );
    expect(youtubeChannel('youtube.com/user/fant')).toBe('https://www.youtube.com/user/fant');
  });
  it('rejects non-channels', () => {
    expect(youtubeChannel('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeChannel('https://x.com/@Fantasyonerim')).toBeNull();
    expect(youtubeChannel('hello world')).toBeNull();
    expect(youtubeChannel('')).toBeNull();
  });
});
