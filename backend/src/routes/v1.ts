/**
 * `/api/v1` router.
 *
 * Every module mounts one router here. Versioning the prefix means a future breaking
 * change can ship as `/api/v2` alongside v1 rather than as a coordinated big-bang
 * release with the web client (Section 29).
 */
import { Router } from 'express';

import type { CreateAppOptions } from '../app.js';
import {
  createAcademicYearRouter,
  createClassSectionRouter,
  createDepartmentRouter,
  createLevelRouter,
  createProgramRouter,
  createTermRouter,
} from '../modules/academic/academic.routes.js';
import { createAuthRouter } from '../modules/auth/auth.routes.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import {
  createEnrollmentRouter,
  createGuardianLinkRouter,
  createGuardianRouter,
  createStudentRouter,
} from '../modules/students/student.routes.js';
import { createRoleRouter, createUserRouter } from '../modules/users/user.routes.js';

export function createApiV1Router(options: CreateAppOptions = {}): Router {
  const router = Router();

  router.use('/health', createHealthRouter(options.databaseProbe));
  router.use('/auth', createAuthRouter());
  router.use('/users', createUserRouter());
  router.use('/roles', createRoleRouter());

  // Academic structure: the periods, programmes and classes every later phase is
  // scoped by.
  router.use('/academic-years', createAcademicYearRouter());
  router.use('/terms', createTermRouter());
  router.use('/departments', createDepartmentRouter());
  router.use('/programs', createProgramRouter());
  router.use('/levels', createLevelRouter());
  router.use('/class-sections', createClassSectionRouter());

  // Students, the people responsible for them, and where they are placed.
  router.use('/students', createStudentRouter());
  router.use('/guardians', createGuardianRouter());
  router.use('/guardian-links', createGuardianLinkRouter());
  router.use('/enrolments', createEnrollmentRouter());

  // Mounted in later phases:
  //   /fees            Phase 4
  //   /payments, /reconciliation                                          Phase 5
  //   /receipts        Phase 6
  //   /reports         Phase 8
  //   /clearance       Phase 10
  //   /audit-logs      Phase 11

  return router;
}
