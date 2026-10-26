import { bonusFromBps } from '../bonus.js';
import {
  computeLivePoints,
  createGameweekContext,
  type EnginePlayer,
  type GameweekContext,
} from '../live-engine.js';
import { engineFixturesOf, engineLiveOf, toChip } from '../normalize.js';
import type { RawFixture, RawLive, RawPicks } from '../raw.js';
import { DEMO_CLUBS, type DemoClub, type DemoPosition } from './clubs.js';
import { DEMO_MANAGERS } from './managers.js';

/**
 * Deterministic demo dataset in the raw fantasy.premierleague.com response shapes.
 *
 * Time-relative: everything is laid out around `anchorMs` (the moment the demo is "now", floored to the
 * hour) so deadlines/kickoffs always look current. Given the same anchor the output is byte-identical.
 *
 * Story: season 2025/26, GW9 in progress.
 *   GW1–8 finished + data checked (all fixtures finished with bonus).
 *   GW9 fixtures, by kickoff: 4 × finished, 1 × finished_provisional with bonus already added,
 *   1 × finished_provisional with bonus NOT yet added (provisional bonus from BPS), 1 × live (62', live
 *   bonus written into the stats as FPL does), 3 × not started. GW10–38 not started.
 *   League 314159 "Fantasyonerim League": 60 managers, entry ids 1000001–1000060 (page 1 = 50 rows).
 */

export const DEMO_LEAGUE_ID = 314159;
export const DEMO_LEAGUE_NAME = 'Fantasyonerim League';
export const DEMO_CURRENT_EVENT = 9;
export const DEMO_FIRST_ENTRY_ID = 1000001;
export const DEMO_ENTRY_COUNT = DEMO_MANAGERS.length;

/** Entry ids that exercise a specific rule — easy to type in a demo. */
export const DEMO_ENTRIES = {
  /** Plain team, no chip, no hit. */
  normal: 1000001,
  /** Captain was rested (0 min, match finished) → vice captain gets the armband; starter auto-subbed. */
  viceCaptain: 1000002,
  /** Triple Captain this GW. */
  tripleCaptain: 1000003,
  /** Bench Boost this GW. */
  benchBoost: 1000004,
  /** Took a −4 hit this GW. */
  transferHit: 1000005,
  /** Free Hit this GW. */
  freeHit: 1000006,
  /** Wildcard this GW. */
  wildcard: 1000007,
} as const;

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const EVENTS = 38;
const BUDGET = 1000;

// ---------- small helpers ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const randInt = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
function weightedPick<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T | undefined {
  const total = items.reduce((s, t) => s + Math.max(0, weight(t)), 0);
  if (total <= 0) return items[0];
  let r = rng() * total;
  for (const t of items) {
    r -= Math.max(0, weight(t));
    if (r <= 0) return t;
  }
  return items.at(-1);
}
function poisson(rng: Rng, lambda: number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l && k < 10);
  return k - 1;
}
function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const fplIso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ELEMENT_TYPE: Readonly<Record<DemoPosition, number>> = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };

// ---------- players ----------

export interface DemoPlayer {
  id: number;
  code: number;
  club: DemoClub;
  webName: string;
  firstName: string;
  secondName: string;
  position: DemoPosition;
  price: number;
  /** 0-based order within the club pool (first GK = starting keeper). */
  clubIndex: number;
}

function buildPlayers(): DemoPlayer[] {
  const out: DemoPlayer[] = [];
  let id = 1;
  for (const club of DEMO_CLUBS) {
    club.players.forEach(([webName, firstName, secondName, position, price, photo], clubIndex) => {
      out.push({
        id: id++,
        code: photo ?? 100000 + (hashCode(`${firstName} ${secondName}`) % 400000),
        club,
        webName,
        firstName,
        secondName,
        position,
        price,
        clubIndex,
      });
    });
  }
  return out;
}

// ---------- schedule ----------

interface Pairing {
  home: number;
  away: number;
}

/** Double round robin (circle method) over a deterministically shuffled club order. */
function buildSchedule(rng: Rng): Pairing[][] {
  const teams = DEMO_CLUBS.map((c) => c.id);
  for (let i = teams.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [teams[i], teams[j]] = [teams[j] as number, teams[i] as number];
  }
  const n = teams.length;
  const rounds: Pairing[][] = [];
  const rot = [...teams];
  for (let r = 0; r < n - 1; r++) {
    const round: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = rot[i] as number;
      const b = rot[n - 1 - i] as number;
      round.push((r + i) % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
    }
    rounds.push(round);
    rot.splice(1, 0, rot.pop() as number);
  }
  return [...rounds, ...rounds.map((round) => round.map((p) => ({ home: p.away, away: p.home })))];
}

// ---------- match simulation ----------

interface MatchLine {
  element: number;
  minutes: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  saves: number;
  yellowCards: number;
  defensiveContribution: number;
  bps: number;
  bonus: number;
  points: number;
}

type FixtureState =
  'finished' | 'finished_provisional_bonus' | 'finished_provisional' | 'live' | 'not_started';

interface SimulatedFixture {
  id: number;
  event: number;
  kickoffMs: number;
  home: number;
  away: number;
  state: FixtureState;
  minutes: number;
  homeScore: number | null;
  awayScore: number | null;
  lines: MatchLine[];
  bonusAdded: boolean;
}

const GOAL_POINTS: Readonly<Record<DemoPosition, number>> = { GKP: 10, DEF: 6, MID: 5, FWD: 4 };
const GOAL_BPS: Readonly<Record<DemoPosition, number>> = { GKP: 12, DEF: 12, MID: 18, FWD: 24 };

function simulateFixture(
  rng: Rng,
  fixture: Omit<SimulatedFixture, 'homeScore' | 'awayScore' | 'lines' | 'bonusAdded'>,
  byClub: ReadonlyMap<number, DemoPlayer[]>,
  forcedZero: ReadonlySet<number>,
): SimulatedFixture {
  if (fixture.state === 'not_started') {
    return { ...fixture, homeScore: null, awayScore: null, lines: [], bonusAdded: false };
  }
  const cap = fixture.minutes;
  const clubs = [fixture.home, fixture.away].map((id) => DEMO_CLUBS.find((c) => c.id === id) as DemoClub);
  const [hc, ac] = clubs as [DemoClub, DemoClub];
  const scale = cap / 90;
  const homeGoals = poisson(rng, Math.max(0.3, (1.35 + (hc.strength - ac.strength) * 0.3) * scale));
  const awayGoals = poisson(rng, Math.max(0.2, (1.05 + (ac.strength - hc.strength) * 0.3) * scale));

  const lines: MatchLine[] = [];
  const side = (clubId: number, scored: number, conceded: number) => {
    const pool = byClub.get(clubId) ?? [];
    const sideLines: { p: DemoPlayer; l: MatchLine }[] = [];
    let firstGkSeen = false;
    for (const p of pool) {
      let minutes: number;
      if (forcedZero.has(p.id)) minutes = 0;
      else if (p.position === 'GKP') {
        minutes = firstGkSeen ? 0 : cap;
        firstGkSeen = true;
      } else {
        // Stars rarely start on the bench.
        const r = rng() * (p.price >= 75 ? 2.2 : 1);
        if (r < 0.08) minutes = 0;
        else if (r < 0.22) minutes = Math.max(0, cap - (90 - randInt(rng, 8, 30)));
        else if (r < 0.38) minutes = Math.min(cap, randInt(rng, 58, 85));
        else minutes = cap;
      }
      sideLines.push({
        p,
        l: {
          element: p.id,
          minutes,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          goalsConceded: 0,
          saves: 0,
          yellowCards: 0,
          defensiveContribution: 0,
          bps: 0,
          bonus: 0,
          points: 0,
        },
      });
    }
    const playing = sideLines.filter((s) => s.l.minutes > 0);
    const outfield = playing.filter((s) => s.p.position !== 'GKP');
    const goalWeight: Record<DemoPosition, number> = { GKP: 0, DEF: 0.6, MID: 2.5, FWD: 4 };
    const assistWeight: Record<DemoPosition, number> = { GKP: 0.1, DEF: 1, MID: 3, FWD: 2 };
    for (let g = 0; g < scored && outfield.length > 0; g++) {
      const scorer = weightedPick(
        rng,
        outfield,
        (s) => goalWeight[s.p.position] * Math.pow(s.p.price / 55, 3) * (s.l.minutes / 90),
      );
      if (!scorer) continue;
      scorer.l.goals++;
      if (rng() < 0.75) {
        const assister = weightedPick(
          rng,
          playing.filter((s) => s !== scorer),
          (s) => assistWeight[s.p.position] * Math.pow(s.p.price / 55, 2),
        );
        if (assister) assister.l.assists++;
      }
    }
    for (const { p, l } of sideLines) {
      if (l.minutes <= 0) continue;
      const full = l.minutes >= 60;
      if (full && conceded === 0) l.cleanSheets = 1;
      if (full) l.goalsConceded = conceded;
      if (p.position === 'GKP') l.saves = randInt(rng, 0, Math.round(5 * scale));
      if (rng() < 0.12) l.yellowCards = 1;
      const defChance = p.position === 'DEF' ? 0.25 : p.position === 'MID' ? 0.1 : 0.04;
      if (p.position !== 'GKP' && full && rng() < defChance)
        l.defensiveContribution = p.position === 'DEF' ? 10 : 12;
      const gcPenalty = p.position === 'GKP' || p.position === 'DEF' ? Math.floor(l.goalsConceded / 2) : 0;
      const csPoints = l.cleanSheets
        ? p.position === 'GKP' || p.position === 'DEF'
          ? 4
          : p.position === 'MID'
            ? 1
            : 0
        : 0;
      l.points =
        (full ? 2 : 1) +
        l.goals * GOAL_POINTS[p.position] +
        l.assists * 3 +
        csPoints -
        gcPenalty +
        Math.floor(l.saves / 3) -
        l.yellowCards +
        (l.defensiveContribution > 0 ? 2 : 0);
      l.bps =
        (full ? 6 : 3) +
        l.goals * GOAL_BPS[p.position] +
        l.assists * 9 +
        (l.cleanSheets && (p.position === 'GKP' || p.position === 'DEF') ? 12 : 0) +
        l.saves * 2 -
        (p.position === 'GKP' || p.position === 'DEF' ? l.goalsConceded * 4 : 0) -
        l.yellowCards * 3 +
        randInt(rng, 0, 14);
    }
    lines.push(...sideLines.map((s) => s.l));
  };
  side(fixture.home, homeGoals, awayGoals);
  side(fixture.away, awayGoals, homeGoals);

  // FPL 2025/26 writes live bonus into the stats during the match; one finished_provisional fixture is
  // left without it to exercise the computed-from-BPS path.
  const bonusAdded = fixture.state !== 'finished_provisional';
  if (bonusAdded) {
    const awards = bonusFromBps(
      lines.filter((l) => l.minutes > 0).map((l) => ({ element: l.element, value: l.bps })),
    );
    for (const l of lines) {
      l.bonus = awards.get(l.element) ?? 0;
      l.points += l.bonus;
    }
  }
  return { ...fixture, homeScore: homeGoals, awayScore: awayGoals, lines, bonusAdded };
}

// ---------- raw JSON builders ----------

type FixtureJson = RawFixture & Record<string, unknown>;

function fixtureJson(f: SimulatedFixture, players: ReadonlyMap<number, DemoPlayer>): FixtureJson {
  const isHome = (element: number) => players.get(element)?.club.id === f.home;
  const stat = (identifier: string, value: (l: MatchLine) => number) => {
    const entries = f.lines
      .map((l) => ({ value: value(l), element: l.element }))
      .filter((e) => e.value !== 0)
      .sort((a, b) => b.value - a.value || a.element - b.element);
    return {
      identifier,
      a: entries.filter((e) => !isHome(e.element)),
      h: entries.filter((e) => isHome(e.element)),
    };
  };
  const started = f.state !== 'not_started';
  const homeTeam = DEMO_CLUBS.find((c) => c.id === f.home) as DemoClub;
  const awayTeam = DEMO_CLUBS.find((c) => c.id === f.away) as DemoClub;
  return {
    code: 2561000 + f.id,
    event: f.event,
    finished: f.state === 'finished',
    finished_provisional: f.state === 'finished' || f.state.startsWith('finished_provisional'),
    id: f.id,
    kickoff_time: fplIso(f.kickoffMs),
    minutes: f.minutes,
    provisional_start_time: false,
    started,
    team_a: f.away,
    team_a_score: f.awayScore,
    team_h: f.home,
    team_h_score: f.homeScore,
    stats: started
      ? [
          stat('goals_scored', (l) => l.goals),
          stat('assists', (l) => l.assists),
          stat('own_goals', () => 0),
          stat('penalties_saved', () => 0),
          stat('penalties_missed', () => 0),
          stat('yellow_cards', (l) => l.yellowCards),
          stat('red_cards', () => 0),
          stat('saves', (l) => l.saves),
          stat('bonus', (l) => l.bonus),
          stat('bps', (l) => (l.minutes > 0 ? l.bps : 0)),
          stat('defensive_contribution', (l) => l.defensiveContribution),
        ]
      : [],
    team_h_difficulty: Math.min(5, Math.max(2, awayTeam.strength)),
    team_a_difficulty: Math.min(5, Math.max(2, homeTeam.strength)),
    pulse_id: 124000 + f.id,
  };
}

function liveElementJson(
  id: number,
  position: DemoPosition,
  fixtureId: number | null,
  l: MatchLine | undefined,
) {
  const line = l ?? {
    minutes: 0,
    goals: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    saves: 0,
    yellowCards: 0,
    defensiveContribution: 0,
    bps: 0,
    bonus: 0,
    points: 0,
  };
  const explainStats: { identifier: string; points: number; value: number; points_modification: number }[] =
    [];
  if (l && l.minutes > 0 && fixtureId !== null) {
    const push = (identifier: string, value: number, points: number) => {
      if (value !== 0) explainStats.push({ identifier, points, value, points_modification: 0 });
    };
    const keeperOrDef = position === 'GKP' || position === 'DEF';
    push('minutes', l.minutes, l.minutes >= 60 ? 2 : 1);
    push('goals_scored', l.goals, l.goals * GOAL_POINTS[position]);
    push('assists', l.assists, l.assists * 3);
    push('clean_sheets', l.cleanSheets, l.cleanSheets ? (keeperOrDef ? 4 : position === 'MID' ? 1 : 0) : 0);
    push('goals_conceded', l.goalsConceded, keeperOrDef ? -Math.floor(l.goalsConceded / 2) : 0);
    push('saves', l.saves, Math.floor(l.saves / 3));
    push('yellow_cards', l.yellowCards, -l.yellowCards);
    push('defensive_contribution', l.defensiveContribution, l.defensiveContribution > 0 ? 2 : 0);
    push('bonus', l.bonus, l.bonus);
  }
  return {
    id,
    stats: {
      minutes: line.minutes,
      goals_scored: line.goals,
      assists: line.assists,
      clean_sheets: line.cleanSheets,
      goals_conceded: line.goalsConceded,
      own_goals: 0,
      penalties_saved: 0,
      penalties_missed: 0,
      yellow_cards: line.yellowCards,
      red_cards: 0,
      saves: line.saves,
      bonus: line.bonus,
      bps: line.bps,
      influence: (line.bps * 0.8).toFixed(1),
      creativity: (line.assists * 18.5).toFixed(1),
      threat: (line.goals * 25).toFixed(1),
      ict_index: ((line.bps * 0.8 + line.assists * 18.5 + line.goals * 25) / 10).toFixed(1),
      clearances_blocks_interceptions: 0,
      recoveries: 0,
      tackles: 0,
      defensive_contribution: line.defensiveContribution,
      starts: line.minutes >= 45 ? 1 : 0,
      expected_goals: (line.goals * 0.62).toFixed(2),
      expected_assists: (line.assists * 0.41).toFixed(2),
      expected_goal_involvements: (line.goals * 0.62 + line.assists * 0.41).toFixed(2),
      expected_goals_conceded: (line.goalsConceded * 0.9).toFixed(2),
      total_points: line.points,
      in_dreamteam: false,
    },
    explain:
      fixtureId !== null && explainStats.length > 0 ? [{ fixture: fixtureId, stats: explainStats }] : [],
    modified: false,
  };
}

// ---------- dataset ----------

export interface DemoDataset {
  anchorMs: number;
  currentEvent: number;
  leagueId: number;
  entryIds: readonly number[];
  /** Element id of the player rested in GW9 (0 min in a finished fixture), captained by 1000002. */
  restedPlayerId: number;
  bootstrap: Record<string, unknown>;
  fixtures: readonly FixtureJson[];
  live: ReadonlyMap<number, RawLive & Record<string, unknown>>;
  entries: ReadonlyMap<number, Record<string, unknown>>;
  histories: ReadonlyMap<number, Record<string, unknown>>;
  /** key `${entryId}:${event}` */
  picks: ReadonlyMap<string, RawPicks & Record<string, unknown>>;
  standingsPages: readonly Record<string, unknown>[];
}

export interface BuildDemoOptions {
  /** The demo's "now". Defaults to a fixed instant (2025-10-26T12:00:00Z) for full reproducibility. */
  anchorMs?: number;
  seed?: number;
}

export const DEMO_DEFAULT_ANCHOR_MS = Date.UTC(2025, 9, 26, 12, 0, 0);

const FORMATIONS: readonly (readonly [number, number, number])[] = [
  [3, 4, 3],
  [3, 5, 2],
  [4, 4, 2],
  [4, 3, 3],
  [4, 5, 1],
  [5, 3, 2],
  [5, 4, 1],
  [3, 4, 3],
  [4, 4, 2],
];

export function buildDemoDataset(options: BuildDemoOptions = {}): DemoDataset {
  const anchor = Math.floor((options.anchorMs ?? DEMO_DEFAULT_ANCHOR_MS) / HOUR) * HOUR;
  const rng = mulberry32(options.seed ?? 20252026);
  const current = DEMO_CURRENT_EVENT;

  const players = buildPlayers();
  const playerById = new Map(players.map((p) => [p.id, p]));
  const byClub = new Map<number, DemoPlayer[]>();
  for (const p of players) byClub.set(p.club.id, [...(byClub.get(p.club.id) ?? []), p]);
  const enginePlayers = new Map<number, EnginePlayer>(
    players.map((p) => [p.id, { id: p.id, teamId: p.club.id, position: p.position }]),
  );

  // ----- events & fixtures -----
  const schedule = buildSchedule(rng);
  const currentDeadline = anchor - 26 * HOUR;
  const deadlineOf = (event: number) => currentDeadline + (event - current) * WEEK;
  const gw9Kickoffs = [
    anchor - 24.5 * HOUR,
    anchor - 22 * HOUR,
    anchor - 20 * HOUR,
    anchor - 6 * HOUR,
    anchor - 135 * MINUTE,
    anchor - 135 * MINUTE,
    anchor - 80 * MINUTE,
    anchor + 1.5 * HOUR,
    anchor + 23 * HOUR,
    anchor + 25 * HOUR,
  ];
  const gw9States: readonly FixtureState[] = [
    'finished',
    'finished',
    'finished',
    'finished',
    'finished_provisional_bonus',
    'finished_provisional',
    'live',
    'not_started',
    'not_started',
    'not_started',
  ];

  // The rested player: the priciest outfielder of GW9's first home side. An injured player: not used.
  const gw9First = schedule[current - 1]?.[0] as Pairing;
  const rested = [...(byClub.get(gw9First.home) ?? [])]
    .filter((p) => p.position !== 'GKP')
    .sort((a, b) => b.price - a.price)[0] as DemoPlayer;
  const injured = players.find((p) => p.webName === 'Rodon') ?? (players[0] as DemoPlayer);
  const forcedZero = new Set([rested.id, injured.id]);

  const simulated: SimulatedFixture[] = [];
  let fixtureId = 1;
  for (let event = 1; event <= EVENTS; event++) {
    const round = schedule[event - 1] ?? [];
    round.forEach((pair, i) => {
      const isCurrent = event === current;
      const state: FixtureState =
        event < current ? 'finished' : isCurrent ? (gw9States[i] ?? 'not_started') : 'not_started';
      const kickoffMs = isCurrent
        ? (gw9Kickoffs[i] as number)
        : deadlineOf(event) + 1.5 * HOUR + i * 2.5 * HOUR;
      const minutes = state === 'not_started' ? 0 : state === 'live' ? 62 : 90;
      simulated.push(
        simulateFixture(
          rng,
          { id: fixtureId++, event, kickoffMs, home: pair.home, away: pair.away, state, minutes },
          byClub,
          event === current ? forcedZero : new Set([injured.id]),
        ),
      );
    });
  }
  const fixturesJson = simulated.map((f) => fixtureJson(f, playerById));

  // ----- live per event -----
  const live = new Map<number, RawLive & Record<string, unknown>>();
  const pointsByEvent = new Map<number, Map<number, MatchLine>>();
  for (let event = 1; event <= EVENTS; event++) {
    const eventFixtures = simulated.filter((f) => f.event === event);
    if (eventFixtures.every((f) => f.state === 'not_started')) {
      live.set(event, { elements: [] });
      continue;
    }
    const lineByElement = new Map<number, { fixture: number; line: MatchLine }>();
    for (const f of eventFixtures)
      for (const l of f.lines) lineByElement.set(l.element, { fixture: f.id, line: l });
    pointsByEvent.set(event, new Map([...lineByElement].map(([id, v]) => [id, v.line])));
    live.set(event, {
      elements: players.map((p) => {
        const v = lineByElement.get(p.id);
        const fx = eventFixtures.find((f) => f.home === p.club.id || f.away === p.club.id);
        return liveElementJson(p.id, p.position, fx && fx.state !== 'not_started' ? fx.id : null, v?.line);
      }),
    });
  }

  const contexts = new Map<number, GameweekContext>();
  const contextFor = (event: number): GameweekContext => {
    let ctx = contexts.get(event);
    if (!ctx) {
      ctx = createGameweekContext({
        players: enginePlayers,
        fixtures: engineFixturesOf(fixturesJson.filter((f) => f.event === event)),
        live: engineLiveOf(live.get(event) ?? { elements: [] }),
      });
      contexts.set(event, ctx);
    }
    return ctx;
  };

  // ----- managers -----
  const entryIds = DEMO_MANAGERS.map((_, i) => DEMO_FIRST_ENTRY_ID + i);
  const gw9Chip: Record<number, string> = {
    [DEMO_ENTRIES.tripleCaptain]: '3xc',
    [DEMO_ENTRIES.benchBoost]: 'bboost',
    [DEMO_ENTRIES.freeHit]: 'freehit',
    [DEMO_ENTRIES.wildcard]: 'wildcard',
    1000021: '3xc',
    1000026: 'bboost',
    1000032: 'freehit',
    1000041: 'wildcard',
  };
  const gw9Hit: Record<number, number> = {
    [DEMO_ENTRIES.transferHit]: 4,
    1000010: 8,
    1000016: 4,
    1000034: 4,
  };

  interface ManagerState {
    entryId: number;
    squad: DemoPlayer[];
    slots: DemoPlayer[]; // index 0 = slot 1
    bank: number;
    history: Record<string, unknown>[];
    chips: { name: string; time: string; event: number }[];
    totals: number[]; // totals[event]
    eventPoints: number[];
  }
  const managers: ManagerState[] = [];
  const picksMap = new Map<string, RawPicks & Record<string, unknown>>();

  for (const entryId of entryIds) {
    const mrng = mulberry32(hashCode(`entry-${entryId}`));
    const forced: DemoPlayer[] =
      entryId === DEMO_ENTRIES.viceCaptain
        ? [rested]
        : entryId === 1000003 || entryId === 1000012
          ? [rested]
          : [];
    const squad = buildSquad(mrng, players, forced);
    const formation = FORMATIONS[Math.floor(mrng() * FORMATIONS.length)] as readonly [number, number, number];
    const slots = arrangeSlots(squad, formation, forced);
    const cost = squad.reduce((s, p) => s + p.price, 0);
    const chips: { name: string; time: string; event: number }[] = [];
    const chip9 = gw9Chip[entryId] ?? null;
    // Earlier chips (first-half set): some wildcards and triple captains.
    const earlyWildcard = chip9 !== 'wildcard' && mrng() < 0.3 ? randInt(mrng, 3, 7) : null;
    const earlyTc = chip9 !== '3xc' && mrng() < 0.12 ? randInt(mrng, 2, 8) : null;
    const chipAt = (event: number): string | null =>
      event === current
        ? chip9
        : event === earlyWildcard
          ? 'wildcard'
          : event === earlyTc && event !== earlyWildcard
            ? '3xc'
            : null;

    const state: ManagerState = {
      entryId,
      squad,
      slots,
      bank: BUDGET - cost,
      history: [],
      chips,
      totals: [0],
      eventPoints: [0],
    };

    for (let event = 1; event <= current; event++) {
      const chip = chipAt(event);
      if (chip) chips.push({ name: chip, time: fplIso(deadlineOf(event) - 2 * HOUR), event });
      const starters = slots.slice(0, 11);
      const ranked = [...starters].sort((a, b) => b.price - a.price);
      let captain: DemoPlayer;
      if (event === current && entryId === DEMO_ENTRIES.viceCaptain) captain = rested;
      else {
        const r = mrng();
        captain = (r < 0.6 ? ranked[0] : r < 0.85 ? ranked[1] : ranked[2]) as DemoPlayer;
      }
      const vice = ranked.find((p) => p !== captain) as DemoPlayer;
      const hit = event === current ? (gw9Hit[entryId] ?? 0) : mrng() < 0.1 ? 4 : 0;
      const transfers =
        chip === 'freehit' || chip === 'wildcard'
          ? randInt(mrng, 5, 9)
          : hit > 0
            ? 1 + hit / 4
            : event === 1
              ? 0
              : randInt(mrng, 0, 1);

      const rawPicks = slots.map((p, i) => ({
        element: p.id,
        position: i + 1,
        multiplier: i >= 11 ? (chip === 'bboost' ? 1 : 0) : p === captain ? (chip === '3xc' ? 3 : 2) : 1,
        is_captain: p === captain,
        is_vice_captain: p === vice,
        element_type: ELEMENT_TYPE[p.position],
      }));

      const ctx = contextFor(event);
      const result = computeLivePoints(ctx, {
        picks: rawPicks.map((p) => ({
          playerId: p.element,
          slot: p.position,
          multiplier: p.multiplier,
          isCaptain: p.is_captain,
          isViceCaptain: p.is_vice_captain,
        })),
        activeChip: toChip(chip),
        transfersCost: hit,
      });

      let gross: number;
      let onBench: number;
      let automaticSubs: { entry: number; element_in: number; element_out: number; event: number }[] = [];
      let finalPicks = rawPicks;
      if (event < current) {
        // Finished GW: FPL has applied auto-subs and vice promotion to the multipliers.
        gross = result.livePoints + hit;
        onBench = result.benchPoints;
        automaticSubs = result.autoSubs.map((s) => ({
          entry: entryId,
          element_in: s.in,
          element_out: s.out,
          event,
        }));
        const eff = new Map(result.picks.map((p) => [p.playerId, p.effectiveMultiplier]));
        finalPicks = rawPicks.map((p) => ({ ...p, multiplier: eff.get(p.element) ?? p.multiplier }));
      } else {
        // In-progress GW: FPL's own figure = picked multipliers × processed points (no auto-subs, no
        // provisional bonus).
        const pts = pointsByEvent.get(event) ?? new Map<number, MatchLine>();
        gross = rawPicks.reduce((s, p) => s + p.multiplier * (pts.get(p.element)?.points ?? 0), 0);
        onBench = rawPicks
          .filter((p) => p.multiplier === 0)
          .reduce((s, p) => s + (pts.get(p.element)?.points ?? 0), 0);
      }
      const prevTotal = state.totals[event - 1] ?? 0;
      const total = prevTotal + gross - hit;
      state.totals.push(total);
      state.eventPoints.push(gross);
      const entryHistory = {
        event,
        points: gross,
        total_points: total,
        rank: 0,
        rank_sort: 0,
        overall_rank: 0,
        percentile_rank: 0,
        bank: state.bank,
        value: cost + state.bank,
        event_transfers: transfers,
        event_transfers_cost: hit,
        points_on_bench: onBench,
      };
      state.history.push(entryHistory);
      picksMap.set(`${entryId}:${event}`, {
        active_chip: chip,
        automatic_subs: automaticSubs,
        entry_history: entryHistory,
        picks: finalPicks,
      });
    }
    managers.push(state);
  }

  // ----- ranks (overall: synthetic logistic over the real-world ~11M managers) -----
  const TOTAL_PLAYERS = 11_250_000;
  const logisticRank = (score: number, mean: number, spread: number) =>
    Math.max(1, Math.round(TOTAL_PLAYERS / (1 + Math.exp((score - mean) / spread))));
  const eventStats = new Map<number, { avg: number; max: number; maxEntry: number }>();
  for (let event = 1; event <= current; event++) {
    const pts = managers.map((m) => m.eventPoints[event] ?? 0);
    const avg = Math.round(pts.reduce((s, x) => s + x, 0) / pts.length);
    const max = Math.max(...pts);
    eventStats.set(event, { avg, max, maxEntry: managers[pts.indexOf(max)]?.entryId ?? entryIds[0] ?? 0 });
    const meanTotal = managers.reduce((s, m) => s + (m.totals[event] ?? 0), 0) / managers.length;
    for (const m of managers) {
      const h = m.history[event - 1] as Record<string, number>;
      const gwRank = logisticRank(m.eventPoints[event] ?? 0, avg - 4, 9);
      const overall = logisticRank(m.totals[event] ?? 0, meanTotal - 10, 4 + 6 * Math.sqrt(event));
      h.rank = gwRank;
      h.rank_sort = gwRank;
      h.overall_rank = overall;
      h.percentile_rank = Math.max(1, Math.min(100, Math.ceil((overall / TOTAL_PLAYERS) * 100)));
    }
  }

  // ----- bootstrap -----
  const ownership = new Map<number, number>();
  for (const m of managers) for (const p of m.squad) ownership.set(p.id, (ownership.get(p.id) ?? 0) + 1);
  const seasonTotals = (id: number) => {
    let total = 0;
    let minutes = 0;
    let goals = 0;
    let assists = 0;
    let cs = 0;
    let bonus = 0;
    let bps = 0;
    for (const [, lines] of pointsByEvent) {
      const l = lines.get(id);
      if (!l) continue;
      total += l.points;
      minutes += l.minutes;
      goals += l.goals;
      assists += l.assists;
      cs += l.cleanSheets;
      bonus += l.bonus;
      bps += l.bps;
    }
    return { total, minutes, goals, assists, cs, bonus, bps };
  };
  const formOf = (id: number) => {
    let sum = 0;
    for (let e = current - 3; e <= current; e++) sum += pointsByEvent.get(e)?.get(id)?.points ?? 0;
    return (sum / 4).toFixed(1);
  };

  const teamRecords = new Map<number, { w: number; d: number; l: number; pts: number; gd: number }>();
  for (const c of DEMO_CLUBS) teamRecords.set(c.id, { w: 0, d: 0, l: 0, pts: 0, gd: 0 });
  for (const f of simulated) {
    if (f.state !== 'finished' || f.homeScore === null || f.awayScore === null) continue;
    const h = teamRecords.get(f.home) as { w: number; d: number; l: number; pts: number; gd: number };
    const a = teamRecords.get(f.away) as typeof h;
    h.gd += f.homeScore - f.awayScore;
    a.gd += f.awayScore - f.homeScore;
    if (f.homeScore > f.awayScore) {
      h.w++;
      h.pts += 3;
      a.l++;
    } else if (f.homeScore < f.awayScore) {
      a.w++;
      a.pts += 3;
      h.l++;
    } else {
      h.d++;
      a.d++;
      h.pts++;
      a.pts++;
    }
  }
  const tablePosition = [...DEMO_CLUBS]
    .sort((x, y) => {
      const rx = teamRecords.get(x.id) as { pts: number; gd: number };
      const ry = teamRecords.get(y.id) as { pts: number; gd: number };
      return ry.pts - rx.pts || ry.gd - rx.gd || x.id - y.id;
    })
    .map((c) => c.id);

  const events = Array.from({ length: EVENTS }, (_, i) => {
    const id = i + 1;
    const s = eventStats.get(id);
    const deadline = deadlineOf(id);
    return {
      id,
      name: `Gameweek ${id}`,
      deadline_time: fplIso(deadline),
      release_time: null,
      average_entry_score: s?.avg ?? 0,
      finished: id < current,
      data_checked: id < current,
      highest_scoring_entry: s?.maxEntry ?? null,
      deadline_time_epoch: Math.floor(deadline / 1000),
      deadline_time_game_offset: 0,
      highest_score: s?.max ?? null,
      is_previous: id === current - 1,
      is_current: id === current,
      is_next: id === current + 1,
      cup_leagues_created: false,
      h2h_ko_matches_created: false,
      can_enter: false,
      can_manage: id >= current,
      released: id <= current + 1,
      ranked_count: id <= current ? TOTAL_PLAYERS - 250_000 * (current - id) : 0,
      overrides: { rules: {}, scoring: {}, element_types: [], pick_multiplier: null },
      chip_plays: [
        { chip_name: 'bboost', num_played: id <= current ? 145_000 + id * 1000 : 0 },
        { chip_name: '3xc', num_played: id <= current ? 160_000 + id * 1300 : 0 },
      ],
      most_selected: id <= current ? (players.find((p) => p.webName === 'Haaland')?.id ?? null) : null,
      most_transferred_in: id <= current ? (players.find((p) => p.webName === 'Semenyo')?.id ?? null) : null,
      top_element: null,
      top_element_info: null,
      transfers_made: id <= current ? 9_000_000 + id * 100_000 : 0,
      most_captained: id <= current ? (players.find((p) => p.webName === 'Haaland')?.id ?? null) : null,
      most_vice_captained: id <= current ? (players.find((p) => p.webName === 'M.Salah')?.id ?? null) : null,
    };
  });

  const bootstrap = {
    chips: [
      {
        id: 1,
        name: 'wildcard',
        number: 1,
        start_event: 2,
        stop_event: 19,
        chip_type: 'transfer',
        overrides: {},
      },
      {
        id: 2,
        name: 'freehit',
        number: 1,
        start_event: 2,
        stop_event: 19,
        chip_type: 'transfer',
        overrides: {},
      },
      { id: 3, name: 'bboost', number: 1, start_event: 1, stop_event: 19, chip_type: 'team', overrides: {} },
      { id: 4, name: '3xc', number: 1, start_event: 1, stop_event: 19, chip_type: 'team', overrides: {} },
      {
        id: 5,
        name: 'wildcard',
        number: 2,
        start_event: 20,
        stop_event: 38,
        chip_type: 'transfer',
        overrides: {},
      },
      {
        id: 6,
        name: 'freehit',
        number: 2,
        start_event: 20,
        stop_event: 38,
        chip_type: 'transfer',
        overrides: {},
      },
      { id: 7, name: 'bboost', number: 2, start_event: 20, stop_event: 38, chip_type: 'team', overrides: {} },
      { id: 8, name: '3xc', number: 2, start_event: 20, stop_event: 38, chip_type: 'team', overrides: {} },
    ],
    events,
    game_settings: {
      league_join_private_max: 25,
      squad_squadplay: 11,
      squad_squadsize: 15,
      squad_team_limit: 3,
      squad_total_spend: BUDGET,
      transfers_cap: 5,
      transfers_sell_on_fee: 0.5,
      timezone: 'UTC',
    },
    phases: [
      { id: 1, name: 'Overall', start_event: 1, stop_event: 38, highest_score: null },
      { id: 2, name: 'August', start_event: 1, stop_event: 3, highest_score: null },
    ],
    teams: DEMO_CLUBS.map((c) => {
      const r = teamRecords.get(c.id) as { w: number; d: number; l: number; pts: number };
      return {
        code: c.code,
        draw: r.d,
        form: null,
        id: c.id,
        loss: r.l,
        name: c.name,
        played: r.w + r.d + r.l,
        points: r.pts,
        position: tablePosition.indexOf(c.id) + 1,
        short_name: c.shortName,
        strength: c.strength,
        team_division: null,
        unavailable: false,
        win: r.w,
        strength_overall_home: 1000 + c.strength * 70,
        strength_overall_away: 1000 + c.strength * 68,
        strength_attack_home: 1000 + c.strength * 72,
        strength_attack_away: 1000 + c.strength * 66,
        strength_defence_home: 1000 + c.strength * 71,
        strength_defence_away: 1000 + c.strength * 67,
        pulse_id: c.code,
      };
    }),
    total_players: TOTAL_PLAYERS,
    element_stats: [
      { label: 'Minutes played', name: 'minutes' },
      { label: 'Goals scored', name: 'goals_scored' },
      { label: 'Assists', name: 'assists' },
      { label: 'Clean sheets', name: 'clean_sheets' },
      { label: 'Bonus', name: 'bonus' },
      { label: 'Bonus Points System', name: 'bps' },
    ],
    element_types: [
      {
        id: 1,
        plural_name: 'Goalkeepers',
        plural_name_short: 'GKP',
        singular_name: 'Goalkeeper',
        singular_name_short: 'GKP',
        squad_select: 2,
        squad_min_play: 1,
        squad_max_play: 1,
        ui_shirt_specific: true,
        sub_positions_locked: [12],
        element_count: 0,
      },
      {
        id: 2,
        plural_name: 'Defenders',
        plural_name_short: 'DEF',
        singular_name: 'Defender',
        singular_name_short: 'DEF',
        squad_select: 5,
        squad_min_play: 3,
        squad_max_play: 5,
        ui_shirt_specific: false,
        sub_positions_locked: [],
        element_count: 0,
      },
      {
        id: 3,
        plural_name: 'Midfielders',
        plural_name_short: 'MID',
        singular_name: 'Midfielder',
        singular_name_short: 'MID',
        squad_select: 5,
        squad_min_play: 2,
        squad_max_play: 5,
        ui_shirt_specific: false,
        sub_positions_locked: [],
        element_count: 0,
      },
      {
        id: 4,
        plural_name: 'Forwards',
        plural_name_short: 'FWD',
        singular_name: 'Forward',
        singular_name_short: 'FWD',
        squad_select: 3,
        squad_min_play: 1,
        squad_max_play: 3,
        ui_shirt_specific: false,
        sub_positions_locked: [],
        element_count: 0,
      },
    ].map((t) => ({ ...t, element_count: players.filter((p) => ELEMENT_TYPE[p.position] === t.id).length })),
    elements: players.map((p) => {
      const s = seasonTotals(p.id);
      const gw = pointsByEvent.get(current)?.get(p.id)?.points ?? 0;
      const isRested = p.id === rested.id;
      const isInjured = p.id === injured.id;
      return {
        can_transact: true,
        can_select: true,
        chance_of_playing_next_round: isRested ? 75 : isInjured ? 0 : null,
        chance_of_playing_this_round: isRested ? 75 : isInjured ? 0 : null,
        code: p.code,
        cost_change_event: 0,
        cost_change_event_fall: 0,
        cost_change_start: 0,
        cost_change_start_fall: 0,
        dreamteam_count: 0,
        element_type: ELEMENT_TYPE[p.position],
        ep_next: formOf(p.id),
        ep_this: formOf(p.id),
        event_points: gw,
        first_name: p.firstName,
        form: formOf(p.id),
        id: p.id,
        in_dreamteam: false,
        news: isRested
          ? 'Knock - 75% chance of playing'
          : isInjured
            ? 'Hamstring injury - Expected back 22 Nov'
            : '',
        news_added: isRested || isInjured ? fplIso(anchor - 3 * DAY) : null,
        now_cost: p.price,
        photo: `${p.code}.jpg`,
        points_per_game: (s.total / Math.max(1, current)).toFixed(1),
        removed: false,
        second_name: p.secondName,
        selected_by_percent: (((ownership.get(p.id) ?? 0) / managers.length) * 100).toFixed(1),
        special: false,
        squad_number: null,
        status: isRested ? 'd' : isInjured ? 'i' : 'a',
        team: p.club.id,
        team_code: p.club.code,
        total_points: s.total,
        transfers_in: 0,
        transfers_in_event: 0,
        transfers_out: 0,
        transfers_out_event: 0,
        value_form: '0.0',
        value_season: (s.total / (p.price / 10)).toFixed(1),
        web_name: p.webName,
        region: null,
        team_join_date: null,
        birth_date: null,
        has_temporary_code: false,
        opta_code: `p${p.code}`,
        minutes: s.minutes,
        goals_scored: s.goals,
        assists: s.assists,
        clean_sheets: s.cs,
        bonus: s.bonus,
        bps: s.bps,
        starts: 0,
      };
    }),
  };

  // ----- entries, histories, standings -----
  const leagueRanks = (event: number) => {
    const sorted = [...managers].sort(
      (a, b) => (b.totals[event] ?? 0) - (a.totals[event] ?? 0) || a.entryId - b.entryId,
    );
    const rank = new Map<number, number>();
    sorted.forEach((m, i) => {
      const prev = sorted[i - 1];
      rank.set(
        m.entryId,
        prev && (prev.totals[event] ?? 0) === (m.totals[event] ?? 0)
          ? (rank.get(prev.entryId) as number)
          : i + 1,
      );
    });
    return { sorted, rank };
  };
  const nowRanks = leagueRanks(current);
  const lastRanks = leagueRanks(current - 1);

  const entries = new Map<number, Record<string, unknown>>();
  const histories = new Map<number, Record<string, unknown>>();
  managers.forEach((m, i) => {
    const [first, last, teamName] = DEMO_MANAGERS[i] as readonly [string, string, string];
    const h = m.history[current - 1] as Record<string, number>;
    entries.set(m.entryId, {
      id: m.entryId,
      joined_time: fplIso(deadlineOf(1) - (10 + (i % 20)) * DAY),
      started_event: 1,
      favourite_team: ((i * 7) % 20) + 1,
      player_first_name: first,
      player_last_name: last,
      player_region_id: 108,
      player_region_name: 'Israel',
      player_region_iso_code_short: 'IL',
      player_region_iso_code_long: 'ISR',
      years_active: 1 + (i % 9),
      summary_overall_points: m.totals[current] ?? 0,
      summary_overall_rank: h.overall_rank,
      summary_event_points: m.eventPoints[current] ?? 0,
      summary_event_rank: h.rank,
      current_event: current,
      leagues: {
        classic: [
          {
            id: DEMO_LEAGUE_ID,
            name: DEMO_LEAGUE_NAME,
            short_name: null,
            created: fplIso(deadlineOf(1) - 30 * DAY),
            closed: false,
            rank: null,
            max_entries: null,
            league_type: 'x',
            scoring: 'c',
            admin_entry: DEMO_FIRST_ENTRY_ID,
            start_event: 1,
            entry_can_leave: true,
            entry_can_admin: m.entryId === DEMO_FIRST_ENTRY_ID,
            entry_can_invite: false,
            has_cup: true,
            cup_league: null,
            cup_qualified: null,
            rank_count: managers.length,
            entry_percentile_rank: null,
            active_phases: [],
            entry_rank: nowRanks.rank.get(m.entryId),
            entry_last_rank: lastRanks.rank.get(m.entryId),
          },
        ],
        h2h: [],
        cup: {
          matches: [],
          status: {
            qualification_event: null,
            qualification_numbers: null,
            qualification_rank: null,
            qualification_state: null,
          },
          cup_league: null,
        },
        cup_matches: [],
      },
      name: teamName,
      name_change_blocked: false,
      entered_events: Array.from({ length: current }, (_, e) => e + 1),
      kit: null,
      last_deadline_bank: m.bank,
      last_deadline_value: (h.value as number) ?? 1000,
      last_deadline_total_transfers: m.history.reduce(
        (s, x) => s + ((x as Record<string, number>).event_transfers ?? 0),
        0,
      ),
      club_badge_src: null,
    });
    histories.set(m.entryId, {
      current: m.history,
      past: [
        { season_name: '2023/24', total_points: 2100 + ((i * 37) % 400), rank: 400_000 + i * 21_000 },
        { season_name: '2024/25', total_points: 2150 + ((i * 53) % 380), rank: 300_000 + i * 17_000 },
      ],
      chips: m.chips,
    });
  });

  const PAGE = 50;
  const lastUpdated = fplIso(anchor - 10 * MINUTE);
  const rows = nowRanks.sorted.map((m, i) => {
    const idx = managers.indexOf(m);
    const [first, last, teamName] = DEMO_MANAGERS[idx] as readonly [string, string, string];
    const h = m.history[current - 1] as Record<string, number>;
    return {
      id: 70_000_000 + idx,
      event_total: (m.eventPoints[current] ?? 0) - (h.event_transfers_cost ?? 0),
      player_name: `${first} ${last}`,
      rank: nowRanks.rank.get(m.entryId) as number,
      last_rank: lastRanks.rank.get(m.entryId) as number,
      rank_sort: i + 1,
      total: m.totals[current] ?? 0,
      entry: m.entryId,
      entry_name: teamName,
      has_played: true,
    };
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const standingsPages = Array.from({ length: pageCount }, (_, p) => ({
    new_entries: { has_next: false, page: 1, results: [] },
    last_updated_data: lastUpdated,
    league: {
      id: DEMO_LEAGUE_ID,
      name: DEMO_LEAGUE_NAME,
      created: fplIso(deadlineOf(1) - 30 * DAY),
      closed: false,
      max_entries: null,
      league_type: 'x',
      scoring: 'c',
      admin_entry: DEMO_FIRST_ENTRY_ID,
      start_event: 1,
      code_privacy: 'p',
      has_cup: true,
      cup_league: null,
      rank: null,
    },
    standings: { has_next: p < pageCount - 1, page: p + 1, results: rows.slice(p * PAGE, (p + 1) * PAGE) },
  }));

  return {
    anchorMs: anchor,
    currentEvent: current,
    leagueId: DEMO_LEAGUE_ID,
    entryIds,
    restedPlayerId: rested.id,
    bootstrap,
    fixtures: fixturesJson,
    live,
    entries,
    histories,
    picks: picksMap,
    standingsPages,
  };
}

// ---------- squads ----------

const NEED: Readonly<Record<DemoPosition, number>> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

function buildSquad(rng: Rng, pool: readonly DemoPlayer[], forced: readonly DemoPlayer[]): DemoPlayer[] {
  for (let attempt = 0; attempt < 60; attempt++) {
    const squad = [...forced];
    const perClub = new Map<number, number>();
    for (const p of squad) perClub.set(p.club.id, (perClub.get(p.club.id) ?? 0) + 1);
    const damp = attempt / 20; // later attempts favour cheaper players
    for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
      while (squad.filter((p) => p.position === pos).length < NEED[pos]) {
        const options = pool.filter(
          (p) => p.position === pos && !squad.includes(p) && (perClub.get(p.club.id) ?? 0) < 3,
        );
        const pick = weightedPick(rng, options, (p) =>
          pos === 'GKP' && p.clubIndex > 0 && squad.every((s) => s.position !== 'GKP')
            ? 0.2
            : Math.pow(Math.max(1, p.price - 38), 2 - damp),
        );
        if (!pick) break;
        squad.push(pick);
        perClub.set(pick.club.id, (perClub.get(pick.club.id) ?? 0) + 1);
      }
    }
    const complete = (Object.keys(NEED) as DemoPosition[]).every(
      (pos) => squad.filter((p) => p.position === pos).length === NEED[pos],
    );
    if (complete && squad.reduce((s, p) => s + p.price, 0) <= BUDGET) return squad;
  }
  // Fallback (never hit with the default seed): cheapest valid squad.
  const squad = [...forced];
  const perClub = new Map<number, number>();
  for (const p of squad) perClub.set(p.club.id, (perClub.get(p.club.id) ?? 0) + 1);
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
    const options = pool
      .filter((p) => p.position === pos && !squad.includes(p))
      .sort((a, b) => a.price - b.price);
    for (const p of options) {
      if (squad.filter((s) => s.position === pos).length >= NEED[pos]) break;
      if ((perClub.get(p.club.id) ?? 0) >= 3) continue;
      squad.push(p);
      perClub.set(p.club.id, (perClub.get(p.club.id) ?? 0) + 1);
    }
  }
  return squad;
}

function arrangeSlots(
  squad: readonly DemoPlayer[],
  [def, mid, fwd]: readonly [number, number, number],
  forced: readonly DemoPlayer[],
): DemoPlayer[] {
  const rank = (a: DemoPlayer, b: DemoPlayer) =>
    Number(forced.includes(b)) - Number(forced.includes(a)) || b.price - a.price || a.id - b.id;
  const of = (pos: DemoPosition) => squad.filter((p) => p.position === pos).sort(rank);
  const gks = of('GKP');
  const defs = of('DEF');
  const mids = of('MID');
  const fwds = of('FWD');
  // Prefer a club's first-choice keeper as the starter.
  gks.sort((a, b) => a.clubIndex - b.clubIndex || b.price - a.price);
  const xi = [gks[0], ...defs.slice(0, def), ...mids.slice(0, mid), ...fwds.slice(0, fwd)] as DemoPlayer[];
  const benchOutfield = [...defs.slice(def), ...mids.slice(mid), ...fwds.slice(fwd)].sort(
    (a, b) => b.price - a.price || a.id - b.id,
  );
  return [...xi, gks[1] as DemoPlayer, ...benchOutfield];
}
