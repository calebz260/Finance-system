/**
 * Development seed.
 *
 * Phase 0 has no domain tables yet, so this script only proves the seeding pipeline is
 * wired (`npm run db:seed` -> tsx -> Prisma -> PostgreSQL). Phase 1 fills it with the
 * realistic development data set required by Section 37: a school, roles and
 * permissions, a test account per role, academic years and terms, classes, programmes,
 * students, parents, fee structures, and both online and manually verified payments.
 *
 * It must never contain real personal information, and it must refuse to run against a
 * production database.
 */
import { config } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { disconnectDatabase, prisma } from '../src/lib/prisma.js';

const log = logger.child({ module: 'seed' });

async function seed(): Promise<void> {
  if (config.isProduction) {
    throw new Error(
      'Refusing to seed: NODE_ENV is "production". Seed data is for development and test only.',
    );
  }

  log.info({ env: config.env }, 'Seeding database');

  // Confirms the connection and transaction path the Phase 1 seed will rely on.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1`;
  });

  log.info('Seed complete (no domain tables yet -- populated in Phase 1)');
}

try {
  await seed();
} catch (error) {
  log.error({ err: error }, 'Seeding failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
