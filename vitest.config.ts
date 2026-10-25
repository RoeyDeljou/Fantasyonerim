import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'apps/api/tests/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: true,
    // apps/api integration tests share one Postgres test database.
    fileParallelism: false,
  },
});
