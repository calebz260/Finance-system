/**
 * `/reconciliation`.
 *
 * The permission split, which is the whole story of this module:
 *
 *  - **Looking** is `reconciliation.read`. That includes the preview, because previewing a
 *    file writes nothing: seeing what an import *would* do is not a privileged act, and
 *    making it one would push bursars into importing in order to find out.
 *  - **Importing** is `reconciliation.import_statement`. A statement is the bank's word
 *    against the school's, and a forged one would make unmatched money look reconciled.
 *  - **Deciding** — matching, unmatching, setting a line aside — is
 *    `reconciliation.perform`.
 *  - **Crediting** additionally needs `payment.verify_manual`, which the service checks,
 *    because matching a line and confirming a payment are two different claims and a
 *    school may well trust somebody with the first and not the second.
 *
 * Every write here requires a satisfied second factor. All three roles that reach these
 * routes are MFA-required in the matrix, so this is not an extra hurdle — it is the
 * guarantee that the session actually completed one.
 *
 * No self-service permission appears anywhere in this file. Reconciliation is the school's
 * view of its own bank account, and a parent has no business in it whatsoever.
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
  getStatementHandler,
  ignoreLineHandler,
  importStatementHandler,
  listLinesHandler,
  listStatementsHandler,
  matchLineHandler,
  previewStatementHandler,
  reconciliationSummaryHandler,
  statementUpload,
  translateStatementUploadError,
  unmatchLineHandler,
} from './reconciliation.controller.js';
import {
  ignoreLineSchema,
  importIdParamsSchema,
  importStatementFieldsSchema,
  lineIdParamsSchema,
  listImportsQuerySchema,
  listLinesQuerySchema,
  matchLineSchema,
  reconciliationSummaryQuerySchema,
  unmatchLineSchema,
} from './reconciliation.schema.js';

/** Wrap the upload middleware so multer's own errors become the shared envelope. */
function uploadStatementFile(): ReturnType<typeof statementUpload.single> {
  const handler = statementUpload.single('file');

  return (req, res, next) => {
    handler(req, res, (error: unknown) => {
      next(
        error === undefined || error === null ? undefined : translateStatementUploadError(error),
      );
    });
  };
}

export function createReconciliationRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  // Where reconciliation stands, from both sides: statement lines nobody has attributed,
  // and payments the bank has no record of.
  router.get(
    '/summary',
    requirePermission(PermissionKey.RECONCILIATION_READ),
    validate({ query: reconciliationSummaryQuerySchema }),
    reconciliationSummaryHandler,
  );

  // The worklist across every statement.
  router.get(
    '/lines',
    requirePermission(PermissionKey.RECONCILIATION_READ),
    validate({ query: listLinesQuerySchema }),
    listLinesHandler,
  );

  router.post(
    '/lines/:lineId/match',
    requirePermission(PermissionKey.RECONCILIATION_PERFORM),
    requireMfaSatisfied(),
    validate({ params: lineIdParamsSchema, body: matchLineSchema }),
    matchLineHandler,
  );

  router.post(
    '/lines/:lineId/unmatch',
    requirePermission(PermissionKey.RECONCILIATION_PERFORM),
    requireMfaSatisfied(),
    validate({ params: lineIdParamsSchema, body: unmatchLineSchema }),
    unmatchLineHandler,
  );

  router.post(
    '/lines/:lineId/ignore',
    requirePermission(PermissionKey.RECONCILIATION_PERFORM),
    requireMfaSatisfied(),
    validate({ params: lineIdParamsSchema, body: ignoreLineSchema }),
    ignoreLineHandler,
  );

  /* ------------------------------------------------------------- statements */

  // Declared before `/statements/:importId`, or "preview" is read as an id.
  router.post(
    '/statements/preview',
    requirePermission(PermissionKey.RECONCILIATION_READ),
    uploadStatementFile(),
    previewStatementHandler,
  );

  router.get(
    '/statements',
    requirePermission(PermissionKey.RECONCILIATION_READ),
    validate({ query: listImportsQuerySchema }),
    listStatementsHandler,
  );

  // The upload runs before validation, because the provider and account label arrive in
  // the multipart body and there is no body to validate until multer has parsed it.
  router.post(
    '/statements',
    requirePermission(PermissionKey.RECONCILIATION_IMPORT_STATEMENT),
    requireMfaSatisfied(),
    uploadStatementFile(),
    validate({ body: importStatementFieldsSchema }),
    importStatementHandler,
  );

  router.get(
    '/statements/:importId',
    requirePermission(PermissionKey.RECONCILIATION_READ),
    validate({ params: importIdParamsSchema }),
    getStatementHandler,
  );

  return router;
}
