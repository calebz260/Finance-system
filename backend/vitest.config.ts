import { defineConfig } from 'vitest/config';

/**
 * Two test projects, because they have different costs and guarantees:
 *
 *  - `unit`        pure logic, no I/O, runs in parallel, milliseconds.
 *  - `integration` boots the real Express app and talks to a real PostgreSQL database.
 *                  Run serially (`fileParallelism: false`) so suites cannot interleave
 *                  transactions and truncations against the same schema.
 *
 * Integration tests point at a dedicated database (`TEST_DATABASE_URL`). A test run
 * truncates it, so it must never be the development or production database.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://sfs:sfs_local_dev_password@localhost:5544/school_finance_test?schema=public';

const sharedEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  // Silent by default: a passing suite should not print hundreds of log lines. Override
  // with LOG_LEVEL=debug when diagnosing a failure.
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
  LOG_PRETTY: 'false',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:4173',
  APP_VERSION: '0.1.0-test',
};

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          env: sharedEnv,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          env: sharedEnv,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
