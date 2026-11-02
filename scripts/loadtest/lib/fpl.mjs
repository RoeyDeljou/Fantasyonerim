// A demo FPL dataset scaled to production size, served through the real FplService (replay fetch → JSON
// parse → Zod → live engine), so the API does the same work it does against fantasy.premierleague.com.
//
// * League: `managers` entries (default 150 → 3 standings pages), cloned from the 60 demo managers with
//   shifted totals so the table isn't a wall of ties.
// * Bootstrap + live: the 194 demo players are cloned up to ~780 elements and padded to ~100 fields each,
//   which is what the real bootstrap-static (~1.8 MB) and event/N/live (~0.7 MB) weigh.
/* global structuredClone -- Node.js globals (eslint's .mjs config lists only a few) */
import { buildDemoDataset, createFplService, createReplayFetch, demoRoutes } from '@fant/fpl';

export const LT_FIRST_ENTRY_ID = 1000001;

/** @param {{ managers?: number, playerCopies?: number, anchorMs?: number }} [options] */
export function buildScaledDataset(options = {}) {
  const managers = options.managers ?? 150;
  const copies = options.playerCopies ?? 4;
  const base = buildDemoDataset({ anchorMs: options.anchorMs ?? Date.now() });
  const bootstrap = structuredClone(base.bootstrap);
  const elements = /** @type {Record<string, unknown>[]} */ (bootstrap.elements);
  const live = new Map();
  const maxId = Math.max(...elements.map((e) => /** @type {number} */ (e.id)));

  // ---- players: clones that never play (as most of a real bootstrap), padded to real-world width ----
  const originals = [...elements];
  for (let c = 1; c < copies; c += 1) {
    for (const e of originals) {
      elements.push({ ...e, id: /** @type {number} */ (e.id) + c * maxId, event_points: 0, minutes: 0 });
    }
  }
  for (const e of elements) {
    for (let k = 0; k < 48; k += 1) e[`lt_pad_${k}`] = k % 3 === 0 ? `${(k * 1.7).toFixed(1)}` : k;
  }
  for (const [event, raw] of base.live) {
    const liveEls = [...raw.elements];
    const byId = new Map(raw.elements.map((el) => [el.id, el]));
    for (let c = 1; c < copies; c += 1) {
      for (const e of originals) {
        const src = byId.get(/** @type {number} */ (e.id));
        if (!src) continue;
        const zero = Object.fromEntries(
          Object.entries(src.stats).map(([k, v]) => [k, typeof v === 'string' ? '0.0' : 0]),
        );
        liveEls.push({
          ...src,
          id: /** @type {number} */ (e.id) + c * maxId,
          stats: zero,
          explain: src.explain.map((/** @type {{ fixture: number }} */ x) => ({
            fixture: x.fixture,
            stats: [{ identifier: 'minutes', points: 0, value: 0, points_modification: 0 }],
          })),
        });
      }
    }
    live.set(event, { ...raw, elements: liveEls });
  }

  // ---- managers ----
  const entries = new Map(base.entries);
  const histories = new Map(base.histories);
  const picks = new Map(base.picks);
  const srcIds = [...base.entryIds];
  const ids = [];
  for (let i = 0; i < managers; i += 1) {
    const id = LT_FIRST_ENTRY_ID + i;
    ids.push(id);
    if (i < srcIds.length) continue;
    const src = /** @type {number} */ (srcIds[i % srcIds.length]);
    const shift = ((i * 37) % 61) - 30;
    const entry = structuredClone(base.entries.get(src));
    entry.id = id;
    entry.name = `${entry.name} ${i + 1}`;
    entry.player_first_name = `Fan${i + 1}`;
    entry.summary_overall_points = /** @type {number} */ (entry.summary_overall_points) + shift;
    entries.set(id, entry);
    const history = structuredClone(base.histories.get(src));
    for (const h of history.current) h.total_points += shift;
    histories.set(id, history);
    for (const [key, value] of base.picks) {
      const [owner, event] = key.split(':');
      if (Number(owner) !== src) continue;
      const p = structuredClone(value);
      p.entry_history.total_points += shift;
      picks.set(`${id}:${event}`, p);
    }
  }

  // ---- standings (FPL pages of 50) ----
  const current = base.currentEvent;
  const rows = ids
    .map((id) => {
      const p = picks.get(`${id}:${current}`);
      const e = entries.get(id);
      const eh = p?.entry_history ?? { points: 0, total_points: 0, event_transfers_cost: 0 };
      return {
        id: 70_000_000 + id,
        event_total: eh.points - eh.event_transfers_cost,
        player_name: `${e.player_first_name} ${e.player_last_name}`,
        rank: 0,
        last_rank: 0,
        rank_sort: 0,
        total: eh.total_points,
        entry: id,
        entry_name: e.name,
        has_played: true,
      };
    })
    .sort((a, b) => b.total - a.total || a.entry - b.entry);
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.rank_sort = i + 1;
    r.last_rank = Math.max(1, Math.min(rows.length, i + 1 + (((r.entry * 13) % 21) - 10)));
  });
  const PAGE = 50;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const first = /** @type {Record<string, unknown>} */ (base.standingsPages[0]);
  const standingsPages = Array.from({ length: pageCount }, (_, p) => ({
    ...first,
    standings: { has_next: p < pageCount - 1, page: p + 1, results: rows.slice(p * PAGE, (p + 1) * PAGE) },
  }));

  return {
    ...base,
    entryIds: ids,
    bootstrap,
    live,
    entries,
    histories,
    picks,
    standingsPages,
  };
}

/**
 * The real `createFplService` over the scaled dataset. `onRequest` counts upstream calls.
 * @param {{ managers?: number, onWarn?: (m: string) => void, onRequest?: (key: string) => void }} [options]
 */
export function createScaledFplService(options = {}) {
  const data = buildScaledDataset(options);
  const routes = demoRoutes(data);
  return {
    data,
    fpl: createFplService({
      fetch: createReplayFetch(routes, options.onRequest ? { onRequest: options.onRequest } : {}),
      ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    }),
  };
}
