/**
 * Payment endpoints.
 *
 * Thin, like every controller here: HTTP in, service call, envelope out. Four things do
 * belong at this layer, though, because they are properties of the transport rather than
 * of the domain:
 *
 *  - **The idempotency key is a header, not a field.** It describes the request, not the
 *    payment, and a client that retries must be able to repeat the body byte for byte
 *    (Section 14).
 *  - **The upload is held in memory and never written by multer.** Where a file goes, and
 *    under what name, is decided by `lib/file-storage.ts` — not by whatever the browser
 *    called it.
 *  - **Evidence is streamed back from an authenticated endpoint** with
 *    `Content-Disposition: attachment` and a nosniff header, so a stored document cannot
 *    be rendered inline as anything other than what it is.
 *  - **A webhook reads the raw body.** The route is mounted before the JSON parser, so
 *    `req.body` is a Buffer here: a signature covers the bytes the provider sent, and
 *    re-serialising parsed JSON does not reproduce them.
 */
import type { Request, Response } from 'express';
import multer from 'multer';

import {
  IDEMPOTENCY_KEY_HEADER,
  type PaymentDetail,
  type PaymentEvidenceSummary,
  type PaymentInitiationResult,
  type PaymentMethodOption,
  type PaymentReversalResult,
  type PaymentSummary,
  type PaymentVerificationResult,
  type PayableStudent,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookAcknowledgement,
} from '@sfs/shared';

import { config } from '../../config/env.js';
import { PayloadTooLargeError, ValidationError } from '../../lib/errors.js';
import { ACCEPTED_UPLOAD_CONTENT_TYPES } from '../../lib/file-storage.js';
import {
  HttpStatus,
  resolvePagination,
  sendCreated,
  sendPaginated,
  sendSuccess,
} from '../../lib/http.js';
import { getRequestContext } from '../../lib/request-context.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { downloadEvidence, listEvidence, uploadEvidence } from './evidence.service.js';
import type {
  CancelPaymentBody,
  EvidenceParams,
  InitiatePaymentBody,
  ListPaymentsQuery,
  PaymentIdParams,
  RecordManualClaimBody,
  ReversePaymentBody,
  UploadEvidenceFields,
  VerifyPaymentBody,
  WebhookParams,
} from './payment.schema.js';
import {
  cancelPayment,
  getPayment,
  initiatePayment,
  listPayableStudents,
  listPaymentMethods,
  listPayments,
  recordManualClaim,
} from './payment.service.js';
import { reverseCreditedPayment, verifyPayment } from './verification.service.js';
import { processProviderCallback } from './webhook.service.js';

/**
 * The idempotency key, if the client sent one.
 *
 * Optional: a bursar taking cash at the desk has no reason to generate one, and requiring
 * it would make the simplest case the most fiddly. A key that is present is validated,
 * because a truncated or blank key that quietly became "no key" would turn a retry into a
 * second payment.
 */
function idempotencyKeyFrom(req: Request): string | null {
  const raw = req.header(IDEMPOTENCY_KEY_HEADER);
  if (raw === undefined) return null;

  const key = raw.trim();
  if (key === '') return null;

  if (key.length < 8 || key.length > 200) {
    throw new ValidationError(
      'An Idempotency-Key must be between 8 and 200 characters. A UUID is a good choice.',
      { fieldErrors: [{ path: 'header.idempotency-key', message: 'Unusable idempotency key.' }] },
    );
  }

  return key;
}

/* ------------------------------------------------------------------- reads */

/** `GET /payments/methods` — what the school can take, and what it cannot take today. */
export const listPaymentMethodsHandler = (_req: Request, res: Response): void => {
  sendSuccess(res, listPaymentMethods() satisfies readonly PaymentMethodOption[]);
};

/** `GET /payments/payable-students` — the parent portal's landing data. */
export const listPayableStudentsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  sendSuccess(res, (await listPayableStudents(principal)) satisfies readonly PayableStudent[]);
};

export const listPaymentsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListPaymentsQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listPayments(principal, query, pagination);

  sendPaginated(res, {
    items: result.items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: result.totalItems,
  });
};

export const getPaymentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: PaymentIdParams }>(req);

  sendSuccess(res, (await getPayment(principal, params.paymentId)) satisfies PaymentDetail);
};

/* -------------------------------------------------------------- initiation */

/**
 * `POST /payments`
 *
 * 201 for a payment this request created, 200 when an idempotency key replayed an
 * existing one. The distinction is in the status code as well as in `replayed`, so a
 * client that only looks at the code still behaves correctly.
 */
export const initiatePaymentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: InitiatePaymentBody }>(req);

  const result = (await initiatePayment(
    principal,
    body,
    idempotencyKeyFrom(req),
  )) satisfies PaymentInitiationResult;

  if (result.replayed) {
    sendSuccess(res, result);
    return;
  }
  sendCreated(res, result, `/api/v1/payments/${result.payment.id}`);
};

/**
 * `POST /payments/manual-claims`
 *
 * Records a payment the school has been told about. Credits nothing: only a bursar's
 * confirmation does that (ADR-003).
 */
export const recordManualClaimHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: RecordManualClaimBody }>(req);

  const payment = (await recordManualClaim(
    principal,
    body,
    idempotencyKeyFrom(req),
  )) satisfies PaymentSummary;

  sendCreated(res, payment, `/api/v1/payments/${payment.id}`);
};

/* ------------------------------------------------ decisions on a payment */

/** `POST /payments/:paymentId/verification` — confirm, reject or hold. */
export const verifyPaymentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: PaymentIdParams; body: VerifyPaymentBody }>(req);

  sendSuccess(
    res,
    (await verifyPayment(principal, params.paymentId, body)) satisfies PaymentVerificationResult,
  );
};

export const cancelPaymentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: PaymentIdParams; body: CancelPaymentBody }>(req);

  sendSuccess(
    res,
    (await cancelPayment(principal, params.paymentId, body)) satisfies PaymentSummary,
  );
};

/** `POST /payments/:paymentId/reversal` — a reversal or a refund, never a delete. */
export const reversePaymentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: PaymentIdParams; body: ReversePaymentBody }>(req);

  sendSuccess(
    res,
    (await reverseCreditedPayment(
      principal,
      params.paymentId,
      body,
    )) satisfies PaymentReversalResult,
  );
};

/* ------------------------------------------------------ proof of payment */

/**
 * Multer, configured to keep the upload in memory.
 *
 * The ceiling comes from configuration so a school on a poor connection can be given a
 * smaller one. `files: 1` because one document per request keeps the supersede rule
 * unambiguous: a request that replaced two kinds of evidence at once would have to
 * decide what "the current slip" means half way through.
 *
 * There is no `fileFilter` on the content type. The browser's claim is not what decides —
 * `storeUploadedFile` reads the magic bytes — and filtering on a header here would only
 * refuse honest clients while letting a mislabelled file through to the check that
 * actually matters.
 */
export const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 5 },
});

/** Translate multer's own failures into the shared envelope. */
export function translateEvidenceUploadError(error: unknown): unknown {
  if (!(error instanceof multer.MulterError)) return error;

  if (error.code === 'LIMIT_FILE_SIZE') {
    const limitMb = Math.floor(config.uploads.maxBytes / (1024 * 1024));
    return new PayloadTooLargeError(
      `That file is larger than the ${String(limitMb)} MB limit. A photo of the slip or a ` +
        'one-page PDF is what is expected.',
    );
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return new ValidationError('Attach exactly one file, in the "file" field.');
  }
  return new ValidationError('That upload could not be read.');
}

/** `POST /payments/:paymentId/evidence` */
export const uploadEvidenceHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: PaymentIdParams; body: UploadEvidenceFields }>(req);

  const file = req.file;
  if (file === undefined) {
    throw new ValidationError(
      `Attach the document in the "file" field. Accepted formats: ${ACCEPTED_UPLOAD_CONTENT_TYPES.join(', ')}.`,
    );
  }

  const created = (await uploadEvidence(principal, params.paymentId, {
    kind: body.kind,
    bytes: file.buffer,
    originalName: file.originalname,
    declaredContentType: file.mimetype === '' ? null : file.mimetype,
  })) satisfies PaymentEvidenceSummary;

  sendCreated(res, created, `/api/v1/payments/${params.paymentId}/evidence/${created.id}/file`);
};

export const listEvidenceHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: PaymentIdParams }>(req);

  sendSuccess(
    res,
    (await listEvidence(principal, params.paymentId)) satisfies readonly PaymentEvidenceSummary[],
  );
};

/**
 * `GET /payments/:paymentId/evidence/:evidenceId/file`
 *
 * Sent as an attachment, never inline. A bank slip that a browser renders in place is a
 * document the page's own origin can be persuaded to interpret; as a download it is just
 * bytes. The filename is quoted and was stripped of control characters and quotes when it
 * was stored, so it cannot forge a second header.
 */
export const downloadEvidenceHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: EvidenceParams }>(req);

  const file = await downloadEvidence(principal, params.paymentId, params.evidenceId);

  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', String(file.bytes.byteLength));
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Evidence is not a public asset, and an intermediate cache holding one family's bank
  // slip is a disclosure nobody chose.
  res.setHeader('Cache-Control', 'private, no-store');

  res.status(HttpStatus.OK).send(file.bytes);
};

/* ---------------------------------------------------------------- webhooks */

/**
 * `POST /payment-webhooks/:providerKey`
 *
 * Unauthenticated by design — a provider has no session — and authenticated *in fact* by
 * the signature over the raw body. The route is mounted before the JSON body parser, so
 * `req.body` is the exact Buffer that was received.
 */
export const paymentWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  const { params } = validated<{ params: WebhookParams }>(req);

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const acknowledgement = (await processProviderCallback({
    providerKey: params.providerKey,
    rawBody,
    // Only the two headers the verifier needs are passed on. Handing an adapter the whole
    // header bag would let one start depending on a cookie or an authorisation header,
    // neither of which means anything on a callback.
    headers: {
      [WEBHOOK_SIGNATURE_HEADER]: req.header(WEBHOOK_SIGNATURE_HEADER),
      [WEBHOOK_TIMESTAMP_HEADER]: req.header(WEBHOOK_TIMESTAMP_HEADER),
    },
    requestId: getRequestContext()?.requestId ?? null,
  })) satisfies WebhookAcknowledgement;

  sendSuccess(res, acknowledgement);
};
