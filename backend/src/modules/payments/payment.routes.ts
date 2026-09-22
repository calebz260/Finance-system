/**
 * `/payments` and `/payment-webhooks`.
 *
 * The permission story, side by side, because that is how it should be reviewed against
 * the matrix in `shared/src/authorization.ts`:
 *
 *  - **Reading** is `payment.read` for staff or `own.financials_read` for a family. Both
 *    get through the door; which records they then see is decided per request against the
 *    guardian link, in `payment.access.ts`.
 *  - **Starting a payment** is `payment.initiate` for staff or `own.payment_initiate` for
 *    a parent paying for their own child.
 *  - **Recording a claim** is `payment.record_manual_claim`, and a parent may also submit
 *    one for their own child with `own.payment_initiate` — that is the bank-slip path,
 *    and it credits nothing.
 *  - **Verifying** is `payment.verify_manual`, which a Bursar holds and a Registrar does
 *    not, and the service additionally refuses a verifier who submitted the claim.
 *  - **Reversing** is `payment.reverse`; **refunding** is `payment.refund`. The route
 *    admits either and the service enforces the one the request actually needs, because
 *    which of the two applies depends on the body.
 *
 * **MFA.** The three endpoints that move or unmake money — verification, reversal and
 * refund — require a satisfied second factor. Initiation, claims and evidence do not, and
 * that is deliberate rather than an omission: those are the endpoints a parent uses, no
 * parent role requires MFA, and gating them would make the payment path unusable for
 * exactly the people it exists for. None of them credits anything on its own.
 *
 * **The webhook router is separate** and carries no authentication at all: a provider has
 * no session. It is authenticated in fact by a signature over the raw request body, which
 * is why it is mounted in `app.ts` ahead of the JSON body parser — see the comment there.
 */
import { Router } from 'express';

import { PermissionKey } from '@sfs/shared';

import { authenticate } from '../../middleware/authenticate.js';
import {
  requireAnyPermission,
  requireMfaSatisfied,
  requirePermission,
  requireUsablePassword,
} from '../../middleware/authorize.js';
import { paymentRateLimiter, webhookRateLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import {
  cancelPaymentHandler,
  downloadEvidenceHandler,
  evidenceUpload,
  getPaymentHandler,
  initiatePaymentHandler,
  listEvidenceHandler,
  listPayableStudentsHandler,
  listPaymentMethodsHandler,
  listPaymentsHandler,
  paymentWebhookHandler,
  recordManualClaimHandler,
  reversePaymentHandler,
  translateEvidenceUploadError,
  uploadEvidenceHandler,
  verifyPaymentHandler,
} from './payment.controller.js';
import {
  cancelPaymentSchema,
  evidenceParamsSchema,
  initiatePaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamsSchema,
  recordManualClaimSchema,
  reversePaymentSchema,
  uploadEvidenceFieldsSchema,
  verifyPaymentSchema,
  webhookParamsSchema,
} from './payment.schema.js';

/**
 * Wrap the upload middleware so multer's own errors become the shared envelope rather
 * than an unhandled failure and a generic 500.
 */
function uploadEvidenceFile(): ReturnType<typeof evidenceUpload.single> {
  const handler = evidenceUpload.single('file');

  return (req, res, next) => {
    handler(req, res, (error: unknown) => {
      next(error === undefined || error === null ? undefined : translateEvidenceUploadError(error));
    });
  };
}

export function createPaymentRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  // Declared before `/:paymentId`, or "methods" is parsed as a payment id.

  // What the school can take. Read by the parent portal and by the bursar's own screen,
  // so it admits anyone who could start or record a payment.
  router.get(
    '/methods',
    requireAnyPermission(
      PermissionKey.PAYMENT_READ,
      PermissionKey.PAYMENT_INITIATE,
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
      PermissionKey.OWN_PAYMENT_INITIATE,
      PermissionKey.OWN_FINANCIALS_READ,
    ),
    listPaymentMethodsHandler,
  );

  // The parent portal's landing data: my children, and what each of them owes.
  router.get(
    '/payable-students',
    requirePermission(PermissionKey.OWN_FINANCIALS_READ),
    listPayableStudentsHandler,
  );

  // Rate-limited as well as authorised: a signed-in parent account is still a way to
  // spray payment records at the school, and the limiter bounds that without getting in
  // the way of anybody paying fees twice a term (Section 14).
  router.post(
    '/manual-claims',
    requireAnyPermission(
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
      PermissionKey.OWN_PAYMENT_INITIATE,
    ),
    paymentRateLimiter,
    validate({ body: recordManualClaimSchema }),
    recordManualClaimHandler,
  );

  router.get(
    '/',
    requireAnyPermission(PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ),
    validate({ query: listPaymentsQuerySchema }),
    listPaymentsHandler,
  );

  router.post(
    '/',
    requireAnyPermission(PermissionKey.PAYMENT_INITIATE, PermissionKey.OWN_PAYMENT_INITIATE),
    paymentRateLimiter,
    validate({ body: initiatePaymentSchema }),
    initiatePaymentHandler,
  );

  router.get(
    '/:paymentId',
    requireAnyPermission(PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ),
    validate({ params: paymentIdParamsSchema }),
    getPaymentHandler,
  );

  /* ------------------------------------------------- decisions on a payment */

  // The gate that credits the ledger. `payment.verify_manual` is sensitive in the
  // catalogue, and a satisfied second factor is required on top of it: a stolen password
  // must not be enough to mark money as received.
  router.post(
    '/:paymentId/verification',
    requirePermission(PermissionKey.PAYMENT_VERIFY_MANUAL),
    requireMfaSatisfied(),
    validate({ params: paymentIdParamsSchema, body: verifyPaymentSchema }),
    verifyPaymentHandler,
  );

  // Cancelling something that has not completed. Reachable by the payer, so no MFA gate:
  // it credits nothing and unmakes nothing.
  router.post(
    '/:paymentId/cancel',
    requireAnyPermission(
      PermissionKey.PAYMENT_INITIATE,
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
      PermissionKey.OWN_PAYMENT_INITIATE,
    ),
    validate({ params: paymentIdParamsSchema, body: cancelPaymentSchema }),
    cancelPaymentHandler,
  );

  // Undoing a credited payment. Either permission gets through the door; the service
  // checks the specific one the body asks for.
  router.post(
    '/:paymentId/reversal',
    requireAnyPermission(PermissionKey.PAYMENT_REVERSE, PermissionKey.PAYMENT_REFUND),
    requireMfaSatisfied(),
    validate({ params: paymentIdParamsSchema, body: reversePaymentSchema }),
    reversePaymentHandler,
  );

  /* ---------------------------------------------------- proof of payment */

  router.get(
    '/:paymentId/evidence',
    requireAnyPermission(PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ),
    validate({ params: paymentIdParamsSchema }),
    listEvidenceHandler,
  );

  // The upload runs before validation, because the `kind` field arrives in the multipart
  // body and there is no body to validate until multer has parsed it.
  router.post(
    '/:paymentId/evidence',
    requireAnyPermission(
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
      PermissionKey.OWN_PAYMENT_INITIATE,
    ),
    uploadEvidenceFile(),
    validate({ params: paymentIdParamsSchema, body: uploadEvidenceFieldsSchema }),
    uploadEvidenceHandler,
  );

  router.get(
    '/:paymentId/evidence/:evidenceId/file',
    requireAnyPermission(PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ),
    validate({ params: evidenceParamsSchema }),
    downloadEvidenceHandler,
  );

  return router;
}

/**
 * `/payment-webhooks/:providerKey`
 *
 * No `authenticate`, no permission, and that is not a gap: the request comes from a
 * provider, which has no account here. Its authenticity is established by the signature
 * over the raw body, verified by the adapter for the provider named in the path, and
 * every outcome — accepted, forged, replayed, unattributable — is recorded in
 * `payment_webhook_events` (Section 16).
 */
export function createPaymentWebhookRouter(): Router {
  const router = Router();

  // A high but finite ceiling. Forged and replayed callbacks are refused by signature
  // verification; the limiter only stops a flood from reaching that check, and from
  // filling `payment_webhook_events` with rejections faster than anybody can read them.
  router.post(
    '/:providerKey',
    webhookRateLimiter,
    validate({ params: webhookParamsSchema }),
    paymentWebhookHandler,
  );

  return router;
}
