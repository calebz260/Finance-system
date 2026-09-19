/**
 * The single definition of the integration-test database URL.
 *
 * Imported by both `vitest.config.ts` (which injects it into test workers) and
 * `tests/integration/global-setup.ts` (which migrates it before any worker starts).
 * Global setup runs in Vitest's main process, where `test.env` has not been applied, so
 * it cannot read the value from the environment the workers see — hence one module.
 */
/**
 * `127.0.0.1` rather than `localhost`, deliberately. On Windows `localhost` resolves to
 * `::1` first, and Docker Desktop's published port advertises an IPv6 listener that does
 * not reliably forward -- which surfaces as an intermittent `P1001: Can't reach database
 * server` in global setup while the container reports healthy. Naming the IPv4 loopback
 * removes the resolution order from the equation on every platform.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://sfs:sfs_local_dev_password@127.0.0.1:5544/school_finance_test?schema=public';
