import { createHash } from 'node:crypto';
import type { ContentSource, NewsItemDraft, SourceResult } from '@fant/integrations';
import type { IntegrationId } from '@fant/shared';
import {
  describeIntegrationError,
  recordIntegrationRun,
  type LoadedIntegration,
} from '../integrations/store.js';
import { ingestDrafts, type IngestResult } from '../news/ingest.js';
import { pushNewNewsItems } from '../news/pushNews.js';
import type { NotifyResult } from '../push/notify.js';
import type { JobPlanContext, JobRunContext } from './types.js';

/** Job-state key: fingerprint of the last upstream result that was fully saved (see `planContentPoll`). */
export const FINGERPRINT_STATE_KEY = 'fingerprint';
const MEMO_CURSOR = 'cursor';

/**
 * A stable fingerprint of what ingest would write for a poll result: unchanged fingerprint = an upsert of the same
 * drafts would be a no-op. Re-hosted media are compared by kind only (ingest never re-downloads them once stored;
 * their CDN URLs rotate on every poll), direct media by URL (ingest compares those).
 */
export function fingerprintResult(result: SourceResult, rehost: boolean): string {
  const media = (d: NewsItemDraft) =>
    d.media.map((m) => (rehost ? [m.kind] : [m.kind, m.sourceUrl, m.posterSourceUrl, m.width, m.height]));
  const items = result.items.map((d) => [
    d.dedupeKey,
    d.source,
    d.title,
    d.text,
    d.links,
    d.podcast,
    d.publishedAt.getTime(),
    d.expiresAt?.getTime() ?? null,
    media(d),
  ]);
  return createHash('sha256')
    .update(JSON.stringify([items, result.skipped, result.accountLabel]))
    .digest('base64url');
}

/** What a content job's plan hands to its run: the upstream result it already fetched (never fetched twice). */
export interface ContentCarry {
  /** The cursor the plan fetched with (the run only reuses the result when the stored cursor still matches). */
  cursor: string | null;
  fetched: SourceResult | null;
  error: unknown;
  fingerprint: string | null;
}

export interface ContentPoll {
  changed: boolean;
  reason: string;
  carry: ContentCarry;
}

const EMPTY_INGEST: IngestResult = { created: [], updated: 0, unchanged: 0, failed: [] };

/**
 * The DB-free half of a content poll: fetch upstream with the cached cursor and compare with what was saved last
 * time (304 / same fingerprint / same admin note). `changed: false` = the run would write nothing new, so the job
 * skips the database. A cursor that changed without new content (rotating ETag) is kept in memory only.
 */
export async function planContentPoll(
  ctx: JobPlanContext,
  integration: LoadedIntegration,
  source: ContentSource,
  options: { rehost: boolean; stateKey: string; extraNotes?: readonly string[] },
): Promise<ContentPoll> {
  const id: IntegrationId = integration.row.id;
  const stored = integration.row.cursor;
  const memoCursor = ctx.memo[MEMO_CURSOR] as { base: string | null; value: string | null } | undefined;
  const cursor = memoCursor !== undefined && memoCursor.base === stored ? memoCursor.value : stored;
  const firstSync = !integration.row.initialSyncDone || ctx.state[options.stateKey] !== true;

  let fetched: SourceResult;
  try {
    fetched = await source.fetchLatest(cursor);
  } catch (err) {
    const note = describeIntegrationError(id, err);
    ctx.checked(id, { ok: false, error: note });
    const carry: ContentCarry = { cursor: stored, fetched: null, error: err, fingerprint: null };
    if (!firstSync && note === integration.row.lastError) {
      ctx.log.warn({ integration: id, error: note }, 'integration poll failed (unchanged)');
      return { changed: false, reason: 'same failure as last time', carry };
    }
    return { changed: true, reason: 'poll failed', carry };
  }
  const fingerprint = fetched.notModified ? null : fingerprintResult(fetched, options.rehost);
  const carry: ContentCarry = { cursor: stored, fetched, error: null, fingerprint };
  if (firstSync) return { changed: true, reason: 'first sync', carry };
  const note = summarizeProblems(fetched, EMPTY_INGEST, options.extraNotes);
  if (note !== integration.row.lastError) return { changed: true, reason: 'admin note changed', carry };
  if (fetched.accountLabel !== null && fetched.accountLabel !== integration.row.accountLabel) {
    return { changed: true, reason: 'account label changed', carry };
  }
  if (!fetched.notModified && fingerprint !== ctx.state[FINGERPRINT_STATE_KEY]) {
    return { changed: true, reason: 'new content', carry };
  }
  if (!fetched.notModified && fetched.cursor !== cursor) {
    ctx.memo[MEMO_CURSOR] = { base: stored, value: fetched.cursor };
  }
  ctx.checked(id, { ok: true, error: note });
  return { changed: false, reason: fetched.notModified ? 'not modified' : 'unchanged', carry };
}

/**
 * The source a run polls: the plan's carried result when it was fetched with the cursor still stored (no second
 * upstream call), else the real source. Records the raw result's fingerprint either way.
 */
export function carriedSource(
  source: ContentSource,
  carry: unknown,
  storedCursor: string | null,
  rehost: boolean,
): { source: ContentSource; fingerprint: () => string | null } {
  let fingerprint: string | null = null;
  const usable = isContentCarry(carry) && carry.cursor === storedCursor ? carry : null;
  return {
    fingerprint: () => fingerprint,
    source: {
      source: source.source,
      async fetchLatest(cursor) {
        if (usable !== null) {
          if (usable.error !== null) throw usable.error;
          if (usable.fetched !== null) {
            fingerprint = usable.fingerprint;
            return usable.fetched;
          }
        }
        const result = await source.fetchLatest(cursor);
        fingerprint = result.notModified ? null : fingerprintResult(result, rehost);
        return result;
      },
    },
  };
}

function isContentCarry(value: unknown): value is ContentCarry {
  return typeof value === 'object' && value !== null && 'fetched' in value && 'cursor' in value;
}

export interface ContentRunResult {
  ok: boolean;
  fetched: SourceResult | null;
  ingest: IngestResult | null;
  /** Users notified (recipients). */
  pushed: number;
  /** The push's device accounting (null when nothing was pushed). */
  push: NotifyResult | null;
  /** The admin-facing note stored as lastError (null = all good). */
  note: string | null;
}

/** Warnings, skipped items and failed saves condensed into one admin-readable line. */
export function summarizeProblems(
  fetched: SourceResult,
  ingest: IngestResult,
  extra: readonly string[] = [],
) {
  const parts: string[] = [...extra];
  if (ingest.failed.length > 0) {
    const first = ingest.failed[0];
    parts.push(
      `${ingest.failed.length} item(s) not imported yet, will retry` +
        (first === undefined ? '' : ` (${first.dedupeKey}: ${first.reason})`),
    );
  }
  if (fetched.skipped.length > 0) {
    const first = fetched.skipped[0];
    parts.push(
      `${fetched.skipped.length} item(s) skipped` +
        (first === undefined ? '' : ` (${first.externalId ?? 'unknown'}: ${first.reason})`),
    );
  }
  parts.push(...fetched.warnings);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * One poll of one source: fetch → upsert → push the NEW items (except during the integration's first
 * sync, which backfills silently) → record status. Platform errors are recorded on the integration row
 * and never thrown, so one source failing never blocks the others.
 */
export async function runContentSource(
  ctx: JobRunContext,
  integration: LoadedIntegration,
  source: ContentSource,
  options: {
    rehost: boolean;
    stateKey: string;
    extraNotes?: readonly string[];
    /** The job wrapped the raw source in `carriedSource` itself (e.g. to filter its items): its fingerprint. */
    fingerprint?: () => string | null;
  },
): Promise<ContentRunResult & { state: Record<string, unknown> }> {
  const { app } = ctx;
  // The plan's upstream result (when still valid) instead of a second fetch; fingerprint recorded either way.
  let fingerprintOf = options.fingerprint;
  if (fingerprintOf === undefined) {
    const tapped = carriedSource(source, ctx.carry, integration.row.cursor, options.rehost);
    source = tapped.source;
    fingerprintOf = tapped.fingerprint;
  }
  const id: IntegrationId = integration.row.id;
  const firstSync = !integration.row.initialSyncDone || ctx.state[options.stateKey] !== true;
  const state = { ...ctx.state };

  let fetched: SourceResult;
  try {
    fetched = await source.fetchLatest(integration.row.cursor);
  } catch (err) {
    const note = describeIntegrationError(id, err);
    ctx.log.warn({ integration: id, error: note }, 'integration poll failed');
    await recordIntegrationRun(app.prisma, id, app.clock.now(), { ok: false, error: note });
    return { ok: false, fetched: null, ingest: null, pushed: 0, push: null, note, state };
  }

  const ingest = await ingestDrafts(app, fetched.items, { rehost: options.rehost });
  let pushed = 0;
  let push: NotifyResult | null = null;
  if (!firstSync && ingest.created.length > 0) {
    try {
      push = await pushNewNewsItems(app, ingest.created);
      pushed = push.recipients;
    } catch (err) {
      ctx.log.error({ integration: id, err }, 'news push failed');
    }
  }
  const note = summarizeProblems(fetched, ingest, options.extraNotes);
  // Keep the old cursor when something failed to save, so a 304 / since_id can't hide it forever.
  const cursor = ingest.failed.length > 0 ? integration.row.cursor : fetched.cursor;
  await recordIntegrationRun(app.prisma, id, app.clock.now(), {
    ok: true,
    error: note,
    imported: ingest.created.length,
    cursor,
    accountLabel: fetched.accountLabel,
    initialSyncDone: true,
  });
  state[options.stateKey] = true;
  // Only a fully saved result counts as "seen": a failed item makes the next poll try again.
  const fingerprint = fingerprintOf();
  if (ingest.failed.length === 0 && fingerprint !== null) state[FINGERPRINT_STATE_KEY] = fingerprint;
  delete ctx.memo[MEMO_CURSOR];
  return { ok: true, fetched, ingest, pushed, push, note, state };
}

export function runSummary(result: ContentRunResult): string {
  if (!result.ok) return `failed: ${result.note ?? ''}`;
  if (result.fetched?.notModified === true) return 'not modified';
  const i = result.ingest;
  return i === null
    ? 'ok'
    : `${i.created.length} new, ${i.updated} updated, ${i.failed.length} failed, ${pushSummary(result.push)}`;
}

/** "pushed to N users (D/T devices delivered, G gone, F failed)". */
export function pushSummary(push: NotifyResult | null): string {
  if (push === null) return 'pushed to 0 users';
  return (
    `pushed to ${push.recipients} users (${push.devicesDelivered}/${push.devices} devices delivered, ` +
    `${push.gone} gone, ${push.failed} failed)`
  );
}
