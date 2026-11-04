/**
 * League config map: the client's FPL classic league and how fans join it. Ids and codes live here, never at a
 * call site (docs/CLIENT_ACCOUNTS.md).
 */

/** The podcast's league (Fantasyonerim, FPL classic league 4611). */
export const CLIENT_LEAGUE_ID = 4611;

/**
 * Invite codes used when the admin hasn't stored one, by league id (client-confirmed). The stored value always
 * wins; clearing it in the admin console falls back to this default again (same as the socials defaults).
 */
export const DEFAULT_LEAGUE_CODES: Readonly<Record<number, string>> = {
  [CLIENT_LEAGUE_ID]: 'KJJGKB',
};
export const DEFAULT_LEAGUE_CODE = DEFAULT_LEAGUE_CODES[CLIENT_LEAGUE_ID];

/** FPL's official invite link: opens the FPL app/site and asks to join the league. */
export const FPL_LEAGUE_JOIN_URL_TEMPLATE = 'https://fantasy.premierleague.com/leagues/auto-join/{code}';

export function leagueJoinUrl(code: string): string {
  return FPL_LEAGUE_JOIN_URL_TEMPLATE.replace('{code}', encodeURIComponent(code));
}

/** Codes are case-insensitive on FPL; stored and shown upper case. */
export function normalizeLeagueCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The code in effect: the stored one, else the configured default for this league, else null. */
export function effectiveLeagueCode(leagueId: number | null, stored: string | null): string | null {
  if (stored !== null && stored !== '') return stored;
  if (leagueId === null) return null;
  return DEFAULT_LEAGUE_CODES[leagueId] ?? null;
}
