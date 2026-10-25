// Drops and re-applies every migration on the test database (TEST_DATABASE_URL).
import { execFileSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://fant:fant@localhost:5432/fantasyonerim_test';
execFileSync('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed', '--skip-generate'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
