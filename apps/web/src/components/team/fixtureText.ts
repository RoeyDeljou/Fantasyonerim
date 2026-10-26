import type { Fixture, FplTeamId, LivePick, PlTeam, Pick } from '@fant/shared';
import { fmt } from '@/i18n';
import type { Formatters, Messages } from '@/i18n';

/** "ARS (H)" — or "ARS (H), CHE (A)" in a double gameweek; null in a blank one. */
export function opponentText(
  teamId: FplTeamId,
  fixtures: readonly Fixture[] | undefined,
  teams: Map<FplTeamId, PlTeam>,
  t: Messages,
): string | null {
  if (!fixtures) return null;
  const mine = fixtures.filter((fx) => fx.teamH === teamId || fx.teamA === teamId);
  if (mine.length === 0) return null;
  return mine
    .map((fx) => {
      const home = fx.teamH === teamId;
      const opp = teams.get(home ? fx.teamA : fx.teamH);
      return `${opp?.shortName ?? '?'} ${home ? t.player.home : t.player.away}`;
    })
    .join(', ');
}

export function isLivePick(p: Pick | LivePick): p is LivePick {
  return 'basePoints' in p;
}

/** The fixture(s) a club plays in the loaded GW. */
export function teamFixtures(teamId: FplTeamId | undefined, fixtures: readonly Fixture[] | undefined): Fixture[] {
  if (teamId === undefined || !fixtures) return [];
  return fixtures.filter((fx) => fx.teamH === teamId || fx.teamA === teamId);
}

/**
 * Status of a player's match — the MATCH clock ("67'"), "FT", or the kickoff time. The player's own minutes
 * are shown separately ("61 min played") so they are never mistaken for the clock.
 */
export function fixtureStatusText(
  p: { fixtureStatus: LivePick['fixtureStatus'] },
  t: Messages,
  f: Formatters,
  teamId?: FplTeamId,
  fixtures?: readonly Fixture[],
): string {
  const mine = teamFixtures(teamId, fixtures);
  switch (p.fixtureStatus) {
    case 'live': {
      const fx = mine.find((x) => x.status === 'live');
      return fx ? fmt(t.live.minutes, { n: fx.minutes }) : t.live.live;
    }
    case 'finished':
      return t.live.ft;
    case 'not_started': {
      const next = mine.find((x) => x.status === 'not_started' && x.kickoffTime);
      return next?.kickoffTime ? f.dayTime(next.kickoffTime) : t.live.notStarted;
    }
    case 'no_fixture':
      return t.live.noFixture;
  }
}

export function fixtureScoreText(fx: Fixture, t: Messages, f: Formatters): string {
  switch (fx.status) {
    case 'live':
      return fmt(t.live.minutes, { n: fx.minutes });
    case 'finished':
      return t.live.ft;
    case 'finished_provisional':
      return t.live.ftProv;
    case 'not_started':
      return fx.kickoffTime ? f.dayTime(fx.kickoffTime) : '—';
  }
}
