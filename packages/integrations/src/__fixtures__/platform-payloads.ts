/**
 * Hand-written payloads in the documented response shapes (no credentials exist in the build sandbox
 * for Spotify, Instagram or X). Field names/structure follow:
 *   - Spotify Web API `GET /v1/shows/{id}/episodes` (SimplifiedEpisodeObject paging object)
 *   - Instagram Graph API (Facebook Login) `/{ig-user-id}/media`, `/{ig-user-id}/stories`, `/me/accounts`
 *   - X API v2 `GET /2/users/:id/tweets` with `expansions=attachments.media_keys`
 */

// ---------- Spotify ----------
export const SPOTIFY_SHOW_ID = '4rOoJ6Egrf8K2IrywzwOMk';

export const spotifyToken = { access_token: 'BQD-spotify-token-1', token_type: 'Bearer', expires_in: 3600 };

export const spotifyEpisodesPage1 = {
  href: `https://api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes?offset=0&limit=50&market=IL`,
  limit: 50,
  offset: 0,
  total: 62,
  previous: null,
  next: `https://api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes?offset=2&limit=2&market=IL`,
  items: [
    {
      id: '5Nv2PDZb0j1UN8O1IcPWIr',
      name: 'פרק 62 - אין צ׳יפים, נגמרו הצ׳יפים',
      release_date: '2026-10-21',
      release_date_precision: 'day',
      duration_ms: 4403000,
      type: 'episode',
      uri: 'spotify:episode:5Nv2PDZb0j1UN8O1IcPWIr',
      external_urls: { spotify: 'https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr' },
    },
    // Spotify returns null for episodes unavailable in the market.
    null,
    {
      id: '3p7qiG6xSrZHNSOyYyfITx',
      name: 'פרק 61 – אישומים ושערים! ⚽️',
      release_date: '2026-10-14',
      release_date_precision: 'day',
      duration_ms: 3900000,
      type: 'episode',
      uri: 'spotify:episode:3p7qiG6xSrZHNSOyYyfITx',
      external_urls: { spotify: 'https://open.spotify.com/episode/3p7qiG6xSrZHNSOyYyfITx' },
    },
  ],
};

export const spotifyEpisodesPage2 = {
  href: `https://api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes?offset=2&limit=2&market=IL`,
  limit: 50,
  offset: 2,
  total: 62,
  previous: null,
  next: `https://api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes?offset=4&limit=2&market=IL`,
  items: [
    {
      // Renamed on Spotify: only the episode number + date can match it.
      id: '0aB1cD2eF3gH4iJ5kL6mN7',
      name: 'Ep. 60 | פגרה',
      release_date: '2026-10-08',
      release_date_precision: 'day',
      external_urls: { spotify: 'https://open.spotify.com/episode/0aB1cD2eF3gH4iJ5kL6mN7' },
    },
    {
      id: '1zY2xW3vU4tS5rQ6pO7nM8',
      name: 'פרק 30 - ישן מאוד',
      release_date: '2025-12-01',
      release_date_precision: 'day',
      external_urls: { spotify: 'https://open.spotify.com/episode/1zY2xW3vU4tS5rQ6pO7nM8' },
    },
  ],
};

// ---------- Instagram (graph.facebook.com) ----------
export const IG_USER_ID = '17841400000000001';

export const igShortToken = { access_token: 'EAAshort', token_type: 'bearer', expires_in: 5183 };
export const igLongToken = { access_token: 'EAAlonglived', token_type: 'bearer', expires_in: 5183944 };
export const igAccounts = {
  data: [
    {
      id: '1000000000000001',
      name: 'Fantasyonerim',
      access_token: 'EAApagetoken',
      instagram_business_account: {
        id: IG_USER_ID,
        username: 'pod_fantasyonerim',
        profile_picture_url: 'https://scontent.cdninstagram.com/v/t51/profile.jpg?_nc_ht=x&oe=6900AAAA',
      },
    },
    // A page without a linked Instagram account is not connectable.
    { id: '1000000000000002', name: 'Other page', access_token: 'EAAotherpage' },
  ],
  paging: { cursors: { before: 'QVFI', after: 'QVFJ' } },
};
export const igDebugToken = {
  data: {
    app_id: '123',
    type: 'PAGE',
    is_valid: true,
    expires_at: 0,
    data_access_expires_at: 1800000000,
    scopes: ['instagram_basic', 'pages_show_list', 'pages_read_engagement', 'business_management'],
  },
};

export const igMedia = {
  data: [
    {
      id: '18000000000000001',
      caption: 'קפטן למחזור 8? 🧢\nהאלאנד או סלאח',
      media_type: 'IMAGE',
      media_product_type: 'FEED',
      media_url: 'https://scontent.cdninstagram.com/v/t51/img1.jpg?oe=6900AAAA',
      permalink: 'https://www.instagram.com/p/DAAAAAAAAA1/',
      timestamp: '2026-10-24T18:30:00+0000',
    },
    {
      id: '18000000000000002',
      caption: 'רילס מהפרק החדש 🎙️',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      media_url: 'https://scontent.cdninstagram.com/o1/v/t16/reel.mp4?oe=6900AAAA',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/reel-thumb.jpg?oe=6900AAAA',
      permalink: 'https://www.instagram.com/reel/DAAAAAAAAA2/',
      timestamp: '2026-10-23T10:00:00+0000',
    },
    {
      id: '18000000000000003',
      caption: 'סיכום GW7 בשלוש תמונות',
      media_type: 'CAROUSEL_ALBUM',
      media_product_type: 'FEED',
      media_url: 'https://scontent.cdninstagram.com/v/t51/c1.jpg?oe=6900AAAA',
      permalink: 'https://www.instagram.com/p/DAAAAAAAAA3/',
      timestamp: '2026-10-22T09:00:00+0000',
      children: {
        data: [
          {
            media_type: 'IMAGE',
            media_url: 'https://scontent.cdninstagram.com/v/t51/c1.jpg?oe=6900AAAA',
            id: '18000000000000031',
          },
          {
            media_type: 'VIDEO',
            media_url: 'https://scontent.cdninstagram.com/o1/v/t16/c2.mp4?oe=6900AAAA',
            thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/c2-thumb.jpg?oe=6900AAAA',
            id: '18000000000000032',
          },
          // Copyright-restricted child: no media_url → dropped, the rest of the album is kept.
          { media_type: 'VIDEO', id: '18000000000000033' },
        ],
      },
    },
    {
      // Copyright-restricted reel (music): Instagram omits media_url → skipped, not a crash.
      id: '18000000000000004',
      caption: 'עם מוזיקה',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      permalink: 'https://www.instagram.com/reel/DAAAAAAAAA4/',
      timestamp: '2026-10-21T09:00:00+0000',
    },
    // Malformed object → skipped.
    { id: '18000000000000005', media_type: 'HOLOGRAM' },
    {
      id: '18000000000000006',
      media_type: 'IMAGE',
      media_product_type: 'FEED',
      media_url: 'https://scontent.cdninstagram.com/v/t51/nocaption.jpg?oe=6900AAAA',
      permalink: 'https://www.instagram.com/p/DAAAAAAAAA6/',
      timestamp: '2026-10-20T09:00:00+0000',
    },
  ],
  paging: {
    cursors: { before: 'QVFIUa', after: 'QVFIUb' },
    next: `https://graph.facebook.com/v26.0/${IG_USER_ID}/media?after=QVFIUb`,
  },
};

export const igStories = {
  data: [
    {
      id: '17900000000000002',
      media_type: 'VIDEO',
      media_url: 'https://scontent.cdninstagram.com/o1/v/t16/story2.mp4?oe=6900AAAA',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/story2-thumb.jpg?oe=6900AAAA',
      permalink: 'https://instagram.com/stories/pod_fantasyonerim/17900000000000002',
      timestamp: '2026-10-25T08:00:00+0000',
    },
    {
      id: '17900000000000001',
      media_type: 'IMAGE',
      media_url: 'https://scontent.cdninstagram.com/v/t51/story1.jpg?oe=6900AAAA',
      permalink: 'https://instagram.com/stories/pod_fantasyonerim/17900000000000001',
      timestamp: '2026-10-25T07:00:00+0000',
    },
    { id: '17900000000000003', media_type: 'VIDEO', timestamp: '2026-10-25T09:00:00+0000' },
  ],
};

export function graphErrorBody(code: number, message = 'Error', subcode?: number) {
  return {
    error: {
      message,
      type: 'OAuthException',
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: 'AbCdEf',
    },
  };
}

// ---------- X ----------
export const X_USER_ID = '1790000000000000001';

export const xUser = { data: { id: X_USER_ID, name: 'פנטזיונרים', username: 'Fantasyonerim' } };

export const xTimeline = {
  data: [
    {
      id: '1850000000000000003',
      created_at: '2026-10-24T19:00:00.000Z',
      edit_history_tweet_ids: ['1850000000000000003'],
      text: 'פרק 62 באוויר! 🎙️ https://t.co/ep62link https://t.co/mediaphoto',
      entities: {
        urls: [
          {
            start: 17,
            end: 40,
            url: 'https://t.co/ep62link',
            expanded_url: 'https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr',
            display_url: 'open.spotify.com/episode/5Nv2PD…',
          },
          {
            start: 41,
            end: 64,
            url: 'https://t.co/mediaphoto',
            expanded_url: 'https://x.com/Fantasyonerim/status/1850000000000000003/photo/1',
            display_url: 'pic.x.com/mediaphoto',
            media_key: '3_1850000000000000100',
          },
        ],
      },
      attachments: { media_keys: ['3_1850000000000000100'] },
    },
    {
      id: '1850000000000000002',
      created_at: '2026-10-23T12:00:00.000Z',
      edit_history_tweet_ids: ['1850000000000000002'],
      text: 'שרשור ארוך על הקפטנים למחזור 8 — האלאנד, סלאח, פאלמר ומה עם… https://t.co/longcut',
      entities: {
        urls: [
          {
            start: 60,
            end: 83,
            url: 'https://t.co/longcut',
            expanded_url: 'https://x.com/i/web/status/1850000000000000002',
          },
        ],
      },
      note_tweet: {
        text: 'שרשור ארוך על הקפטנים למחזור 8 — האלאנד, סלאח, פאלמר ומה עם הדיפנס של ארסנל?\n\nכל הנתונים בטבלה: https://t.co/sheet1',
        entities: {
          urls: [
            {
              start: 98,
              end: 121,
              url: 'https://t.co/sheet1',
              expanded_url: 'https://docs.google.com/spreadsheets/d/abc',
              display_url: 'docs.google.com/spreadsheets/…',
            },
          ],
        },
      },
      attachments: { media_keys: ['7_1850000000000000200'] },
    },
    {
      id: '1850000000000000001',
      created_at: 'not-a-date',
      text: 'broken date',
    },
    { id: 'not-numeric', text: 'malformed id', created_at: '2026-10-22T12:00:00.000Z' },
  ],
  includes: {
    media: [
      {
        media_key: '3_1850000000000000100',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/GaAAAAAAAAA.jpg',
        width: 1200,
        height: 675,
      },
      {
        media_key: '7_1850000000000000200',
        type: 'video',
        preview_image_url: 'https://pbs.twimg.com/ext_tw_video_thumb/1850000000000000200/pu/img/thumb.jpg',
        width: 1280,
        height: 720,
        variants: [
          {
            content_type: 'application/x-mpegURL',
            url: 'https://video.twimg.com/ext_tw_video/200/pu/pl/playlist.m3u8',
          },
          {
            bit_rate: 256000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/ext_tw_video/200/pu/vid/480x270/low.mp4',
          },
          {
            bit_rate: 2176000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/ext_tw_video/200/pu/vid/1280x720/high.mp4',
          },
          {
            bit_rate: 832000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/ext_tw_video/200/pu/vid/640x360/mid.mp4',
          },
        ],
      },
    ],
  },
  meta: {
    result_count: 4,
    newest_id: '1850000000000000003',
    oldest_id: '1850000000000000001',
  },
};

export const xEmptyTimeline = { meta: { result_count: 0 } };
