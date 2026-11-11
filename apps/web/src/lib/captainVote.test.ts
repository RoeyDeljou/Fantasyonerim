import { describe, expect, it } from 'vitest';
import { FixtureSchema, FplPlayerIdSchema, PlayerSchema } from '@fant/shared';
import type { Fixture, Player } from '@fant/shared';
import {
  availabilityFlag,
  buildSearchIndex,
  needsResultPoll,
  normalizeName,
  opponentText,
  opponentsOf,
  permanentPickForSave,
  searchPlayers,
  timeLeft,
  voteMode,
} from './captainVote';
import type { VoteModeInput } from './captainVote';

let seq = 0;
function player(webName: string, firstName: string, secondName: string, extra: Partial<Player> = {}): Player {
  seq++;
  return PlayerSchema.parse({
    id: seq,
    webName,
    firstName,
    secondName,
    teamId: 1,
    position: 'MID',
    nowCost: 80,
    photoCode: `${seq}`,
    status: 'a',
    news: '',
    chanceOfPlayingNextRound: null,
    selectedByPercent: 5,
    totalPoints: 50,
    eventPoints: 0,
    form: 3,
    ...extra,
  });
}

const PLAYERS = [
  player('Salah', 'Mohamed', 'Salah', { totalPoints: 200, selectedByPercent: 40 }),
  player('Ødegaard', 'Martin', 'Ødegaard', { totalPoints: 90 }),
  player('Gross', 'Pascal', 'Groß', { totalPoints: 70 }),
  player('Muharemović', 'Tarik', 'Muharemović'),
  player('M.Salah', 'Moustafa', 'Salah-Ahmed', { totalPoints: 10 }),
  player('Haaland', 'Erling', 'Haaland', { totalPoints: 250, selectedByPercent: 60 }),
  player('Mo', 'Salah', 'Mo', { totalPoints: 5 }),
  player('Gordon', 'Anthony', 'Gordon', { totalPoints: 120 }),
  player('Isak', 'Alexander', 'Isak', { totalPoints: 100 }),
];
const index = buildSearchIndex(PLAYERS);
const names = (q: string, limit?: number) => searchPlayers(index, q, limit).map((p) => p.webName);

describe('normalizeName', () => {
  it('drops accents, case and the letters Unicode does not decompose', () => {
    expect(normalizeName('Ødegaard')).toBe('odegaard');
    expect(normalizeName('Groß')).toBe('gross');
    expect(normalizeName('Muharemović')).toBe('muharemovic');
    expect(normalizeName("N'Golo  Kanté")).toBe('ngolo kante');
    expect(normalizeName('Salah-Ahmed')).toBe('salah ahmed');
  });
});

describe('searchPlayers', () => {
  it('finds accented names from plain letters, in any case', () => {
    expect(names('odegaard')).toEqual(['Ødegaard']);
    expect(names('ØDEGAARD')).toEqual(['Ødegaard']);
    expect(names('muharemovic')).toEqual(['Muharemović']);
    expect(names('gross')).toEqual(['Gross']);
    expect(names('groß')).toEqual(['Gross']);
  });
  it('matches the first and second name too', () => {
    expect(names('erling')).toEqual(['Haaland']);
    expect(names('pascal')).toEqual(['Gross']);
    expect(names('tarik muh')).toEqual(['Muharemović']);
  });
  it('ranks names that start with the text above names that contain it, then by points', () => {
    // "sal": Salah's web name starts with it; M.Salah / Mo only have a first or second name that does (by points).
    expect(names('sal')).toEqual(['Salah', 'M.Salah', 'Mo']);
    // "aa" only appears inside a name: still found.
    expect(names('aa')).toEqual(['Haaland', 'Ødegaard']);
    // A prefix hit beats a higher-scoring contains hit.
    const mixed = buildSearchIndex([
      player('Bamford', 'Patrick', 'Bamford', { totalPoints: 300 }),
      player('Amad', 'Amad', 'Diallo', { totalPoints: 1 }),
    ]);
    expect(searchPlayers(mixed, 'am').map((p) => p.webName)).toEqual(['Amad', 'Bamford']);
  });
  it('breaks ties by total points', () => {
    const r = names('o'); // Ødegaard / Gordon / Mo start with o? Only Ødegaard; the rest contain it
    expect(r[0]).toBe('Ødegaard');
    expect(r.slice(1)).toEqual([...r.slice(1)].sort((a, b) => points(b) - points(a)));
  });
  it('limits the list and lists the most-owned players for an empty query', () => {
    expect(searchPlayers(index, 'a', 3)).toHaveLength(3);
    expect(names('', 2)).toEqual(['Haaland', 'Salah']);
    expect(names('   ', 1)).toEqual(['Haaland']);
  });
  it('returns nothing when nothing matches', () => {
    expect(names('zzzz')).toEqual([]);
  });
});
function points(webName: string): number {
  return PLAYERS.find((p) => p.webName === webName)?.totalPoints ?? 0;
}

const labels = { vs: 'מול {team} ({venue})', home: 'בית', away: 'חוץ', none: 'אין משחק במחזור' };
const TEAM = (id: number) => ({ 1: 'LIV', 2: 'ARS', 3: 'MCI' })[id] ?? '?';
function fx(id: number, h: number, a: number, kickoff: string, event = 12): Fixture {
  return FixtureSchema.parse({
    id,
    event,
    kickoffTime: kickoff,
    teamH: h,
    teamA: a,
    teamHScore: null,
    teamAScore: null,
    minutes: 0,
    status: 'not_started',
  });
}

describe('opponentText', () => {
  const fixtures = [
    fx(1, 1, 2, '2026-11-21T15:00:00Z'),
    fx(2, 3, 4, '2026-11-21T17:30:00Z'),
    fx(3, 5, 1, '2026-11-24T19:30:00Z'),
  ];
  const text = (teamId: number) =>
    opponentText(opponentsOf(teamId as never, fixtures), (id) => TEAM(id), labels);
  it('home and away', () => {
    expect(text(2)).toBe('מול LIV (חוץ)');
    expect(text(3)).toBe('מול ? (בית)');
  });
  it('a double gameweek lists both fixtures in kick-off order', () => {
    expect(text(1)).toBe('מול ARS (בית) · מול ? (חוץ)');
  });
  it('no fixture', () => {
    expect(text(9)).toBe('אין משחק במחזור');
    expect(opponentText([], TEAM, labels)).toBe('אין משחק במחזור');
    expect(opponentText(opponentsOf(1 as never, undefined), TEAM, labels)).toBe('אין משחק במחזור');
  });
  it('ignores fixtures of other gameweeks when an event is given', () => {
    expect(opponentsOf(1 as never, fixtures, 13)).toEqual([]);
    expect(opponentsOf(1 as never, fixtures, 12)).toHaveLength(2);
  });
});

describe('voteMode', () => {
  const pid = (n: number) => FplPlayerIdSchema.parse(n);
  interface Over {
    state?: Partial<VoteModeInput['state']>;
    guest?: boolean;
    banned?: boolean;
    draft?: VoteModeInput['draft'];
    changing?: boolean;
  }
  const base = (over: Over = {}): VoteModeInput => ({
    state: { event: 12 as never, status: 'open', myPick: null, ...over.state },
    guest: over.guest ?? false,
    banned: over.banned ?? false,
    draft: over.draft ?? null,
    changing: over.changing ?? false,
  });
  it('the server status decides before anything local', () => {
    expect(voteMode(base({ state: { status: 'not_open' }, draft: pid(1) }))).toBe('not_open');
    expect(
      voteMode(base({ state: { status: 'locked', myPick: pid(1) }, draft: pid(2), changing: true })),
    ).toBe('locked');
    expect(voteMode(base({ state: { event: null } }))).toBe('no_event');
  });
  it('guests and suspended accounts never get the picker', () => {
    expect(voteMode(base({ guest: true }))).toBe('guest');
    expect(voteMode(base({ banned: true, draft: pid(3) }))).toBe('banned');
  });
  it('search → draft → confirmed → change → search', () => {
    expect(voteMode(base())).toBe('search');
    expect(voteMode(base({ draft: pid(7) }))).toBe('draft');
    expect(voteMode(base({ state: { myPick: pid(7) } }))).toBe('confirmed');
    expect(voteMode(base({ state: { myPick: pid(7) }, changing: true }))).toBe('search');
    expect(voteMode(base({ state: { myPick: pid(7) }, changing: true, draft: pid(8) }))).toBe('draft');
  });
  it('a draft equal to the confirmed pick is just the confirmed pick', () => {
    expect(voteMode(base({ state: { myPick: pid(7) }, draft: pid(7) }))).toBe('confirmed');
  });
});

describe('needsResultPoll', () => {
  const result = (status: string) => ({ status }) as never;
  it('only a locked vote without a tally yet', () => {
    expect(needsResultPoll({ status: 'locked', result: null })).toBe(true);
    expect(needsResultPoll({ status: 'locked', result: result('pending') })).toBe(true);
    expect(needsResultPoll({ status: 'locked', result: result('decided') })).toBe(false);
    expect(needsResultPoll({ status: 'locked', result: result('tied') })).toBe(false);
    expect(needsResultPoll({ status: 'open', result: null })).toBe(false);
    expect(needsResultPoll(undefined)).toBe(false);
  });
});

describe('timeLeft', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  it('picks the coarsest useful unit', () => {
    expect(timeLeft('2026-11-24T12:00:00Z', now)).toEqual({ unit: 'days', n: 4 });
    expect(timeLeft('2026-11-21T18:00:00Z', now)).toEqual({ unit: 'hours', n: 30 });
    expect(timeLeft('2026-11-20T12:30:00Z', now)).toEqual({ unit: 'minutes', n: 30 });
    expect(timeLeft('2026-11-20T12:00:20Z', now)).toEqual({ unit: 'minutes', n: 1 });
  });
  it('null once the deadline has passed', () => {
    expect(timeLeft('2026-11-20T12:00:00Z', now)).toBeNull();
    expect(timeLeft('2026-11-19T12:00:00Z', now)).toBeNull();
  });
});

describe('availabilityFlag', () => {
  it('flags only players who may not play', () => {
    expect(availabilityFlag({ status: 'a' })).toBeNull();
    expect(availabilityFlag({ status: 'd' })).toBe('doubtful');
    expect(availabilityFlag({ status: 'i' })).toBe('injured');
    expect(availabilityFlag({ status: 's' })).toBe('suspended');
    expect(availabilityFlag({ status: 'u' })).toBe('unavailable');
  });
});

describe('permanentPickForSave', () => {
  it('keeps everything while the GW is the loaded one (also mid-typing back to it)', () => {
    expect(permanentPickForSave(5, false, 12, 12)).toBe(5);
  });
  it('drops an untouched carried-over pick for another GW', () => {
    expect(permanentPickForSave(5, false, 13, 12)).toBeNull();
  });
  it('keeps a pick chosen in this session whatever the GW does afterwards', () => {
    expect(permanentPickForSave(5, true, 13, 12)).toBe(5);
    expect(permanentPickForSave(5, true, 14, 12)).toBe(5);
  });
  it('no saved config (first load) or an empty GW field: unaffected', () => {
    expect(permanentPickForSave(5, false, 13, null)).toBe(5);
    expect(permanentPickForSave(5, false, null, 12)).toBe(5);
    expect(permanentPickForSave(null, false, 13, 12)).toBeNull();
  });
});
