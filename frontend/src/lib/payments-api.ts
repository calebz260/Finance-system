/**
 * Typed calls to the payment endpoints.
 *
 * Every monetary value crossing this boundary is a **string**, in both directions. The
 * browser formats amounts and never computes one — the figure a parent is asked to
 * confirm is the figure the server derived from the ledger (Section 13A, ADR-009).
 *
 * Two things here are specific to payments and worth reading before changing them:
 *
 *  - **Initiation and claims send an idempotency key.** A parent on a bad connection will
 *    tap Pay twice, and a browser will happily retry a request it never saw an answer to.
 *    The key is minted per attempt and reused across retries of *that* attempt, which is
 *    what makes the retry safe rather than expensive (Section 14).
 *  - **Evidence is uploaded through `uploadFile` and downloaded as a blob.** There is no
 *    URL for a stored document: the file comes from an endpoint that re-checks who is
 *    asking, so it is fetched with credentials and handed to the browser as a blob rather
 *    than linked to.
 */
import type {
  PaginatedResponse,
  PaymentDetail,
  PaymentEvidenceKindValue,
  PaymentEvidenceSummary,
  PaymentInitiationResult,
  PaymentMethodOption,
  PaymentMethodValue,
  PaymentProviderKeyValue,
  PaymentReversalResult,
  PaymentStatusValue,
  PaymentSummary,
  PaymentVerificationResult,
  PayableStudent,
} from '@sfs/shared';

import { api, downloadBlob, requestPaginated } from './api-client';
import { uploadFile } from './upload';

/**
 * A fresh idempotency key.
 *
 * `crypto.randomUUID` where it exists, which is every browser this application supports
 * over HTTPS. The fallback is not a security control — the key only has to be unique per
 * attempt — so a timestamp and a random suffix are sufficient where it is missing.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pay-${String(Date.now())}-${Math.random().toString(36).slice(2, 12)}`;
}

/* ------------------------------------------------------------------- reads */

export function listPaymentMethods(): Promise<readonly PaymentMethodOption[]> {
  return api.get<readonly PaymentMethodOption[]>('/api/v1/payments/methods');
}

export function listPayableStudents(): Promise<readonly PayableStudent[]> {
  return api.get<readonly PayableStudent[]>('/api/v1/payments/payable-students');
}

export interface PaymentFilters {
  readonly studentId?: string;
  readonly status?: PaymentStatusValue;
  readonly method?: PaymentMethodValue;
  readonly verificationMethod?: 'PROVIDER' | 'MANUAL';
  readonly providerKey?: PaymentProviderKeyValue;
  readonly search?: string;
  readonly initiatedFrom?: string;
  readonly initiatedTo?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export function listPayments(
  filters: PaymentFilters = {},
): Promise<PaginatedResponse<PaymentSummary>> {
  return requestPaginated<PaymentSummary>('/api/v1/payments', { query: { ...filters } });
}

export function getPayment(paymentId: string): Promise<PaymentDetail> {
  return api.get<PaymentDetail>(`/api/v1/payments/${paymentId}`);
}

/* -------------------------------------------------------------- initiation */

export interface InitiatePaymentBody {
  readonly studentId: string;
  readonly amount: string;
  readonly payerName: string;
  readonly payerPhone?: string;
  readonly payerEmail?: string;
  readonly method: PaymentMethodValue;
  readonly providerKey?: PaymentProviderKeyValue;
  readonly academicYearId?: string;
  readonly termId?: string | null;
  readonly notes?: string;
}

export function initiatePayment(
  body: InitiatePaymentBody,
  idempotencyKey: string,
): Promise<PaymentInitiationResult> {
  return api.post<PaymentInitiationResult>('/api/v1/payments', body, { idempotencyKey });
}

export interface RecordManualClaimBody extends InitiatePaymentBody {
  /** The bank or wallet reference the payer quotes. */
  readonly externalReference?: string;
}

export function recordManualClaim(
  body: RecordManualClaimBody,
  idempotencyKey: string,
): Promise<PaymentSummary> {
  return api.post<PaymentSummary>('/api/v1/payments/manual-claims', body, { idempotencyKey });
}

/* ------------------------------------------------ decisions on a payment */

export interface VerifyPaymentBody {
  readonly expectedVersion: number;
  readonly decision: 'CONFIRM' | 'REJECT' | 'HOLD';
  /** Required to confirm: what the statement or the cash actually shows. */
  readonly confirmedAmount?: string;
  readonly externalReference?: string;
  readonly note?: string;
  /** Required to reject or hold, and recorded permanently. */
  readonly reason?: string;
}

export function verifyPayment(
  paymentId: string,
  body: VerifyPaymentBody,
): Promise<PaymentVerificationResult> {
  return api.post<PaymentVerificationResult>(`/api/v1/payments/${paymentId}/verification`, body);
}

export function cancelPayment(
  paymentId: string,
  body: { expectedVersion: number; reason: string },
): Promise<PaymentSummary> {
  return api.post<PaymentSummary>(`/api/v1/payments/${paymentId}/cancel`, body);
}

export function reversePayment(
  paymentId: string,
  body: { expectedVersion: number; kind: 'REVERSAL' | 'REFUND'; reason: string },
): Promise<PaymentReversalResult> {
  return api.post<PaymentReversalResult>(`/api/v1/payments/${paymentId}/reversal`, body);
}

/* --------------------------------------------------------- proof of payment */

export function listEvidence(paymentId: string): Promise<readonly PaymentEvidenceSummary[]> {
  return api.get<readonly PaymentEvidenceSummary[]>(`/api/v1/payments/${paymentId}/evidence`);
}

export function uploadEvidence(
  paymentId: string,
  file: File,
  kind: PaymentEvidenceKindValue,
): Promise<PaymentEvidenceSummary> {
  return uploadFile<PaymentEvidenceSummary>(`/api/v1/payments/${paymentId}/evidence`, file, {
    kind,
  });
}

/**
 * Fetch a stored document for the browser to save.
 *
 * Returned as a blob rather than as a link because the endpoint requires the caller's own
 * bearer token: an `<a href>` would send no credentials and, if it did, would produce a
 * URL somebody could forward to a person with no right to the document.
 */
export function downloadEvidence(paymentId: string, evidenceId: string): Promise<Blob> {
  return downloadBlob(`/api/v1/payments/${paymentId}/evidence/${evidenceId}/file`);
}
