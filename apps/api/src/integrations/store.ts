import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from '@fant/integrations';
import { IntegrationStatusSchema, type IntegrationId, type IntegrationStatus } from '@fant/shared';
import type { Prisma } from '@prisma/client';
import { type IntegrationConfig, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { serialize } from '../validate.js';
import { INTEGRATIONS, INTEGRATION_IDS } from './config.js';

const StringRecordSchema = z.record(z.string(), z.string());

export interface LoadedIntegration {
  row: IntegrationConfig;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  configured: boolean;
  /** enabled && configured — the job may poll it. */
  active: boolean;
}

/** Creates any missing IntegrationConfig rows with the client's defaults. Never touches existing rows. */
export async function ensureIntegrationRows(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.integrationConfig.findMany({ select: { id: true } });
  const have = new Set(existing.map((r) => r.id));
  const missing = INTEGRATION_IDS.filter((id) => !have.has(id));
  if (missing.length === 0) return;
  await prisma.integrationConfig.createMany({
    data: missing.map((id) => ({
      id,
      enabled: INTEGRATIONS[id].defaultEnabled,
      settings: { ...INTEGRATIONS[id].defaultSettings },
    })),
    skipDuplicates: true,
  });
}

/**
 * Seeds integration secrets from deploy-time env (e.g. SPOTIFY_CLIENT_ID/SECRET on Render) so a fresh production
 * database is configured without anyone re-typing keys. Only fills an integration that has NO stored secrets:
 * once an admin saves keys in the console, the console wins and env is ignored. Returns the ids it seeded.
 */
export async function seedIntegrationSecrets(
  prisma: PrismaClient,
  key: Buffer,
  seeds: Partial<Record<IntegrationId, Record<string, string>>>,
): Promise<IntegrationId[]> {
  const seeded: IntegrationId[] = [];
  for (const id of INTEGRATION_IDS) {
    const values = seeds[id];
    if (!values || Object.keys(values).length === 0) continue;
    const row = await prisma.integrationConfig.findUnique({ where: { id } });
    if (row === null || Object.keys(readSecrets(key, row)).length > 0) continue;
    await prisma.integrationConfig.update({
      where: { id },
      data: { secretsEnc: encryptSecrets(key, values), enabled: true },
    });
    seeded.push(id);
  }
  return seeded;
}

export function readSettings(row: IntegrationConfig): Record<string, string> {
  const parsed = StringRecordSchema.safeParse(row.settings);
  return parsed.success ? parsed.data : {};
}

/** Decrypts the secrets JSON. A payload that fails authentication (rotated key) reads as "no secrets". */
export function readSecrets(key: Buffer, row: IntegrationConfig): Record<string, string> {
  if (row.secretsEnc === null) return {};
  try {
    const parsed = StringRecordSchema.safeParse(JSON.parse(decryptSecret(key, row.secretsEnc)));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function encryptSecrets(key: Buffer, secrets: Record<string, string>): string | null {
  return Object.keys(secrets).length === 0 ? null : encryptSecret(key, JSON.stringify(secrets));
}

export function describe(row: IntegrationConfig, key: Buffer): LoadedIntegration {
  const settings = readSettings(row);
  const secrets = readSecrets(key, row);
  const configured = INTEGRATIONS[row.id].isConfigured(settings, secrets);
  return { row, settings, secrets, configured, active: row.enabled && configured };
}

export async function loadIntegration(
  prisma: PrismaClient,
  key: Buffer,
  id: IntegrationId,
): Promise<LoadedIntegration> {
  let row = await prisma.integrationConfig.findUnique({ where: { id } });
  if (row === null) {
    await ensureIntegrationRows(prisma);
    row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id } });
  }
  return describe(row, key);
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function toIntegrationStatus(loaded: LoadedIntegration): IntegrationStatus {
  const { row, settings, secrets, configured } = loaded;
  const def = INTEGRATIONS[row.id];
  const shownKeys = [...Object.keys(def.editable), ...def.readOnly];
  return serialize(
    IntegrationStatusSchema,
    {
      id: row.id,
      enabled: row.enabled,
      configured,
      paidFeature: def.paidFeature,
      accountLabel: row.accountLabel,
      settings: Object.fromEntries(shownKeys.map((k) => [k, settings[k] ?? null])),
      hasSecret: Object.keys(secrets).length > 0,
      secretKeys: Object.keys(secrets).sort(),
      lastRunAt: iso(row.lastRunAt),
      lastSuccessAt: iso(row.lastSuccessAt),
      lastError: row.lastError,
      itemsImported: row.itemsImported,
      tokenExpiresAt: iso(row.tokenExpiresAt),
      dataAccessExpiresAt: iso(row.dataAccessExpiresAt),
    },
    'IntegrationStatus',
  );
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/** Admin-readable text for a failed poll: what happened and what to do about it. */
export function describeIntegrationError(id: IntegrationId, err: unknown): string {
  const platform = INTEGRATIONS[id].platform;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof IntegrationAuthError || isNamed(err, 'IntegrationAuthError')) {
    // @fant/integrations auth errors are already admin-readable ("X rejected the credentials … re-enter the
    // keys"); only add the generic advice when the platform gave us nothing useful.
    if (message.trim().length > 0) return message;
    return id === 'instagram'
      ? 'Instagram rejected the connection — reconnect Instagram.'
      : `${platform} rejected the credentials — check the keys.`;
  }
  if (err instanceof IntegrationRateLimitError || isNamed(err, 'IntegrationRateLimitError')) {
    const after =
      err instanceof IntegrationRateLimitError && err.retryAfterSec !== null
        ? ` in ~${Math.ceil(err.retryAfterSec / 60)} min`
        : '';
    return `${platform} rate limit reached — will retry automatically${after}. (${message})`;
  }
  if (err instanceof IntegrationUnavailableError || isNamed(err, 'IntegrationUnavailableError')) {
    return `${platform} is unavailable — will retry automatically. (${message})`;
  }
  if (err instanceof IntegrationConfigError || isNamed(err, 'IntegrationConfigError')) {
    return message;
  }
  return `${platform} sync failed unexpectedly — will retry automatically. (${message})`;
}

export function isAuthError(err: unknown): boolean {
  return err instanceof IntegrationAuthError || isNamed(err, 'IntegrationAuthError');
}

export function isConfigError(err: unknown): boolean {
  return err instanceof IntegrationConfigError || isNamed(err, 'IntegrationConfigError');
}

/** Records the outcome of one poll on the integration's row (never throws on a missing row). */
export async function recordIntegrationRun(
  prisma: PrismaClient,
  id: IntegrationId,
  now: Date,
  outcome: {
    ok: boolean;
    error: string | null;
    imported?: number;
    cursor?: string | null;
    accountLabel?: string | null;
    initialSyncDone?: boolean;
  },
): Promise<void> {
  const data: Prisma.IntegrationConfigUpdateManyMutationInput = {
    lastRunAt: now,
    lastError: outcome.error === null ? null : outcome.error.slice(0, 1000),
  };
  if (outcome.ok) data.lastSuccessAt = now;
  if (outcome.imported !== undefined && outcome.imported > 0) {
    data.itemsImported = { increment: outcome.imported };
  }
  if (outcome.cursor !== undefined) data.cursor = outcome.cursor;
  if (outcome.accountLabel !== undefined && outcome.accountLabel !== null) {
    data.accountLabel = outcome.accountLabel;
  }
  if (outcome.initialSyncDone !== undefined) data.initialSyncDone = outcome.initialSyncDone;
  await prisma.integrationConfig.updateMany({ where: { id }, data });
}
