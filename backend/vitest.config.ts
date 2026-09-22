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

  // The sandbox payment provider is a local simulator that settles only on a correctly
  // signed callback, which is what makes the whole provider path — initiation, signature
  // verification, replay rejection, finalisation — testable without a bank or real money.
  // `config/env.ts` refuses to start with it enabled in production.
  PAYMENT_SANDBOX_ENABLED: 'true',
  // An obviously-fake fixture, like the two above, and long enough for the 32-character
  // floor the configuration enforces.
  PAYMENT_SANDBOX_WEBHOOK_SECRET: 'test-only-sandbox-webhook-secret-0123456789abcdef',
  // Tight, so the replay-rejection case can be written without faking timers: a callback
  // signed two minutes ago is already outside it.
  PAYMENT_WEBHOOK_MAX_SKEW_SECONDS: '60',

  // Proof-of-payment uploads land under the backend's own `var/` directory, which is
  // git-ignored and outside anything servable. A test that uploads a bank slip writes a
  // real file, because "the bytes came back unchanged" is part of what is being tested.
  UPLOAD_STORAGE_PATH: './var/test-uploads',
  UPLOAD_MAX_BYTES: String(2 * 1024 * 1024),
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
