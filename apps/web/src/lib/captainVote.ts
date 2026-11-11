import type { CommunityCaptainState, FplPlayerId, Player, PlTeam } from '@fant/shared';
import type { Fixture } from '@fant/shared';

/**
 * Pure helpers of the "My Community Captain" vote (screens/CaptainVote.tsx, admin/CommunityCaptainCard.tsx): the
 * accent-insensitive player search, the "against whom" text and the state machine that maps the server state plus the
 * fan's local draft to what the screen shows. No React here, so they are unit-tested directly (captainVote.test.ts).
 */

// ---------- player search ----------

/** Letters Unicode normalization doesn't decompose (Ø, ß, Đ, Ł, Æ…): mapped by hand so "odegaard" finds Ødegaard. */
const SPECIAL: Record<string, string> = {
  ø: 'o',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  þ: 'th',
};

/** Lower-case, accent-free form of a name: "Groß" and "gross", "Ødegaard" and "odegaard" compare equal. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[øßđðłæœıþ]/g, (c) => SPECIAL[c] ?? c)
    .replace(/[\u2019'`]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchEntry {
  player: Player;
  web: string;
  first: string;
  second: string;
  full: string;
  words: string[];
}

/** Normalizes every player once (≈ 800), so each keystroke only compares strings. */
export function buildSearchIndex(players: readonly Player[]): SearchEntry[] {
  return players.map((player) => {
    const web = normalizeName(player.webName);
    const first = normalizeName(player.firstName);
    const second = normalizeName(player.secondName);
    const full = `${first} ${second}`.trim();
    return { player, web, first, second, full, words: [...new Set(`${web} ${full}`.split(' '))] };
  });
}

/** 0 = the web name starts with the query … 3 = it appears somewhere inside a name; null = no match. */
function matchTier(e: SearchEntry, needle: string, tokens: readonly string[]): number | null {
  const hay = `${e.web} ${e.full}`;
  if (!tokens.every((tok) => hay.includes(tok))) return null;
  if (e.web.startsWith(needle)) return 0;
  if (e.first.startsWith(needle) || e.second.startsWith(needle) || e.full.startsWith(needle)) return 1;
  if (tokens.every((tok) => e.words.some((w) => w.startsWith(tok)))) return 2;
  return 3;
}

export const SEARCH_LIMIT = 8;

/**
 * The completion list: accent- and case-insensitive over web name, first name and second name; names that START with
 * the typed text rank above ones that merely contain it, then by total points, then by ownership. An empty query lists
 * the most-owned players (what most fans want to pick from).
 */
export function searchPlayers(index: readonly SearchEntry[], query: string, limit = SEARCH_LIMIT): Player[] {
  const needle = normalizeName(query);
  const byPopularity = (a: Player, b: Player) =>
    b.totalPoints - a.totalPoints ||
    b.selectedByPercent - a.selectedByPercent ||
    a.webName.localeCompare(b.webName);
  if (!needle) {
    return index
      .map((e) => e.player)
      .sort((a, b) => b.selectedByPercent - a.selectedByPercent || byPopularity(a, b))
      .slice(0, limit);
  }
  const tokens = needle.split(' ');
  const hits: Array<{ player: Player; tier: number }> = [];
  for (const e of index) {
    const tier = matchTier(e, needle, tokens);
    if (tier !== null) hits.push({ player: e.player, tier });
  }
  hits.sort((a, b) => a.tier - b.tier || byPopularity(a.player, b.player));
  return hits.slice(0, limit).map((h) => h.player);
}

// ---------- opponents ----------

export interface Opponent {
  teamId: PlTeam['id'];
  home: boolean;
}

/** The player's club's fixtures in the given list, in kick-off order (two entries = a double gameweek). */
export function opponentsOf(
  teamId: PlTeam['id'],
  fixtures: readonly Fixture[] | undefined,
  event?: number | null,
): Opponent[] {
  return [...(fixtures ?? [])]
    .filter((f) => (f.teamH === teamId || f.teamA === teamId) && (event == null || f.event === event))
    .sort((a, b) => Date.parse(a.kickoffTime ?? '') - Date.parse(b.kickoffTime ?? '') || a.id - b.id)
    .map((f) => (f.teamH === teamId ? { teamId: f.teamA, home: true } : { teamId: f.teamH, home: false }));
}

export interface OpponentLabels {
  /** "vs {team} ({venue})" */
  vs: string;
  home: string;
  away: string;
  /** No fixture that gameweek. */
  none: string;
}

/** "מול ARS (בית)"; a double gameweek lists both ("מול ARS (בית) · מול MCI (חוץ)"); none → the "no game" text. */
export function opponentText(
  opponents: readonly Opponent[],
  teamName: (id: PlTeam['id']) => string,
  labels: OpponentLabels,
): string {
  if (opponents.length === 0) return labels.none;
  return opponents
    .map((o) =>
      labels.vs.replace('{team}', teamName(o.teamId)).replace('{venue}', o.home ? labels.home : labels.away),
    )
    .join(' · ');
}

// ---------- screen mode ----------

export type VoteMode =
  /** No gameweek ahead (season over). */
  | 'no_event'
  | 'not_open'
  | 'locked'
  /** Open, but the viewer has no account: sees the state and the sign-up prompt. */
  | 'guest'
  /** Open, but the account can't take part (suspended from posting). */
  | 'banned'
  /** Open and no pick yet, or the viewer pressed "Change pick": the search field. */
  | 'search'
  /** A player was chosen but not confirmed yet: "Your pick" card with Confirm / Change pick. */
  | 'draft'
  /** The confirmed pick: "Your pick" card with the badge and Change pick. */
  | 'confirmed';

export interface VoteModeInput {
  state: Pick<CommunityCaptainState, 'event' | 'status' | 'myPick'>;
  guest: boolean;
  banned: boolean;
  /** The player chosen in the search and not confirmed yet. */
  draft: FplPlayerId | null;
  /** The viewer pressed "Change pick" on a confirmed pick. */
  changing: boolean;
}

/** Which of the screen's views to show. The server's status always wins over local state. */
export function voteMode(i: VoteModeInput): VoteMode {
  const { state } = i;
  if (state.event === null) return 'no_event';
  if (state.status === 'not_open') return 'not_open';
  if (state.status === 'locked') return 'locked';
  if (i.guest) return 'guest';
  if (i.banned) return 'banned';
  if (i.draft !== null && i.draft !== state.myPick) return 'draft';
  if (state.myPick === null || i.changing) return 'search';
  return 'confirmed';
}

/** Re-check the state about every 30 s while the server hasn't tallied a locked vote yet. */
export const RESULT_POLL_MS = 30_000;

export function needsResultPoll(state: Pick<CommunityCaptainState, 'status' | 'result'> | undefined): boolean {
  return state?.status === 'locked' && (state.result === null || state.result.status === 'pending');
}

// ---------- time left ----------

export type TimeLeft = { unit: 'days' | 'hours' | 'minutes'; n: number } | null;

/** The coarse "time left" shown next to the deadline; null once it has passed. */
export function timeLeft(deadlineIso: string, now: number): TimeLeft {
  const ms = Date.parse(deadlineIso) - now;
  if (!(ms > 0)) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes >= 48 * 60) return { unit: 'days', n: Math.floor(minutes / (24 * 60)) };
  if (minutes >= 60) return { unit: 'hours', n: Math.floor(minutes / 60) };
  return { unit: 'minutes', n: Math.max(1, minutes) };
}

/** FPL availability flag worth showing next to a pick (null = fit). */
export function availabilityFlag(p: Pick<Player, 'status'>): 'doubtful' | 'injured' | 'suspended' | 'unavailable' | null {
  switch (p.status) {
    case 'd':
      return 'doubtful';
    case 'i':
      return 'injured';
    case 's':
      return 'suspended';
    case 'u':
    case 'n':
      return 'unavailable';
    default:
      return null;
  }
}
