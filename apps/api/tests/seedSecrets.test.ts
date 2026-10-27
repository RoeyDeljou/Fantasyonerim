import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encryptSecrets,
  ensureIntegrationRows,
  readSecrets,
  seedIntegrationSecrets,
} from '../src/integrations/store.js';
import { devSecretsKey } from '../src/secrets.js';
import { createTestPrisma, migrateTestDb, resetDb } from './helpers.js';

const prisma = createTestPrisma();
const key = devSecretsKey();

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  await ensureIntegrationRows(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('seedIntegrationSecrets', () => {
  it('stores env credentials encrypted and enables the integration when none are stored', async () => {
    const seeded = await seedIntegrationSecrets(prisma, key, {
      spotify: { clientId: 'env-id', clientSecret: 'env-secret' },
    });
    expect(seeded).toEqual(['spotify']);
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'spotify' } });
    expect(row.enabled).toBe(true);
    expect(row.secretsEnc).not.toContain('env-secret');
    expect(readSecrets(key, row)).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
  });

  it('never overwrites keys an admin already saved, and is a no-op on later boots', async () => {
    await prisma.integrationConfig.update({
      where: { id: 'spotify' },
      data: { secretsEnc: encryptSecrets(key, { clientId: 'console-id', clientSecret: 'console-secret' }) },
    });
    expect(
      await seedIntegrationSecrets(prisma, key, { spotify: { clientId: 'env', clientSecret: 'env' } }),
    ).toEqual([]);
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'spotify' } });
    expect(readSecrets(key, row).clientId).toBe('console-id');
  });

  it('does nothing without seeds', async () => {
    expect(await seedIntegrationSecrets(prisma, key, {})).toEqual([]);
  });
});
