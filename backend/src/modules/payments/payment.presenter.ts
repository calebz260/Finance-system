/**
 * Turning payment rows into the shapes the API promises.
 *
 * Kept apart from the services because three of them — initiation, verification and the
 * read endpoints — return the same `PaymentSummary`, and a payment that reads differently
 * depending on which endpoint produced it is a bug the client discovers at the worst
 * possible moment: while someone is looking at a figure and deciding whether it is right.
 *
 * Two rules live here rather than in the controllers:
 *
 *  - **Money leaves as a decimal string, always.** `Money.fromDatabase` re-reads the
 *    exact NUMERIC the column holds; nothing is ever passed through a JavaScript number
 *    on the way out (ADR-001).
 *  - **A parent is shown their payment; a bursar is shown the school's plumbing.**
 *    `toPaymentDetail` takes `asStaff` and withholds the provider attempts from a
 *    self-service reader. Their own payment, its status, its history and their own
 *    uploaded proof are theirs to see; which reference the school sent a provider, and
 *    what that provider answered, is not (Section 22).
 */
import {
  type CurrencyCode,
  type FinancialEntrySummary,
  Money,
  type PaymentDetail,
  type PaymentEvidenceSummary,
  type PaymentStatusHistoryEntry,
  type PaymentSummary,
  type PaymentTransactionSummary,
} from '@sfs/shared';

import type {
  PaymentEvidenceRecord,
  PaymentRecord,
  PaymentStatusHistoryRecord,
  PaymentTransactionRecord,
} from './payment.repository.js';

/** `First Last`, or null when the relation is not set. */
function actorName(actor: { firstName: string; lastName: string } | null): string | null {
  return actor === null ? null : `${actor.firstName} ${actor.lastName}`;
}

export function toPaymentSummary(payment: PaymentRecord): PaymentSummary {
  const currency = payment.currency;

  return {
    id: payment.id,
    reference: payment.reference,
    studentId: payment.studentId,
    studentNumber: payment.student.studentId,
    studentName: `${payment.student.firstName} ${payment.student.lastName}`,
    amount: Money.fromDatabase(payment.amount, currency as CurrencyCode).toString(),
    currency,
    method: payment.method,
    verificationMethod: payment.verificationMethod,
    providerKey: payment.providerKey,
    status: payment.status,
    academicYearId: payment.academicYearId,
    academicYearName: payment.academicYear.name,
    termId: payment.termId,
    termName: payment.term?.name ?? null,
    payerName: payment.payerName,
    externalReference: payment.externalReference,
    failureReason: payment.failureReason,
    // `initiatedBy` is a required relation, so the fallback is unreachable; it is here
    // because the projection types it as nullable and inventing a name would be worse
    // than admitting the row could not be read.
    initiatedByName: actorName(payment.initiatedBy) ?? 'Unknown',
    initiatedAt: payment.initiatedAt.toISOString(),
    completedAt: payment.completedAt?.toISOString() ?? null,
    verifiedByName: actorName(payment.verifiedBy),
    verifiedAt: payment.verifiedAt?.toISOString() ?? null,
    reversedByName: actorName(payment.reversedBy),
    reversedAt: payment.reversedAt?.toISOString() ?? null,
    reversalReason: payment.reversalReason,
    // The opening credit, selected with the payment. Null until it is verified, which is
    // the only thing that posts one.
    ledgerEntryId: payment.entries[0]?.id ?? null,
    evidenceCount: payment._count.evidence,
    version: payment.version,
  };
}

export function toTransactionSummary(
  transaction: PaymentTransactionRecord,
): PaymentTransactionSummary {
  const currency = transaction.currency as CurrencyCode;

  return {
    id: transaction.id,
    providerKey: transaction.providerKey,
    internalReference: transaction.internalReference,
    providerTransactionId: transaction.providerTransactionId,
    requestedAmount: Money.fromDatabase(transaction.requestedAmount, currency).toString(),
    confirmedAmount:
      transaction.confirmedAmount === null
        ? null
        : Money.fromDatabase(transaction.confirmedAmount, currency).toString(),
    currency: transaction.currency,
    status: transaction.status,
    failureCode: transaction.failureCode,
    failureMessage: transaction.failureMessage,
    initiatedAt: transaction.initiatedAt.toISOString(),
    completedAt: transaction.completedAt?.toISOString() ?? null,
  };
}

export function toStatusHistoryEntry(
  history: PaymentStatusHistoryRecord,
): PaymentStatusHistoryEntry {
  return {
    id: history.id,
    fromStatus: history.fromStatus,
    toStatus: history.toStatus,
    source: history.source,
    reason: history.reason,
    actorName: actorName(history.actor),
    occurredAt: history.occurredAt.toISOString(),
  };
}

/**
 * Evidence, without anything that would let it be fetched other than through the
 * authenticated endpoint.
 *
 * `storageKey` is deliberately absent. It is the path on the server's disk; publishing it
 * would turn an authorisation check into a guessing game.
 */
export function toEvidenceSummary(evidence: PaymentEvidenceRecord): PaymentEvidenceSummary {
  return {
    id: evidence.id,
    kind: evidence.kind,
    fileName: evidence.fileName,
    contentType: evidence.contentType,
    byteSize: evidence.byteSize,
    checksum: evidence.checksum,
    uploadedByName: actorName(evidence.uploadedBy) ?? 'Unknown',
    uploadedAt: evidence.uploadedAt.toISOString(),
    isCurrent: evidence.isCurrent,
  };
}

export function toPaymentDetail(args: {
  payment: PaymentRecord;
  transactions: readonly PaymentTransactionRecord[];
  statusHistory: readonly PaymentStatusHistoryRecord[];
  evidence: readonly PaymentEvidenceRecord[];
  entries: readonly FinancialEntrySummary[];
  asStaff: boolean;
}): PaymentDetail {
  return {
    payment: toPaymentSummary(args.payment),
    transactions: args.asStaff ? args.transactions.map(toTransactionSummary) : [],
    statusHistory: args.statusHistory.map(toStatusHistoryEntry),
    evidence: args.evidence.map(toEvidenceSummary),
    entries: args.entries,
  };
}
