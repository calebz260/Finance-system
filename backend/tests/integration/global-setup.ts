/**
 * Integration-suite global setup: applies migrations to the test database once, before
 * any test file runs.
 *
 * This is here so `npm test` works from a clean checkout without a separate "remember to
 * migrate the test database" step. `migrate deploy` (not `migrate dev`) is used
 * deliberately: it only applies committed migrations and never generates new ones, so a
 * test run cannot quietly invent a migration from an uncommitted schema change.
 *
 * It also means CI needs no extra step, and a drifted test database surfaces as a clear
 * migration error rather than as confusing query failures.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { TEST_DATABASE_URL } from '../test-database-url.js';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default function setup(): void {
  // Read from the shared module rather than the environment: global setup runs in
  // Vitest's main process, where the workers' `test.env` has not been applied.
  const databaseUrl = TEST_DATABASE_URL;

  // Refuse to migrate anything that is not obviously a test database, so a misconfigured
  // TEST_DATABASE_URL cannot reach development or production data.
  if (!/test|_ci\b|ci\?|ci$/.test(databaseUrl)) {
    throw new Error(
      `Refusing to migrate "${databaseUrl.replace(/\/\/[^@]*@/, '//***@')}" for tests. ` +
        'TEST_DATABASE_URL must point at a dedicated test database.',
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    // Windows resolves `npx` through a shim, which needs a shell.
    shell: process.platform === 'win32',
  });
}
