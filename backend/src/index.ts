/**
 * Process entry point.
 *
 * Responsibilities kept here and nowhere else: verify the database is reachable before
 * accepting traffic, bind the HTTP server, and shut down gracefully. Graceful shutdown
 * matters for a financial system -- a SIGTERM in the middle of a payment write must let
 * the open transaction finish rather than tearing the connection down under it.
 */
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDatabase, disconnectDatabase } from './lib/prisma.js';

const log = logger.child({ module: 'bootstrap' });

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = createServer(app);

  // Slightly above typical load-balancer idle timeouts to avoid races on keep-alive.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // `env` and `version` are already on every log line via the logger's base fields.
  log.info(
    { port: config.server.port, host: config.server.host },
    'School Finance System API listening',
  );

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      log.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'Shutting down');

    // Hard deadline: if in-flight work does not drain, exit anyway rather than hanging
    // a deployment forever.
    const forceExit = setTimeout(() => {
      log.error(
        { timeoutMs: config.server.shutdownTimeoutMs },
        'Graceful shutdown timed out; forcing exit',
      );
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    forceExit.unref();

    server.close((closeError) => {
      void (async (): Promise<void> => {
        if (closeError !== undefined && closeError !== null) {
          log.error({ err: closeError }, 'Error while closing HTTP server');
        }
        try {
          await disconnectDatabase();
        } catch (error) {
          log.error({ err: error }, 'Error while disconnecting from the database');
        }
        clearTimeout(forceExit);
        log.info('Shutdown complete');
        process.exit(closeError !== undefined && closeError !== null ? 1 : 0);
      })();
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  // An unhandled rejection or uncaught exception leaves the process in an unknown state.
  // Log it loudly and exit so the supervisor restarts a clean instance.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'Failed to start the API');
  process.exit(1);
});
