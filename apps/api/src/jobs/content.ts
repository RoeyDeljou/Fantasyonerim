import type { ContentSource, SourceResult } from '@fant/integrations';
import type { IntegrationId } from '@fant/shared';
import { describeIntegrationError, recordIntegrationRun, type LoadedIntegration } from '../integrations/store.js';
import { ingestDrafts, type IngestResult } from '../news/ingest.js';
import { pushNewNewsItems } from '../news/pushNews.js';
import type { JobRunContext } from './types.js';

export interface ContentRunResult {
  ok: boolean;
  fetched: SourceResult | null;
  ingest: IngestResult | null;
  pushed: number;
  /** The admin-facing note stored as lastError (null = all good). */
  note: string | null;
}

/** Warnings, skipped items and failed saves condensed into one admin-readable line. */
export function summarizeProblems(fetched: SourceResult, ingest: IngestResult, extra: readonly string[] = []) {
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
  options: { rehost: boolean; stateKey: string; extraNotes?: readonly string[] },
): Promise<ContentRunResult & { state: Record<string, unknown> }> {
  const { app } = ctx;
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
    return { ok: false, fetched: null, ingest: null, pushed: 0, note, state };
  }

  const ingest = await ingestDrafts(app, fetched.items, { rehost: options.rehost });
  let pushed = 0;
  if (!firstSync && ingest.created.length > 0) {
    try {
      pushed = (await pushNewNewsItems(app, ingest.created)).recipients;
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
  return { ok: true, fetched, ingest, pushed, note, state };
}

export function runSummary(result: ContentRunResult): string {
  if (!result.ok) return `failed: ${result.note ?? ''}`;
  if (result.fetched?.notModified === true) return 'not modified';
  const i = result.ingest;
  return i === null
    ? 'ok'
    : `${i.created.length} new, ${i.updated} updated, ${i.failed.length} failed, pushed to ${result.pushed}`;
}
