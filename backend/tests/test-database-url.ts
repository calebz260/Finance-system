/**
 * The single definition of the integration-test database URL.
 *
 * Imported by both `vitest.config.ts` (which injects it into test workers) and
 * `tests/integration/global-setup.ts` (which migrates it before any worker starts).
 * Global setup runs in Vitest's main process, where `test.env` has not been applied, so
 * it cannot read the value from the environment the workers see — hence one module.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://sfs:sfs_local_dev_password@localhost:5544/school_finance_test?schema=public';
