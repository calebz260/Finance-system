/**
 * Request schemas for the payment endpoints.
 *
 * What is validated here is *shape*. What a request is allowed to mean — whether this
 * caller may pay for that student, whether the amount clears the school's minimum,
 * whether the currency matches the account, whether the channel can actually collect — is
 * decided by the service against the database, because none of those questions can be
 * answered by looking at the request alone (Section 11).
 *
 * Two deliberate absences are worth naming, because their presence would be a
 * vulnerability rather than a convenience:
 *
 *  - **No `status` field anywhere.** A payment's status is derived from verification, so
 *    accepting one from a client would be accepting "mark this successful". Status moves
 *    only through the verification, cancellation and reversal endpoints, each with its own
 *    permission.
 *  - **No `accountId`, no `ledgerEntry`, no `reference`.** All three are server-assigned.
 *    A client that could choose the account could pay into someone else's.
 *
 * Every object is `strictObject`, so an unexpected field is a rejection rather than
 * something silently dropped — which is what stops a hopeful `{"status":"SUCCESSFUL"}`
 * from being ignored quietly instead of refused loudly.
 */
import { z } from 'zod';

import {
  currencyField,
  descriptionField,
  expectedVersionField,
  paginationQueryFields,
  positiveMoneyField,
  reasonField,
  uuidField,
} from '../../lib/validation.js';

const paymentMethod = z.enum(['MOBILE_MONEY', 'BANK_TRANSFER', 'BANK_DEPOSIT', 'CASH', 'CHEQUE']);

const providerKey = z.enum(['SANDBOX', 'BANK_OF_KIGALI', 'ZIGAMA_CSS', 'UMWARIMU_SACCO']);

const paymentStatus = z.enum([
  'PENDING',
  'PROCESSING',
  'SUCCESSFUL',
  'FAILED',
  'CANCELLED',
  'REQUIRES_REVIEW',
  'REVERSED',
  'REFUNDED',
]);

const verificationMethod = z.enum(['PROVIDER', 'MANUAL']);

const evidenceKind = z.enum(['BANK_SLIP', 'TRANSFER_CONFIRMATION', 'REMITTANCE_ADVICE', 'OTHER']);

/** The name on the statement line, or the person at the counter. */
const payerName = z
  .string()
  .trim()
  .min(2, 'The payer’s name is required.')
  .max(120, 'That name is too long.');

/**
 * Rwandan mobile numbers, permissively.
 *
 * Deliberately not a strict national format: a payer may hold a foreign number, and a
 * validator that rejects a real payer's real phone number costs the school a payment. The
 * provider is the authority on whether a number can be charged.
 */
const payerPhone = z
  .string()
  .trim()
  .min(7, 'That does not look like a phone number.')
  .max(20, 'That does not look like a phone number.')
  .regex(/^\+?[0-9 ()-]+$/, 'Use digits, spaces, brackets and hyphens only.');

const payerEmail = z.string().trim().toLowerCase().email('That is not a valid email address.');

/**
 * A bank or wallet reference the payer quotes.
 *
 * Not validated against a format, because every institution uses a different one and a
 * refused claim loses the evidence the bursar needs. Length-capped only.
 */
const externalReference = z
  .string()
  .trim()
  .min(1, 'A reference cannot be blank.')
  .max(100, 'That reference is too long.');

/**
 * The fields every way of paying shares.
 *
 * `currency` is optional and, when given, must equal the account's — the service refuses
 * a mismatch rather than converting (Section 21). Omitting it means "the account's
 * currency", which is the only currency the school accepts.
 *
 * `academicYearId` is optional and defaults to the school's current year. A ledger entry
 * must name a year, so a payment must; defaulting it server-side is what keeps the parent
 * screen from having to ask a question the school already knows the answer to.
 */
const paymentBase = {
  studentId: uuidField,
  amount: positiveMoneyField,
  currency: currencyField.optional(),
  payerName,
  payerPhone: payerPhone.optional(),
  payerEmail: payerEmail.optional(),
  academicYearId: uuidField.optional(),
  termId: uuidField.nullable().optional(),
  notes: descriptionField.optional(),
} as const;

/* ------------------------------------------------------------------ initiation */

/**
 * Start a provider-collected payment.
 *
 * `providerKey` is optional: the registry decides which adapter serves a channel, and a
 * client naming one the channel does not offer is refused. It is accepted at all only so
 * a school with two mobile-money providers can route deliberately.
 */
export const initiatePaymentSchema = z.strictObject({
  ...paymentBase,
  method: paymentMethod,
  providerKey: providerKey.optional(),
});
export type InitiatePaymentBody = z.infer<typeof initiatePaymentSchema>;

/**
 * Record a payment the school was told about but has not yet confirmed.
 *
 * Creates the claim PENDING. It credits nothing: only verification by an authorised
 * person does that, which is the property ADR-003 exists to protect.
 */
export const recordManualClaimSchema = z.strictObject({
  ...paymentBase,
  method: paymentMethod,
  /** Which institution the money went through, so a bursar knows which statement to read. */
  providerKey: providerKey.optional(),
  externalReference: externalReference.optional(),
});
export type RecordManualClaimBody = z.infer<typeof recordManualClaimSchema>;

/* ---------------------------------------------------------------- verification */

/**
 * A bursar's decision on a claim.
 *
 * `confirmedAmount` is **required** to confirm, and is deliberately not defaulted to the
 * claimed amount. The verifier is stating what the statement says, not agreeing with what
 * the payer typed; if the two differ, that difference is the whole point and the service
 * holds the payment for review rather than crediting either figure.
 */
export const verifyPaymentSchema = z
  .strictObject({
    expectedVersion: expectedVersionField,
    decision: z.enum(['CONFIRM', 'REJECT', 'HOLD']),
    /** Required for CONFIRM. What the statement or the cash actually shows. */
    confirmedAmount: positiveMoneyField.optional(),
    currency: currencyField.optional(),
    /** The statement or slip reference the verifier matched against. */
    externalReference: externalReference.optional(),
    note: descriptionField.optional(),
    /** Required for REJECT and HOLD, and recorded permanently. */
    reason: reasonField.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'CONFIRM' && value.confirmedAmount === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmedAmount'],
        message:
          'State the amount the statement shows. It is compared against the claim rather ' +
          'than assumed to match it.',
      });
    }
    if (value.decision !== 'CONFIRM' && value.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A reason is required, and it is recorded permanently.',
      });
    }
  });
export type VerifyPaymentBody = z.infer<typeof verifyPaymentSchema>;

/* ------------------------------------------------- cancellation and reversal */

export const cancelPaymentSchema = z.strictObject({
  expectedVersion: expectedVersionField,
  reason: reasonField,
});
export type CancelPaymentBody = z.infer<typeof cancelPaymentSchema>;

/**
 * Undo a credited payment.
 *
 * `kind` distinguishes the two cases, which are accounted for identically and mean
 * different things: a reversal is money that never really arrived, a refund is money that
 * arrived and was sent back. The reason is mandatory in both.
 */
export const reversePaymentSchema = z.strictObject({
  expectedVersion: expectedVersionField,
  kind: z.enum(['REVERSAL', 'REFUND']),
  reason: reasonField,
});
export type ReversePaymentBody = z.infer<typeof reversePaymentSchema>;

/* ---------------------------------------------------------------------- reads */

export const listPaymentsQuerySchema = z.strictObject({
  ...paginationQueryFields,
  studentId: uuidField.optional(),
  status: paymentStatus.optional(),
  method: paymentMethod.optional(),
  verificationMethod: verificationMethod.optional(),
  providerKey: providerKey.optional(),
  academicYearId: uuidField.optional(),
  termId: uuidField.optional(),
  /** Matches the payment reference, the payer name or the external reference. */
  search: z.string().trim().min(1).max(100).optional(),
  initiatedFrom: z.iso.date().optional(),
  initiatedTo: z.iso.date().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const paymentIdParamsSchema = z.strictObject({ paymentId: uuidField });
export type PaymentIdParams = z.infer<typeof paymentIdParamsSchema>;

export const evidenceParamsSchema = z.strictObject({
  paymentId: uuidField,
  evidenceId: uuidField,
});
export type EvidenceParams = z.infer<typeof evidenceParamsSchema>;

/**
 * The `kind` field accompanying an evidence upload.
 *
 * Read from a multipart form, where every value arrives as a string, so this validates a
 * string rather than a parsed body.
 */
export const uploadEvidenceFieldsSchema = z.strictObject({
  kind: evidenceKind,
});
export type UploadEvidenceFields = z.infer<typeof uploadEvidenceFieldsSchema>;

/* -------------------------------------------------------------------- webhooks */

/**
 * The provider a callback claims to be from.
 *
 * Part of the path rather than the body, so the signature is verified with the right
 * secret before the body is parsed at all — a body that has not been authenticated must
 * not be allowed to choose which key authenticates it.
 */
export const webhookParamsSchema = z.strictObject({ providerKey });
export type WebhookParams = z.infer<typeof webhookParamsSchema>;
