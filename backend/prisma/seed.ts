/**
 * Seed entry point: `npm run db:seed --workspace @sfs/backend`.
 *
 * The logic lives in `prisma/seed/index.ts` so the integration tests can call
 * `seedDatabase()` directly instead of shelling out to this script.
 */
import { logger } from '../src/lib/logger.js';
import { disconnectDatabase } from '../src/lib/prisma.js';
import { describeSeedAccounts, seedDatabase } from './seed/index.js';

const log = logger.child({ module: 'seed' });

try {
  const summary = await seedDatabase();
  log.info({ schoolId: summary.schoolId, counts: summary.counts }, 'Database seeded');
  console.log(`\n${describeSeedAccounts()}\n`);
} catch (error) {
  log.error({ err: error }, 'Seeding failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
