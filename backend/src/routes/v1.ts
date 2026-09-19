/**
 * `/api/v1` router.
 *
 * Every module mounts one router here. Versioning the prefix means a future breaking
 * change can ship as `/api/v2` alongside v1 rather than as a coordinated big-bang
 * release with the web client (Section 29).
 */
import { Router } from 'express';

import type { CreateAppOptions } from '../app.js';
import { createAuthRouter } from '../modules/auth/auth.routes.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import { createRoleRouter, createUserRouter } from '../modules/users/user.routes.js';

export function createApiV1Router(options: CreateAppOptions = {}): Router {
  const router = Router();

  router.use('/health', createHealthRouter(options.databaseProbe));
  router.use('/auth', createAuthRouter());
  router.use('/users', createUserRouter());
  router.use('/roles', createRoleRouter());

  // Mounted in later phases:
  //   /students, /parents, /classes, /programs, /academic-years, /terms   Phase 3
  //   /fees            Phase 4
  //   /payments, /reconciliation                                          Phase 5
  //   /receipts        Phase 6
  //   /reports         Phase 8
  //   /clearance       Phase 10
  //   /audit-logs      Phase 11

  return router;
}
