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
// `.js` specifier, resolved to the `.ts` source: it satisfies the backend's NodeNext
// typecheck and Vite's resolver alike.
import { TEST_DATABASE_URL } from './tests/test-database-url.js';

const sharedEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  // Silent by default: a passing suite should not print hundreds of log lines. Override
  // with LOG_LEVEL=debug when diagnosing a failure.
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
  LOG_PRETTY: 'false',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:4173',
  APP_VERSION: '0.1.0-test',

  // `JWT_ACCESS_SECRET` and `MFA_ENCRYPTION_KEY` have no defaults anywhere -- a default
  // signing key is a forgeable session -- so importing anything that reads the config
  // fails without them. These two are fixed, obviously-fake test fixtures rather than
  // generated values, so a failure is reproducible and a token minted in one test run
  // can be compared against another. They are not secrets and must never be deployed.
  JWT_ACCESS_SECRET: 'test-only-access-token-secret-0123456789abcdef',
  // 32 bytes of 0x74 ('t'), base64. The length is what AES-256-GCM requires.
  MFA_ENCRYPTION_KEY: 'dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHQ=',
  // Short lifetimes keep expiry-path tests fast without faking timers.
  MFA_CHALLENGE_TTL_MINUTES: '5',
  MAX_FAILED_LOGIN_ATTEMPTS: '5',
  ACCOUNT_LOCK_MINUTES: '15',
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
          // Applies committed migrations to the test database once, before any test file,
          // so `npm test` works from a clean checkout and in CI without an extra step.
          globalSetup: ['tests/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
