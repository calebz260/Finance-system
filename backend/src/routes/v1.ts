/**
 * `/api/v1` router.
 *
 * Every module mounts one router here. Versioning the prefix means a future breaking
 * change can ship as `/api/v2` alongside v1 rather than as a coordinated big-bang
 * release with the web client (Section 29).
 */
import { Router } from 'express';

import type { CreateAppOptions } from '../app.js';
import { createHealthRouter } from '../modules/health/health.routes.js';

export function createApiV1Router(options: CreateAppOptions = {}): Router {
  const router = Router();

  router.use('/health', createHealthRouter(options.databaseProbe));

  // Mounted in later phases:
  //   /auth            Phase 2
  //   /users, /roles   Phase 2
  //   /students, /parents, /classes, /programs, /academic-years, /terms   Phase 3
  //   /fees            Phase 4
  //   /payments, /reconciliation                                          Phase 5
  //   /receipts        Phase 6
  //   /reports         Phase 8
  //   /clearance       Phase 10
  //   /audit-logs      Phase 11

  return router;
}
