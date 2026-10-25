import {
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  FplEntryIdSchema,
  FplLeagueIdSchema,
  GameweekSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  PlayerLiveSchema,
} from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { nextDeadline } from '../deadline.js';
import { FplNotFoundError } from '../service.js';
import { buildDemoDataset, createDemoFplService, DEMO_ENTRIES, DEMO_LEAGUE_ID } from './index.js';

const NOW = Date.UTC(2026, 9, 25, 15, 30);
const gw9 = GameweekSchema.parse(9);
const gw8 = GameweekSchema.parse(8);
const leagueId = FplLeagueIdSchema.parse(DEMO_LEAGUE_ID);
const id = (n: number) => FplEntryIdSchema.parse(n);

describe('demo dataset (smoke)', () => {
  const service = createDemoFplService({ now: () => NOW });
  const data = buildDemoDataset({ anchorMs: NOW });

  it('is deterministic for a given anchor', () => {
    const again = buildDemoDataset({ anchorMs: NOW });
    expect(JSON.stringify(again.bootstrap)).toBe(JSON.stringify(data.bootstrap));
    expect(JSON.stringify([...again.picks])).toBe(JSON.stringify([...data.picks]));
  });

  it('bootstrap: 20 clubs, a real player pool, 38 GWs with GW9 current', async () => {
    const b = BootstrapSchema.parse(await service.getBootstrap());
    expect(b.teams).toHaveLength(20);
    expect(b.teams.map((t) => t.shortName)).toContain('SUN');
    expect(b.players.length).toBeGreaterThanOrEqual(160);
    for (const t of b.teams)
      expect(b.players.filter((p) => p.teamId === t.id).length).toBeGreaterThanOrEqual(8);
    expect(b.events).toHaveLength(38);
    expect(b.currentEvent).toBe(9);
    expect(b.nextEvent).toBe(10);
    expect(nextDeadline(b.events, NOW)?.event).toBe(10);
    expect(b.events.filter((e) => e.finished)).toHaveLength(8);
  });

  it('GW9 fixtures: finished, provisional (with and without bonus), live, not started', async () => {
    const fixtures = await service.getFixtures(gw9);
    for (const f of fixtures) FixtureSchema.parse(f);
    const count = (s: string) => fixtures.filter((f) => f.status === s).length;
    expect([count('finished'), count('finished_provisional'), count('live'), count('not_started')]).toEqual([
      4, 2, 1, 3,
    ]);
    const live = fixtures.find((f) => f.status === 'live');
    expect(live?.minutes).toBe(62);
    expect(Date.parse(live?.kickoffTime ?? '')).toBeLessThan(NOW);
    expect(Date.parse(fixtures.find((f) => f.status === 'not_started')?.kickoffTime ?? '')).toBeGreaterThan(
      NOW,
    );
    expect((await service.getFixtures()).length).toBe(380);
  });

  it('every squad is a legal FPL squad', () => {
    const b = data.bootstrap as {
      elements: { id: number; team: number; element_type: number; now_cost: number }[];
    };
    const byId = new Map(b.elements.map((e) => [e.id, e]));
    expect(data.entryIds).toHaveLength(60);
    for (const entryId of data.entryIds) {
      const picks = data.picks.get(`${entryId}:9`);
      expect(picks?.picks).toHaveLength(15);
      const els = (picks?.picks ?? []).map((p) => byId.get(p.element));
      const types = [1, 2, 3, 4].map((t) => els.filter((e) => e?.element_type === t).length);
      expect(types).toEqual([2, 5, 5, 3]);
      const perClub = new Map<number, number>();
      for (const e of els) perClub.set(e?.team ?? 0, (perClub.get(e?.team ?? 0) ?? 0) + 1);
      expect(Math.max(...perClub.values())).toBeLessThanOrEqual(3);
      expect(els.reduce((s, e) => s + (e?.now_cost ?? 0), 0)).toBeLessThanOrEqual(1000);
      expect(picks?.picks.filter((p) => p.is_captain)).toHaveLength(1);
      expect(picks?.picks.filter((p) => p.is_vice_captain)).toHaveLength(1);
    }
  });

  it('chips and hits are present in GW9', async () => {
    const chips = await Promise.all(data.entryIds.map((e) => service.getEntryPicks(id(e), gw9)));
    for (const p of chips) EntryPicksSchema.parse(p);
    const active = chips.map((p) => p.activeChip);
    for (const chip of ['3xc', 'bboost', 'freehit', 'wildcard'] as const) expect(active).toContain(chip);
    expect(chips.some((p) => p.transfersCost > 0)).toBe(true);
    expect((await service.getEntryPicks(id(DEMO_ENTRIES.transferHit), gw9)).transfersCost).toBe(4);
    expect((await service.getEntryPicks(id(DEMO_ENTRIES.tripleCaptain), gw9)).activeChip).toBe('3xc');
  });

  it('entry live parses for every manager; the documented demo entries behave', async () => {
    for (const e of data.entryIds) EntryLiveSchema.parse(await service.getEntryLive(id(e), gw9));

    const vice = await service.getEntryLive(id(DEMO_ENTRIES.viceCaptain), gw9);
    const captain = vice.picks.find((p) => p.isCaptain);
    expect(captain).toMatchObject({
      minutes: 0,
      effectiveMultiplier: 0,
      autoSubOut: true,
      fixtureStatus: 'finished',
    });
    expect(vice.picks.find((p) => p.isViceCaptain)?.effectiveMultiplier).toBe(2);
    expect(vice.picks.some((p) => p.autoSubIn)).toBe(true);

    const tc = await service.getEntryLive(id(DEMO_ENTRIES.tripleCaptain), gw9);
    expect(tc.picks.some((p) => p.effectiveMultiplier === 3)).toBe(true);

    const bb = await service.getEntryLive(id(DEMO_ENTRIES.benchBoost), gw9);
    expect(bb.picks.filter((p) => p.effectiveMultiplier > 0)).toHaveLength(15);

    const all = await Promise.all(data.entryIds.map((e) => service.getEntryLive(id(e), gw9)));
    expect(all.some((l) => l.picks.some((p) => p.provisionalBonus > 0))).toBe(true);
    expect(all.some((l) => l.playersYetToPlay > 0)).toBe(true);
  });

  it('a finished GW re-scores to exactly FPL’s official total', async () => {
    for (const e of data.entryIds.slice(0, 20)) {
      const live = await service.getEntryLive(id(e), gw8);
      const official = (
        data.histories.get(e) as { current: { event: number; total_points: number }[] }
      ).current.find((h) => h.event === 8);
      expect(live.liveTotal).toBe(official?.total_points);
    }
  });

  it('league standings: 2 pages (50 + 10), live league page parses', async () => {
    const p1 = LeagueStandingsSchema.parse(await service.getLeagueStandings(leagueId, 1));
    const p2 = LeagueStandingsSchema.parse(await service.getLeagueStandings(leagueId, 2));
    const p3 = await service.getLeagueStandings(leagueId, 3);
    expect(p1.league.name).toBe('Fantasyonerim League');
    expect([p1.rows.length, p1.hasNext, p2.rows.length, p2.hasNext, p3.rows.length]).toEqual([
      50,
      true,
      10,
      false,
      0,
    ]);

    const ll = LiveLeagueSchema.parse(await service.getLiveLeague(leagueId, gw9, 1));
    expect(ll.rows).toHaveLength(50);
    expect(ll.rows.map((r) => r.liveTotal)).toEqual(
      [...ll.rows.map((r) => r.liveTotal)].sort((a, b) => b - a),
    );
    const ll2 = await service.getLiveLeague(leagueId, gw9, 2);
    expect(ll2.rows[0]?.liveRank).toBeGreaterThanOrEqual(51);
  });

  it('entries, players live and unknown ids', async () => {
    const e = EntrySummarySchema.parse(await service.getEntry(id(DEMO_ENTRIES.normal)));
    expect(e).toMatchObject({ teamName: 'Fantasyonerim HQ', managerName: 'Dor Cohen', currentEvent: 9 });
    await expect(service.getEntry(id(1234))).rejects.toBeInstanceOf(FplNotFoundError);
    await expect(service.getLeagueStandings(FplLeagueIdSchema.parse(1), 1)).rejects.toBeInstanceOf(
      FplNotFoundError,
    );
    const b = await service.getBootstrap();
    const rows = await service.getPlayersLive(
      b.players.slice(0, 30).map((p) => p.id),
      gw9,
    );
    for (const r of rows) PlayerLiveSchema.parse(r);
  });
});
