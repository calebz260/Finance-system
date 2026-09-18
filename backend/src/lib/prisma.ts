/**
 * Database access.
 *
 * One PrismaClient for the whole process, sharing one connection pool. Prisma 7 connects
 * through an explicit driver adapter, which is why the pool is configured here rather
 * than through query-string parameters.
 *
 * Pool sizing note: the ceiling that matters is PostgreSQL's `max_connections`, shared by
 * every application instance. `PRISMA_POOL_MAX` per instance times the number of
 * instances must stay comfortably under it, or a deployment will start refusing
 * connections under exactly the load where payments matter most.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { config } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createLogger } from './logger.js';

const log = createLogger('database');

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: config.database.url,
    // Bounded pool: enough for concurrent bursar activity, small enough that several
    // instances cannot exhaust the server.
    max: 10,
    // Recycle idle connections so a restarted database does not leave stale sockets.
    idleTimeoutMillis: 30_000,
    // Fail fast rather than queueing a request behind an unreachable database.
    connectionTimeoutMillis: 10_000,
    application_name: config.app.name,
  });

  const client = new PrismaClient({
    adapter,
    // Queries are logged as events (not to stdout) so they pass through the redacting
    // logger. `query` stays off unless explicitly enabled: query text plus parameters
    // would put student and payment data into the logs.
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  client.$on('warn', (event) => {
    log.warn({ target: event.target }, event.message);
  });
  client.$on('error', (event) => {
    log.error({ target: event.target }, event.message);
  });

  return client;
}

/**
 * In development, `tsx watch` re-evaluates modules on every change. Caching the client on
 * the global object stops each reload from opening another pool and exhausting
 * PostgreSQL's connection slots.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __sfsPrisma?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.__sfsPrisma ?? createPrismaClient();

if (!config.isProduction) {
  globalForPrisma.__sfsPrisma = prisma;
}

/**
 * Verify the database is reachable before the server starts accepting traffic.
 * Failing here is intentional: an API that is up but cannot read a balance should not be
 * taking payment requests.
 */
export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    log.info('Database connection established');
  } catch (error) {
    // The connection string can contain credentials, so only the driver's message is
    // logged -- never the URL.
    log.error(
      { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
      'Could not connect to the database',
    );
    throw new Error(
      'Database connection failed. Check DATABASE_URL and that PostgreSQL is running (npm run db:up).',
      { cause: error },
    );
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  log.info('Database connection closed');
}
