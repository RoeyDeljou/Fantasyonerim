import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, episodeNumberFromTitle, htmlToPlainText, normalizeTitle } from './text.js';

describe('htmlToPlainText', () => {
  it('turns paragraphs and <br> into line breaks and decodes entities (Hebrew safe)', () => {
    const html =
      '<p>תם עידן הצ׳יפים?</p><p> הפנטזיונרים מסכמים את GW7</p><p>1:04:19 - צ&#39;יפים &amp; קפטנים</p>' +
      '<p><br></p><p><strong>https://linktr.ee/Fantasyonerim</strong></p>';
    expect(htmlToPlainText(html)).toBe(
      "תם עידן הצ׳יפים?\nהפנטזיונרים מסכמים את GW7\n1:04:19 - צ'יפים & קפטנים\n\nhttps://linktr.ee/Fantasyonerim",
    );
  });

  it('handles lists, links, scripts and collapses blank lines', () => {
    const html =
      '<script>alert(1)</script><h2>Title</h2>\n\n<ul><li>one</li><li>two</li></ul>' +
      '<p>Listen <a href="https://open.spotify.com/show/x">here</a> or <a href="https://x.com/a">x.com/a</a></p>' +
      '<p></p><p></p><p></p><div>end&nbsp;&nbsp;line</div>';
    expect(htmlToPlainText(html)).toBe(
      'Title\n\n• one\n• two\nListen here (https://open.spotify.com/show/x) or x.com/a\n\nend line',
    );
  });

  it('leaves plain text alone and decodes numeric entities incl. emoji', () => {
    expect(htmlToPlainText('just text &#x1F399;&#65039; &unknown;')).toBe('just text 🎙️ &unknown;');
    expect(decodeHtmlEntities('&lt;b&gt; &quot;x&quot; &#0; &#xD800;')).toBe('<b> "x" &#0; &#xD800;');
  });
});

describe('normalizeTitle', () => {
  it('ignores punctuation, emoji, geresh variants, case and whitespace', () => {
    const rss = "פרק 62 - אין צ'יפים, נגמרו הצ'יפים";
    const spotify = 'פרק 62 – אין צ׳יפים,  נגמרו  הצ׳יפים 🎙️';
    expect(normalizeTitle(rss)).toBe(normalizeTitle(spotify));
    expect(normalizeTitle(rss)).toBe('פרק 62 אין ציפים נגמרו הציפים');
    expect(normalizeTitle('Hello, WORLD!!')).toBe('hello world');
  });

  it('optionally strips the "פרק NN -" / "Episode NN:" prefix', () => {
    expect(normalizeTitle('פרק 61 - אישומים ושערים', { stripEpisodePrefix: true })).toBe('אישומים ושערים');
    expect(normalizeTitle('Episode 12: Big Break', { stripEpisodePrefix: true })).toBe('big break');
    expect(normalizeTitle('#7 | title', { stripEpisodePrefix: true })).toBe('title');
  });

  it('removes niqqud', () => {
    expect(normalizeTitle('שָׁלוֹם')).toBe('שלום');
  });
});

describe('episodeNumberFromTitle', () => {
  it('reads Hebrew and English episode numbers', () => {
    expect(episodeNumberFromTitle('פרק 62 - אין')).toBe(62);
    expect(episodeNumberFromTitle('Ep. 60 | פגרה')).toBe(60);
    expect(episodeNumberFromTitle('בונוס: פרק 5')).toBe(5);
    expect(episodeNumberFromTitle('טריילר')).toBeNull();
  });
});
