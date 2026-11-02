import { BootstrapSchema, type AuthResponse } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePushProvider, subscribe } from './fakes.js';
import {
  makeBootstrap,
  makeEntryLive,
  makeFixture,
  makePicks,
  upstreamDown,
  type FakeFplService,
  type LiveCaptain,
} from './fakeFpl.js';
import {
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestClock,
} from './helpers.js';

const prisma = createTestPrisma();
const MIN = 60_000;
const HOUR = 60 * MIN;
const LEAGUE = 500;

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  push = new FakePushProvider();
  ({ app, fpl, clock } = await buildTestApp(prisma, { push, config: { vapidPublicKey: 'BARW9HWQIO3yv' } }));
  fpl.leagues.set(LEAGUE, { id: LEAGUE, name: 'Fantasyonerim' });
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function configureLeague(leagueId = LEAGUE): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { leagueId },
    create: { id: 1, leagueId },
  });
}

async function fan(
  entryId: number,
  options: { locale?: 'he' | 'en'; prefs?: Record<string, boolean> } = {},
): Promise<AuthResponse> {
  const user = await registerUser(app, fpl, entryId);
  await subscribe(app, user.token, `https://push.test/${entryId}`);
  if (options.locale) {
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(user.token),
      payload: { locale: options.locale },
    });
  }
  if (options.prefs) {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(user.token),
      payload: { news: true, fpl: true, live: true, community: true, ...options.prefs },
    });
    expect(res.statusCode).toBe(200);
  }
  return user;
}

const sentTo = (entryId: number) => push.sent.filter((s) => s.endpoint === `https://push.test/${entryId}`);

// ---------- Task A: league moments in the GW summary ----------

function finishedGw9() {
  const ev = (id: number, flags: object) => ({
    id,
    name: `Gameweek ${id}`,
    deadlineTime: new Date(clock.now().getTime() + (id - 9) * 7 * 24 * HOUR).toISOString(),
    finished: false,
    dataChecked: false,
    isCurrent: false,
    isNext: false,
    averageScore: null,
    highestScore: null,
    ...flags,
  });
  fpl.bootstrap = BootstrapSchema.parse({
    ...makeBootstrap(),
    events: [ev(9, { isCurrent: true, finished: true, dataChecked: true }), ev(10, { isNext: true })],
  });
}

const standing = (entryId: number, rank: number, lastRank: number, eventTotal: number) => ({
  rank,
  lastRank,
  entryId,
  entryName: `Team ${entryId}`,
  managerName: `Manager ${entryId}`,
  total: 600 - rank,
  eventTotal,
});

function summaryPicks(entryId: number, points: number, rank: number): void {
  fpl.picks.set(`${entryId}:9`, { ...makePicks(entryId, 9, 1), points, transfersCost: 0, overallRank: rank });
}

describe('gameweek summary with league moments', () => {
  beforeEach(() => finishedGw9());

  it('one push per user per GW: highlights first, then the GW line; plain summary otherwise', async () => {
    await configureLeague();
    await fan(101);
    await fan(102, { locale: 'en' });
    await fan(103);
    await fan(104);
    await fan(105, { prefs: { fpl: false } });
    await fan(106, { prefs: { league: false } });
    await fan(107); // not in the league
    await fan(108, { prefs: { fpl: false } }); // league only, but nothing to celebrate → no push
    for (const [id, pts] of [
      [101, 80],
      [102, 60],
      [103, 80],
      [104, 30],
      [106, 50],
      [107, 40],
    ] as const) {
      summaryPicks(id, pts, 100_000 + id);
    }
    // Two standings pages: every page is read.
    fpl.standingsPageCount = 2;
    fpl.standingsByPage = new Map([
      [1, [standing(101, 1, 1, 80), standing(103, 2, 2, 80), standing(105, 3, 5, 55)]],
      [
        2,
        [
          standing(102, 4, 12, 60),
          standing(106, 5, 30, 50),
          standing(104, 20, 0, 30),
          standing(108, 21, 9, 10),
        ],
      ],
    ]);

    await app.jobs.run('gameweek_summary', { force: true });
    await app.jobs.run('gameweek_summary', { force: true });

    const one = (id: number) => {
      const sent = sentTo(id);
      expect(sent).toHaveLength(1);
      const first = sent[0];
      if (first === undefined) throw new Error('no push');
      return first.payload;
    };
    expect(one(101)).toMatchObject({
      title: '👑 מלך המחזור בליגה! 80 נק׳',
      body: "🥇 עדיין במקום הראשון בליגה\nמחזור 9 הסתיים: 80 נק' · דירוג 100,101",
      url: '/table/',
      tag: 'gw-summary-9',
    });
    expect(one(102)).toMatchObject({
      title: '🔥 Up 8 places in the league — now 4',
      body: "📈 You're into the league's top 10!\nGameweek 9 is over: 60 pts · rank 100,102",
      url: '/table/',
    });
    // Ties share top scorer.
    expect(one(103)).toMatchObject({
      title: '👑 מלך המחזור בליגה! 80 נק׳',
      body: "מחזור 9 הסתיים: 80 נק' · דירוג 100,103",
    });
    // New member (lastRank 0): plain summary.
    expect(one(104)).toMatchObject({ title: "מחזור 9 הסתיים: 30 נק' · דירוג 100,104", url: '/my-team/' });
    // fpl off + league on: the league highlight only.
    expect(one(105)).toMatchObject({
      title: '🏅 נכנסת לשלושת הראשונים בליגה!',
      body: 'לחצו לטבלת הליגה',
      url: '/table/',
    });
    // league off: exactly today's summary.
    expect(one(106)).toMatchObject({
      title: "מחזור 9 הסתיים: 50 נק' · דירוג 100,106",
      body: 'לחצו לפרטי הקבוצה שלכם',
      url: '/my-team/',
    });
    expect(one(107)).toMatchObject({ title: "מחזור 9 הסתיים: 40 נק' · דירוג 100,107" });
    expect(sentTo(108)).toHaveLength(0);
    expect(fpl.calls.filter((c) => c.startsWith('getLeagueStandings'))).toEqual([
      `getLeagueStandings:${LEAGUE}:1`,
      `getLeagueStandings:${LEAGUE}:2`,
    ]);
    // No picks for league-only users.
    expect(fpl.calls.some((c) => c.startsWith('getEntryPicks:105:'))).toBe(false);
    expect(await prisma.notificationLog.count({ where: { key: 'gw_summary:9' } })).toBe(7);
  });

  it('standings failure → the plain summary for everyone (never blocking)', async () => {
    await configureLeague();
    await fan(201);
    await fan(202, { prefs: { fpl: false } });
    summaryPicks(201, 70, 5000);
    fpl.leagues.clear(); // the league read fails
    await app.jobs.run('gameweek_summary', { force: true });
    expect(push.sent.map((s) => s.payload.title)).toEqual(["מחזור 9 הסתיים: 70 נק' · דירוג 5,000"]);
    expect(push.sent[0]?.payload.url).toBe('/my-team/');
  });

  it('reads at most 40 standings pages', async () => {
    await configureLeague();
    await fan(301);
    summaryPicks(301, 70, 5000);
    fpl.standingsPageCount = 1000;
    await app.jobs.run('gameweek_summary', { force: true });
    expect(fpl.calls.filter((c) => c.startsWith('getLeagueStandings'))).toHaveLength(40);
    expect(push.sent).toHaveLength(1);
  });
});

// ---------- Task B: live big moments ----------

/** The live league table: `ranks` maps entryId → wanted live rank; fillers take the other places. */
function liveTable(ranks: Record<number, number>, official: Record<number, number> = {}, size = 60): void {
  const wanted = new Map(Object.entries(ranks).map(([e, r]) => [r, Number(e)]));
  const rows = [];
  for (let rank = 1; rank <= size; rank += 1) {
    const entryId = wanted.get(rank) ?? 9000 + rank;
    rows.push({
      liveRank: 1,
      officialRank: official[entryId] ?? rank,
      entryId,
      entryName: `Team ${entryId}`,
      managerName: `Manager ${entryId}`,
      livePoints: 100 - rank,
      liveTotal: 10_000 - rank * 10,
      captainPlayerId: null,
      effectiveCaptainPlayerId: null,
      activeChip: null,
      playersYetToPlay: 3,
    });
  }
  // Two pages (FplService ranks within a page; the job re-ranks league-wide).
  fpl.liveLeagueByPage = new Map([
    [1, rows.slice(0, 50)],
    [2, rows.slice(50)],
  ]);
}

function captain(entryId: number, c: LiveCaptain, benched: number | null = null, gw = 9): void {
  fpl.entryLive.set(`${entryId}:${gw}`, makeEntryLive(entryId, gw, c, benched));
}

const runLive = async () => {
  push.sent = [];
  expect(await app.jobs.run('live_alerts', { force: true })).toBe('ok');
  return push.sent;
};

describe('live alerts: captain returns', () => {
  it('first run is a baseline; then one alert per new goal / assist, deduped, high urgency 1 h', async () => {
    await fan(401);
    await fan(402, { locale: 'en' });
    captain(401, { playerId: 1, goals: 1 });
    captain(402, { playerId: 1, goals: 1 });
    expect(await runLive()).toHaveLength(0); // the goal before the job saw it never fires

    captain(401, { playerId: 1, goals: 2 });
    captain(402, { playerId: 1, goals: 2 });
    const sent = await runLive();
    expect(sent.map((s) => [s.endpoint, s.payload.title, s.payload.tag])).toEqual(
      expect.arrayContaining([
        ['https://push.test/401', '⚽ הקפטן שלך Salah כבש!', 'live-9-cap-1-g2'],
        ['https://push.test/402', '⚽ Your captain Salah scored!', 'live-9-cap-1-g2'],
      ]),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]?.options).toEqual({ ttlSec: 3600, urgency: 'high' });
    expect(sent[0]?.payload.url).toBe('/my-team/');
    expect(await runLive()).toHaveLength(0); // unchanged → nothing

    captain(401, { playerId: 1, goals: 4, assists: 1 });
    const burst = await runLive();
    expect(burst.map((s) => s.payload.tag)).toEqual([
      'live-9-cap-1-g3',
      'live-9-cap-1-g4',
      'live-9-cap-1-a1',
    ]);
    expect(burst[2]?.payload.title).toBe('🅰️ הקפטן שלך Salah בישל!');
  });

  it('uses the effective captain (vice when the captain did not play; triple captain alike)', async () => {
    await fan(411);
    await fan(412);
    captain(411, { playerId: 2 }, 1); // captain 1 benched → vice Haaland has the armband
    captain(412, { playerId: 3, multiplier: 3 });
    await runLive();
    captain(411, { playerId: 2, goals: 1 }, 1);
    captain(412, { playerId: 3, goals: 1, multiplier: 3 });
    // Salah (the benched captain) scoring would not matter; Haaland and Palmer do.
    const sent = await runLive();
    expect(sent.map((s) => s.payload.title).sort()).toEqual([
      '⚽ הקפטן שלך Haaland כבש!',
      '⚽ הקפטן שלך Palmer כבש!',
    ]);
  });

  it('a captain change between runs re-baselines (no alert for earlier goals)', async () => {
    await fan(421);
    captain(421, { playerId: 1 });
    await runLive();
    captain(421, { playerId: 2, goals: 2 }, 1); // the vice took the armband with 2 goals already
    expect(await runLive()).toHaveLength(0);
    captain(421, { playerId: 2, goals: 3 }, 1);
    expect((await runLive()).map((s) => s.payload.tag)).toEqual(['live-9-cap-2-g3']);
  });

  it('respects the captain preference', async () => {
    await fan(431, { prefs: { captain: false } });
    captain(431, { playerId: 1 });
    await runLive();
    captain(431, { playerId: 1, goals: 1 });
    expect(await runLive()).toHaveLength(0);
    expect(fpl.calls.some((c) => c.startsWith('getEntryLive:431'))).toBe(false);
  });

  it('caps live alerts at 6 per user per GW', async () => {
    await fan(441);
    captain(441, { playerId: 1 });
    await runLive();
    captain(441, { playerId: 1, goals: 5, assists: 3 });
    expect(await runLive()).toHaveLength(6);
    captain(441, { playerId: 1, goals: 6, assists: 3 });
    expect(await runLive()).toHaveLength(0);
  });
});

describe('live alerts: running conditions and state', () => {
  it('no-ops cheaply without a live fixture, and baselines on the first live run', async () => {
    await fan(501);
    fpl.fixtures = [makeFixture(100, 9, 'not_started')];
    captain(501, { playerId: 1 });
    fpl.calls = [];
    await runLive();
    expect(fpl.calls).toEqual(['getBootstrap', 'getFixtures:9']);

    fpl.fixtures = [makeFixture(100, 9, 'live')];
    captain(501, { playerId: 1, goals: 1 });
    expect(await runLive()).toHaveLength(0); // baseline
    captain(501, { playerId: 1, goals: 2 });
    expect(await runLive()).toHaveLength(1);
  });

  it('does one final pass after the last live fixture ends, then stops', async () => {
    await fan(511);
    captain(511, { playerId: 1 });
    await runLive();
    fpl.fixtures = [makeFixture(100, 9, 'finished_provisional')];
    captain(511, { playerId: 1, goals: 1 }); // 90+4'
    expect(await runLive()).toHaveLength(1);
    captain(511, { playerId: 1, goals: 2 });
    fpl.calls = [];
    expect(await runLive()).toHaveLength(0);
    expect(fpl.calls).toEqual(['getBootstrap', 'getFixtures:9']);
  });

  it('a new GW starts from a fresh baseline', async () => {
    await fan(521);
    captain(521, { playerId: 1 });
    await runLive();
    fpl.bootstrap = makeBootstrap(10, 11);
    captain(521, { playerId: 1, goals: 3 }, null, 10);
    expect(await runLive()).toHaveLength(0);
    captain(521, { playerId: 1, goals: 4 }, null, 10);
    expect((await runLive()).map((s) => s.payload.tag)).toEqual(['live-10-cap-1-g4']);
  });

  it('state survives a restart (new app instance, same database)', async () => {
    await fan(531);
    captain(531, { playerId: 1 });
    await runLive();
    await app.close();
    ({ app, clock } = await buildTestApp(prisma, { push, fpl, config: { vapidPublicKey: 'BARW9HWQIO3yv' } }));
    captain(531, { playerId: 1, goals: 1 });
    expect(await runLive()).toHaveLength(1);
  });
});

describe('live alerts: live league', () => {
  beforeEach(async () => {
    await configureLeague();
  });

  it('moved into first place: once, then at most once per hour', async () => {
    await fan(601, { locale: 'en' });
    await fan(602);
    liveTable({ 601: 3, 602: 4 });
    await runLive(); // baseline
    liveTable({ 601: 1, 602: 4 });
    const sent = await runLive();
    expect(sent.map((s) => [s.endpoint, s.payload.title, s.payload.tag, s.payload.url])).toEqual([
      ['https://push.test/601', "🥇 You're top of the live table!", 'live-9-first-1', '/live/'],
    ]);
    liveTable({ 601: 2, 602: 4 });
    await runLive();
    liveTable({ 601: 1, 602: 4 });
    expect(await runLive()).toHaveLength(0); // flapping within the hour
    clock.advance(HOUR + MIN);
    liveTable({ 601: 2, 602: 4 });
    await runLive();
    liveTable({ 601: 1, 602: 4 });
    expect((await runLive()).map((s) => s.payload.tag)).toEqual(['live-9-first-2']);
  });

  it('jump of 5+ places vs the GW baseline / last alert, at most 1 per 2 h; small wobbles never alert', async () => {
    await fan(611);
    liveTable({ 611: 18 }, { 611: 20 });
    await runLive(); // baseline: official rank 20
    liveTable({ 611: 16 }, { 611: 20 });
    expect(await runLive()).toHaveLength(0); // 4 places: a wobble
    liveTable({ 611: 14 }, { 611: 20 });
    const sent = await runLive();
    expect(sent.map((s) => [s.payload.title, s.payload.tag])).toEqual([
      ['🚀 קפצת 6 מקומות בטבלה החיה — עכשיו במקום 14', 'live-9-jump-1'],
    ]);
    liveTable({ 611: 8 }, { 611: 20 });
    expect(await runLive()).toHaveLength(0); // within 2 h of the last jump
    clock.advance(2 * HOUR);
    liveTable({ 611: 7 }, { 611: 20 });
    expect((await runLive()).map((s) => s.payload.title)).toEqual([
      '🚀 קפצת 7 מקומות בטבלה החיה — עכשיו במקום 7',
    ]);
    // Falling back never alerts.
    clock.advance(2 * HOUR);
    liveTable({ 611: 30 }, { 611: 20 });
    expect(await runLive()).toHaveLength(0);
  });

  it('at most 3 jump alerts per GW', async () => {
    await fan(621);
    let rank = 60;
    liveTable({ 621: rank });
    await runLive();
    const tags: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      rank -= 6;
      clock.advance(2 * HOUR);
      liveTable({ 621: rank }, { 621: 60 });
      tags.push(...(await runLive()).map((s) => s.payload.tag ?? ''));
    }
    expect(tags).toEqual(['live-9-jump-1', 'live-9-jump-2', 'live-9-jump-3']);
  });

  it('league alerts need the league pref and league membership; a live league failure is not fatal', async () => {
    await fan(631, { prefs: { league: false } });
    await fan(632);
    captain(632, { playerId: 1 });
    liveTable({ 631: 5 });
    await runLive();
    liveTable({ 631: 1 });
    expect(await runLive()).toHaveLength(0);
    fpl.leagues.clear();
    captain(632, { playerId: 1, goals: 1 });
    expect((await runLive()).map((s) => s.payload.tag)).toEqual(['live-9-cap-1-g1']);
    fpl.failAll = upstreamDown();
    expect(await app.jobs.run('live_alerts', { force: true })).toBe('failed');
  });
});
