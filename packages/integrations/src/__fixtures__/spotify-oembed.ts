/**
 * Real response recorded live from Spotify's public oEmbed endpoint (2026-10):
 *   GET https://open.spotify.com/oembed?url=https://open.spotify.com/episode/7mgtvQCYpj3GZVETi46eP1
 * The `html` iframe markup was abbreviated; every other field is verbatim.
 */
export const SPOTIFY_EP61_ID = '7mgtvQCYpj3GZVETi46eP1';

export const realSpotifyOEmbedEp61 = {
  html: `<iframe style="border-radius: 12px" width="100%" height="351" title="Spotify Embed: פרק 61 - אישומים ושערים" frameborder="0" allowfullscreen allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" src="https://open.spotify.com/embed/episode/${SPOTIFY_EP61_ID}/video?utm_source=oembed"></iframe>`,
  iframe_url: `https://open.spotify.com/embed/episode/${SPOTIFY_EP61_ID}/video?utm_source=oembed`,
  width: 624,
  height: 351,
  version: '1.0',
  provider_name: 'Spotify',
  provider_url: 'https://spotify.com',
  type: 'video',
  title: 'פרק 61 - אישומים ושערים',
  thumbnail_url: 'https://image-cdn-fa.spotifycdn.com/image/ab6772ab000015be436269816b65777337ae72b9',
  thumbnail_width: 640,
  thumbnail_height: 360,
};

/**
 * Audio-only episode — NOT recorded (assumption): oEmbed is expected to answer `type: "rich"` with the
 * square show cover as the thumbnail.
 */
export const assumedSpotifyOEmbedAudioOnly = {
  ...realSpotifyOEmbedEp61,
  type: 'rich',
  iframe_url: `https://open.spotify.com/embed/episode/${SPOTIFY_EP61_ID}?utm_source=oembed`,
  height: 152,
  thumbnail_url: 'https://i.scdn.co/image/ab67656300005f1f0000000000000000000000aa',
  thumbnail_width: 300,
  thumbnail_height: 300,
};
