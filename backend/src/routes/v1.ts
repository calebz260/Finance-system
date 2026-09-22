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
import {
  createChargeRouter,
  createChargeRunRouter,
  createFeeCategoryRouter,
  createFeeStructureRouter,
  createReliefRouter,
  createScholarshipRouter,
  createStudentFinancialRouter,
} from '../modules/fees/fee.routes.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import { createPaymentRouter } from '../modules/payments/payment.routes.js';
import { createReconciliationRouter } from '../modules/reconciliation/reconciliation.routes.js';
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
  //
  // The financial router mounts under the same prefix so a student's balance reads as
  // `/students/:id/balance`. Declared before the student router: both match
  // `/students/...`, and Express runs them in order until one handles the path.
  router.use('/students', createStudentFinancialRouter());
  router.use('/students', createStudentRouter());
  router.use('/guardians', createGuardianRouter());
  router.use('/guardian-links', createGuardianLinkRouter());
  router.use('/enrolments', createEnrollmentRouter());

  // What the school charges, and what each student therefore owes.
  router.use('/fee-categories', createFeeCategoryRouter());
  router.use('/fee-structures', createFeeStructureRouter());
  router.use('/charges', createChargeRouter());
  router.use('/charge-runs', createChargeRunRouter());
  router.use('/scholarships', createScholarshipRouter());
  router.use('/relief', createReliefRouter());

  // What has actually been paid, and what the school believes about it.
  //
  // `/payment-webhooks` is deliberately **not** here: a provider callback needs the raw
  // request body to verify its signature, so it is mounted in `app.ts` ahead of the JSON
  // parser. Putting it in this router would place it after the parser and make the
  // signature check meaningless.
  router.use('/payments', createPaymentRouter());

  // The school's own bank account against its own records: what arrived that nobody has
  // attributed, and what was claimed that the bank has no record of.
  router.use('/reconciliation', createReconciliationRouter());

  // Mounted in later phases:
  //   /receipts        Phase 6
  //   /reports         Phase 8
  //   /clearance       Phase 10
  //   /audit-logs      Phase 11

  return router;
}
