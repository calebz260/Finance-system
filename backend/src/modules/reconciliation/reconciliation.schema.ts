/**
 * Request schemas for the reconciliation endpoints.
 *
 * Shape only, as everywhere else. Whether a line may be matched to a payment — same
 * school, same currency, same amount, neither already attributed elsewhere — is decided by
 * the service against the database, because not one of those questions can be answered by
 * looking at the request (Section 11).
 *
 * Two deliberate absences:
 *
 *  - **No `matchStatus` on a write.** A line's status is a consequence of a decision, not
 *    an input. Accepting one would be accepting "mark this reconciled".
 *  - **No amount on a match.** The amounts being compared are the ones already stored: the
 *    bank's and the school's. A client-supplied figure would be a third number with no
 *    authority behind it.
 */
import { z } from 'zod';

import {
  descriptionField,
  expectedVersionField,
  paginationQueryFields,
  reasonField,
  uuidField,
} from '../../lib/validation.js';

const providerKey = z.enum(['SANDBOX', 'BANK_OF_KIGALI', 'ZIGAMA_CSS', 'UMWARIMU_SACCO']);

const matchStatus = z.enum(['UNMATCHED', 'MATCHED', 'IGNORED', 'AMBIGUOUS']);

const direction = z.enum(['MONEY_IN', 'MONEY_OUT']);

/* ------------------------------------------------------------------ import */

/**
 * The fields accompanying a statement upload.
 *
 * Read from a multipart form, where every value arrives as a string, so this validates
 * strings rather than a parsed JSON body.
 *
 * `provider` is required: a statement line is matched against payments that claim to have
 * gone through the same institution, and a statement that did not say which bank it came
 * from would have to be matched against all of them.
 */
export const importStatementFieldsSchema = z.strictObject({
  provider: providerKey,
  /** What the bank calls the account. Shown to a bursar, never parsed. */
  accountLabel: z.string().trim().min(1).max(120).optional(),
  notes: descriptionField.optional(),
});
export type ImportStatementFields = z.infer<typeof importStatementFieldsSchema>;

/* ------------------------------------------------------------------- reads */

export const listImportsQuerySchema = z.strictObject({ ...paginationQueryFields });
export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;

export const importIdParamsSchema = z.strictObject({ importId: uuidField });
export type ImportIdParams = z.infer<typeof importIdParamsSchema>;

export const lineIdParamsSchema = z.strictObject({ lineId: uuidField });
export type LineIdParams = z.infer<typeof lineIdParamsSchema>;

export const listLinesQuerySchema = z.strictObject({
  ...paginationQueryFields,
  importId: uuidField.optional(),
  matchStatus: matchStatus.optional(),
  direction: direction.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type ListLinesQuery = z.infer<typeof listLinesQuerySchema>;

export const reconciliationSummaryQuerySchema = z.strictObject({
  importId: uuidField.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type ReconciliationSummaryQuery = z.infer<typeof reconciliationSummaryQuerySchema>;

/* ---------------------------------------------------------------- decisions */

/**
 * Attribute a line to a payment.
 *
 * `confirmPayment` is opt-in, and the service requires the verification permission for it
 * as well as the reconciliation one. Matching says "this line is that payment"; confirming
 * says "and therefore credit the account", which is a second, larger claim.
 */
export const matchLineSchema = z.strictObject({
  expectedVersion: expectedVersionField,
  paymentId: uuidField,
  /** Credit the payment as well as attributing the line. Defaults to attribution only. */
  confirmPayment: z.boolean().optional(),
  note: descriptionField.optional(),
});
export type MatchLineBody = z.infer<typeof matchLineSchema>;

export const unmatchLineSchema = z.strictObject({
  expectedVersion: expectedVersionField,
  reason: reasonField,
});
export type UnmatchLineBody = z.infer<typeof unmatchLineSchema>;

/** Setting a line aside needs a reason, and the database enforces that too. */
export const ignoreLineSchema = z.strictObject({
  expectedVersion: expectedVersionField,
  reason: reasonField,
});
export type IgnoreLineBody = z.infer<typeof ignoreLineSchema>;
