import { Router } from 'express';

import { config } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { HealthController } from './health.controller.js';
import { HealthService, type DatabaseProbe } from './health.service.js';

/**
 * Prisma adapter for the health service's `DatabaseProbe` port. `SELECT 1` is the
 * cheapest statement that still proves the connection pool can reach PostgreSQL.
 */
const prismaProbe: DatabaseProbe = {
  async ping(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;
  },
};

export function createHealthRouter(probe: DatabaseProbe = prismaProbe): Router {
  const service = new HealthService({
    database: probe,
    serviceName: config.app.name,
    version: config.app.version,
    environment: config.env,
  });
  const controller = new HealthController(service);

  const router = Router();
  router.get('/', controller.readiness);
  return router;
}

/** Unversioned probes for load balancers and container orchestrators. */
export function createProbeRouter(probe: DatabaseProbe = prismaProbe): Router {
  const service = new HealthService({
    database: probe,
    serviceName: config.app.name,
    version: config.app.version,
    environment: config.env,
  });
  const controller = new HealthController(service);

  const router = Router();
  router.get('/healthz', controller.liveness);
  router.get('/readyz', controller.readiness);
  return router;
}
