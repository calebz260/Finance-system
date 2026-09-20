/**
 * `/fee-categories`, `/fee-structures`, `/charges`, `/charge-runs` and `/adjustments`.
 *
 * One file, because the permission story is one story and it is easier to review against
 * the matrix in `shared/src/authorization.ts` when the grants sit side by side. The
 * separations that matter, all of them already decided in Phase 1:
 *
 *  - **Configuring fees** is `fee_structure.manage`, held by a School Administrator and
 *    a Finance Manager. A Bursar reads structures but does not set prices.
 *  - **Raising a charge** is `charge.create`, held by a Bursar and a Finance Manager but
 *    *not* by a School Administrator — creating an obligation is a financial act, not a
 *    configuration one.
 *  - **Voiding a charge** is `charge.void`, Finance Manager only. A bursar who could
 *    void their own mistakes could also void an inconvenient debt.
 *  - **Requesting relief** is `adjustment.request`; **approving it** is
 *    `adjustment.approve`, which a Bursar deliberately does not hold. The person
 *    handling daily cash cannot write off what is owed.
 *
 * Every write here also requires a satisfied second factor. All four roles that reach
 * these routes are MFA-required in the matrix, so `requireMfaSatisfied` is not an extra
 * hurdle — it is the guarantee that the session actually completed one, which is what
 * makes a stolen password insufficient to move money.
 */
import { Router } from 'express';

import { PermissionKey } from '@sfs/shared';

import { authenticate } from '../../middleware/authenticate.js';
import {
  requireMfaSatisfied,
  requirePermission,
  requireUsablePassword,
} from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  addStructureItemHandler,
  applyChargeRunHandler,
  cancelReliefHandler,
  changeStructureStatusHandler,
  createCategoryHandler,
  createChargeHandler,
  createScholarshipHandler,
  createStructureHandler,
  decideReliefHandler,
  getCategoryHandler,
  getChargeHandler,
  getReliefHandler,
  getScholarshipHandler,
  getStructureHandler,
  getStudentBalanceHandler,
  getStudentFinancialsHandler,
  listCategoriesHandler,
  listChargesHandler,
  listReliefsHandler,
  listScholarshipsHandler,
  listStructuresHandler,
  previewChargeRunHandler,
  removeStructureItemHandler,
  requestReliefHandler,
  reverseReliefHandler,
  updateCategoryHandler,
  updateScholarshipHandler,
  updateStructureHandler,
  updateStructureItemHandler,
  voidChargeHandler,
} from './fee.controller.js';
import {
  addStructureItemSchema,
  cancelReliefSchema,
  categoryIdParamsSchema,
  changeStructureStatusSchema,
  chargeIdParamsSchema,
  chargeRunSchema,
  createCategorySchema,
  createChargeSchema,
  createScholarshipSchema,
  createStructureSchema,
  decideReliefSchema,
  listCategoriesQuerySchema,
  listChargesQuerySchema,
  listReliefsQuerySchema,
  listScholarshipsQuerySchema,
  listStructuresQuerySchema,
  reliefKindParamsSchema,
  reliefParamsSchema,
  requestReliefSchema,
  reverseReliefSchema,
  scholarshipIdParamsSchema,
  structureIdParamsSchema,
  structureItemParamsSchema,
  studentFinancialQuerySchema,
  studentIdParamsSchema,
  updateCategorySchema,
  updateScholarshipSchema,
  updateStructureItemSchema,
  updateStructureSchema,
  voidChargeSchema,
} from './fee.schema.js';

export function createFeeCategoryRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.FEE_STRUCTURE_READ),
    validate({ query: listCategoriesQuerySchema }),
    listCategoriesHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ body: createCategorySchema }),
    createCategoryHandler,
  );

  router.get(
    '/:categoryId',
    requirePermission(PermissionKey.FEE_STRUCTURE_READ),
    validate({ params: categoryIdParamsSchema }),
    getCategoryHandler,
  );

  router.patch(
    '/:categoryId',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: categoryIdParamsSchema, body: updateCategorySchema }),
    updateCategoryHandler,
  );

  return router;
}

export function createFeeStructureRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.FEE_STRUCTURE_READ),
    validate({ query: listStructuresQuerySchema }),
    listStructuresHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ body: createStructureSchema }),
    createStructureHandler,
  );

  router.get(
    '/:structureId',
    requirePermission(PermissionKey.FEE_STRUCTURE_READ),
    validate({ params: structureIdParamsSchema }),
    getStructureHandler,
  );

  router.patch(
    '/:structureId',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: structureIdParamsSchema, body: updateStructureSchema }),
    updateStructureHandler,
  );

  // Publishing is what makes a structure usable for generation, so it is its own route
  // rather than a field on the edit — an accidental PATCH should not start billing.
  router.put(
    '/:structureId/status',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: structureIdParamsSchema, body: changeStructureStatusSchema }),
    changeStructureStatusHandler,
  );

  router.post(
    '/:structureId/items',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: structureIdParamsSchema, body: addStructureItemSchema }),
    addStructureItemHandler,
  );

  router.patch(
    '/:structureId/items/:itemId',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: structureItemParamsSchema, body: updateStructureItemSchema }),
    updateStructureItemHandler,
  );

  router.delete(
    '/:structureId/items/:itemId',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: structureItemParamsSchema }),
    removeStructureItemHandler,
  );

  return router;
}

export function createChargeRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.CHARGE_READ),
    validate({ query: listChargesQuerySchema }),
    listChargesHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.CHARGE_CREATE),
    requireMfaSatisfied(),
    validate({ body: createChargeSchema }),
    createChargeHandler,
  );

  router.get(
    '/:chargeId',
    requirePermission(PermissionKey.CHARGE_READ),
    validate({ params: chargeIdParamsSchema }),
    getChargeHandler,
  );

  // Finance Manager only. A bursar who could void a charge could erase a debt they were
  // supposed to collect.
  router.post(
    '/:chargeId/void',
    requirePermission(PermissionKey.CHARGE_VOID),
    requireMfaSatisfied(),
    validate({ params: chargeIdParamsSchema, body: voidChargeSchema }),
    voidChargeHandler,
  );

  return router;
}

export function createChargeRunRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  // The preview writes nothing, so it needs only `charge.read`. Looking at what a run
  // would do is not a privileged act; doing it is.
  router.post(
    '/preview',
    requirePermission(PermissionKey.CHARGE_READ),
    validate({ body: chargeRunSchema }),
    previewChargeRunHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.CHARGE_CREATE),
    requireMfaSatisfied(),
    validate({ body: chargeRunSchema }),
    applyChargeRunHandler,
  );

  return router;
}

/**
 * `/relief/:kind` — discounts, scholarship awards, waivers and adjustments.
 *
 * One router over four record types, addressed by kind in the path. The alternative,
 * four near-identical routers, would make it easy for the permission on one of them to
 * drift from the other three — and the one that drifted would be the one that let a
 * bursar approve their own write-off.
 */
export function createReliefRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.ADJUSTMENT_READ),
    validate({ query: listReliefsQuerySchema }),
    listReliefsHandler,
  );

  router.post(
    '/:kind',
    requirePermission(PermissionKey.ADJUSTMENT_REQUEST),
    requireMfaSatisfied(),
    validate({ params: reliefKindParamsSchema, body: requestReliefSchema }),
    requestReliefHandler,
  );

  router.get(
    '/:kind/:reliefId',
    requirePermission(PermissionKey.ADJUSTMENT_READ),
    validate({ params: reliefParamsSchema }),
    getReliefHandler,
  );

  // The approval gate. `adjustment.approve` is held by a Finance Manager and not by a
  // Bursar, and the service additionally refuses to let anyone approve their own request.
  router.post(
    '/:kind/:reliefId/decision',
    requirePermission(PermissionKey.ADJUSTMENT_APPROVE),
    requireMfaSatisfied(),
    validate({ params: reliefParamsSchema, body: decideReliefSchema }),
    decideReliefHandler,
  );

  // Cancelling your own pending request needs only the permission to have made it.
  router.post(
    '/:kind/:reliefId/cancel',
    requirePermission(PermissionKey.ADJUSTMENT_REQUEST),
    requireMfaSatisfied(),
    validate({ params: reliefParamsSchema, body: cancelReliefSchema }),
    cancelReliefHandler,
  );

  router.post(
    '/:kind/:reliefId/reverse',
    requirePermission(PermissionKey.ADJUSTMENT_APPROVE),
    requireMfaSatisfied(),
    validate({ params: reliefParamsSchema, body: reverseReliefSchema }),
    reverseReliefHandler,
  );

  return router;
}

/**
 * `/scholarships` — the named award programmes.
 *
 * Configuration rather than money, so it sits with fee configuration:
 * `fee_structure.manage` to define a programme, `adjustment.read` to see the list when
 * making an award.
 */
export function createScholarshipRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.ADJUSTMENT_READ),
    validate({ query: listScholarshipsQuerySchema }),
    listScholarshipsHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ body: createScholarshipSchema }),
    createScholarshipHandler,
  );

  router.get(
    '/:scholarshipId',
    requirePermission(PermissionKey.ADJUSTMENT_READ),
    validate({ params: scholarshipIdParamsSchema }),
    getScholarshipHandler,
  );

  router.patch(
    '/:scholarshipId',
    requirePermission(PermissionKey.FEE_STRUCTURE_MANAGE),
    requireMfaSatisfied(),
    validate({ params: scholarshipIdParamsSchema, body: updateScholarshipSchema }),
    updateScholarshipHandler,
  );

  return router;
}

/**
 * Student-scoped financial reads, mounted under `/students`.
 *
 * `charge.read` rather than a balance-specific permission: a balance is a view over
 * charges, and anyone trusted to see the charges can necessarily add them up.
 */
export function createStudentFinancialRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/:studentId/balance',
    requirePermission(PermissionKey.CHARGE_READ),
    validate({ params: studentIdParamsSchema, query: studentFinancialQuerySchema }),
    getStudentBalanceHandler,
  );

  router.get(
    '/:studentId/financials',
    requirePermission(PermissionKey.CHARGE_READ),
    validate({ params: studentIdParamsSchema, query: studentFinancialQuerySchema }),
    getStudentFinancialsHandler,
  );

  return router;
}
