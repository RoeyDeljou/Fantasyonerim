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

/** Human status of a player's fixture: "67'", "FT", "Not started"… */
export function fixtureStatusText(p: LivePick, t: Messages): string {
  switch (p.fixtureStatus) {
    case 'live':
      return fmt(t.live.minutes, { n: p.minutes });
    case 'finished':
      return t.live.ft;
    case 'not_started':
      return t.live.notStarted;
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
