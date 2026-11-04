/**
 * REAL FPL data, recorded 2026-11-04 from fantasy.premierleague.com: classic league 4611 standings page 1
 * (trimmed to 3 standings rows). `new_entries` is present and empty, as FPL serves it mid-season.
 */

export const REAL_LEAGUE_4611_STANDINGS = {
  league: {
    admin_entry: 11597,
    closed: false,
    code_privacy: 'p',
    created: '2026-07-23T12:20:03.563285Z',
    cup_league: null,
    has_cup: true,
    id: 4611,
    league_type: 'x',
    max_entries: null,
    name: 'Fantasyonerim',
    rank: null,
    scoring: 'c',
    start_event: 1,
  },
  standings: {
    has_next: true,
    page: 1,
    results: [
      {
        club_badge_src:
          'https://fantasy.premierleague.com/gcs/plfpl-production-adobe-approved/plfpl-production/2594446/cba47dbb-84b6-4389-b3e7-cd8c80bb8698.png',
        entry: 2594446,
        entry_name: 'Noam The Goat',
        event_total: 59,
        last_rank: 1,
        player_name: 'Noam Applebaum',
        rank: 1,
        rank_sort: 1,
        total: 672,
      },
      {
        club_badge_src:
          'https://fantasy.premierleague.com/gcs/plfpl-production-adobe-approved/plfpl-production/2548084/e5f6f8e1-0ab1-4b75-b68e-a9a7ed39d8ec.png',
        entry: 2548084,
        entry_name: 'גיא זינגר',
        event_total: 83,
        last_rank: 6,
        player_name: 'Guy Singer',
        rank: 2,
        rank_sort: 2,
        total: 671,
      },
      {
        club_badge_src: null,
        entry: 29799,
        entry_name: 'Gar-Nachos',
        event_total: 59,
        last_rank: 2,
        player_name: 'liam ficher',
        rank: 3,
        rank_sort: 3,
        total: 663,
      },
    ],
  },
  last_updated_data: '2026-11-04T11:15:03Z',
  new_entries: {
    has_next: false,
    page: 1,
    results: [],
  },
};
