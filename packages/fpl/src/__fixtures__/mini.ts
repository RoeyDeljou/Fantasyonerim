/**
 * Small hand-written raw FPL payloads for focused tests. Shapes mirror the real API (trimmed to the
 * fields we read plus a few extras to prove the schemas tolerate unknown keys).
 */

export type Pos = 1 | 2 | 3 | 4;

export interface MiniPlayer {
  id: number;
  team: number;
  type: Pos;
}

export function rawElement(p: MiniPlayer) {
  return {
    id: p.id,
    code: 100000 + p.id,
    web_name: `P${p.id}`,
    first_name: 'Player',
    second_name: String(p.id),
    team: p.team,
    team_code: p.team,
    element_type: p.type,
    now_cost: 50,
    photo: `${100000 + p.id}.jpg`,
    status: 'a',
    news: '',
    chance_of_playing_next_round: null,
    selected_by_percent: '10.5',
    form: '3.0',
    total_points: 20,
    event_points: 2,
    ep_next: '3.1', // unknown to our schema
  };
}

export function rawEvent(
  id: number,
  opts: { current?: boolean; finished?: boolean; deadline?: string } = {},
) {
  return {
    id,
    name: `Gameweek ${id}`,
    deadline_time: opts.deadline ?? `2025-10-${String(id + 9).padStart(2, '0')}T10:00:00Z`,
    finished: opts.finished ?? false,
    data_checked: opts.finished ?? false,
    is_current: opts.current ?? false,
    is_next: false,
    is_previous: false,
    average_entry_score: 50,
    highest_score: 100,
    chip_plays: [],
  };
}

export function rawBootstrap(players: readonly MiniPlayer[], events = [rawEvent(1, { current: true })]) {
  const teams = [...new Set(players.map((p) => p.team))].sort((a, b) => a - b);
  return {
    events,
    teams: teams.map((id) => ({ id, code: id * 10, name: `Team ${id}`, short_name: `T${id}`, strength: 3 })),
    elements: players.map(rawElement),
    element_types: [],
    total_players: 1,
  };
}

export type MiniStatus = 'not_started' | 'live' | 'finished_provisional' | 'finished';

export function rawFixture(f: {
  id: number;
  h: number;
  a: number;
  status: MiniStatus;
  event?: number;
  bps?: readonly (readonly [number, number])[]; // [element, bps]
  bonus?: readonly (readonly [number, number])[];
}) {
  const started = f.status !== 'not_started';
  return {
    code: 9000 + f.id,
    event: f.event ?? 1,
    finished: f.status === 'finished',
    finished_provisional: f.status === 'finished' || f.status === 'finished_provisional',
    id: f.id,
    kickoff_time: '2025-10-11T14:00:00Z',
    minutes: f.status === 'live' ? 55 : started ? 90 : 0,
    provisional_start_time: false,
    started,
    team_a: f.a,
    team_a_score: started ? 0 : null,
    team_h: f.h,
    team_h_score: started ? 1 : null,
    stats: started
      ? [
          { identifier: 'goals_scored', a: [], h: [] },
          {
            identifier: 'bonus',
            a: [],
            h: (f.bonus ?? []).map(([element, value]) => ({ element, value })),
          },
          {
            identifier: 'bps',
            a: [],
            h: (f.bps ?? []).map(([element, value]) => ({ element, value })),
          },
        ]
      : [],
  };
}

export function rawLiveElement(
  id: number,
  s: { minutes?: number; points?: number; bps?: number; bonus?: number; goals?: number } = {},
) {
  const minutes = s.minutes ?? 90;
  return {
    id,
    stats: {
      minutes,
      goals_scored: s.goals ?? 0,
      assists: 0,
      clean_sheets: 0,
      goals_conceded: 0,
      own_goals: 0,
      yellow_cards: 0,
      red_cards: 0,
      saves: 0,
      bonus: s.bonus ?? 0,
      bps: s.bps ?? 0,
      total_points: s.points ?? (minutes >= 60 ? 2 : minutes > 0 ? 1 : 0),
      in_dreamteam: false,
    },
    explain: [],
    modified: false,
  };
}

export function rawPicks(
  elements: readonly number[],
  opts: {
    captain?: number;
    vice?: number;
    chip?: string | null;
    cost?: number;
    points?: number;
    total?: number;
    event?: number;
  } = {},
) {
  const captain = opts.captain ?? elements[0];
  const vice = opts.vice ?? elements[1];
  const chip = opts.chip ?? null;
  return {
    active_chip: chip,
    automatic_subs: [],
    entry_history: {
      event: opts.event ?? 1,
      points: opts.points ?? 0,
      total_points: opts.total ?? 0,
      rank: 1000,
      rank_sort: 1000,
      overall_rank: 5000,
      percentile_rank: 5,
      bank: 5,
      value: 1000,
      event_transfers: opts.cost ? opts.cost / 4 + 1 : 0,
      event_transfers_cost: opts.cost ?? 0,
      points_on_bench: 0,
    },
    picks: elements.map((element, i) => ({
      element,
      position: i + 1,
      multiplier: i >= 11 ? (chip === 'bboost' ? 1 : 0) : element === captain ? (chip === '3xc' ? 3 : 2) : 1,
      is_captain: element === captain,
      is_vice_captain: element === vice,
      element_type: 1,
    })),
  };
}

/**
 * A standard 15-man squad over two teams (team 1 vs team 2 in fixture 1 by default).
 * Slots: 1 GK(1) | 2-5 DEF(2..5) | 6-9 MID(6..9) | 10-11 FWD(10,11) | 12 GK(12) | 13 DEF(13) | 14 MID(14) | 15 FWD(15)
 * Formation 4-4-2. Odd ids play for team 1, even ids for team 2.
 */
export function standardSquad(): MiniPlayer[] {
  const type = (id: number): Pos =>
    id === 1 || id === 12 ? 1 : id <= 5 || id === 13 ? 2 : id <= 9 || id === 14 ? 3 : 4;
  return Array.from({ length: 15 }, (_, i) => ({ id: i + 1, team: (i % 2) + 1, type: type(i + 1) }));
}
export const SQUAD_IDS = Array.from({ length: 15 }, (_, i) => i + 1);
