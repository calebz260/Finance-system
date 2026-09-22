/**
 * Payment finalisation: the one place a payment becomes money.
 *
 * Everything else in this module group leads here. A provider callback, a status query
 * and a bursar pressing Verify all arrive at `finalisePayment`, and they arrive with the
 * same shape, because the checks that guard crediting must not be able to differ
 * depending on who asked.
 *
 * ## The rule
 *
 * A payment becomes SUCCESSFUL, and posts its ledger CREDIT, in **one transaction**. If
 * any part fails, none of it happened. There is no state in which a payment reads as
 * successful and no balance reflects it, and none in which the ledger holds a credit for
 * a payment nobody verified.
 *
 * ## Why the amount is checked against the school's own record
 *
 * A confirmation says what a provider claims was taken. The payment row says what the
 * school asked for. Crediting the *claimed* figure would mean a compromised webhook
 * secret, or a provider bug, could credit any amount at all — and an under-collection
 * would silently write off the difference. So the two are compared for exact equality
 * and a mismatch is **parked, not resolved**: the payment moves to REQUIRES_REVIEW with
 * both figures recorded, and a person decides. Nothing is rounded, nothing is split,
 * nothing is adjusted to fit (Section 20).
 *
 * ## Why there are three independent defences against a double credit
 *
 * Duplicate delivery is the normal behaviour of payment providers, not an edge case, so
 * one defence is not enough:
 *
 *  1. `lockPayment` takes `SELECT ... FOR UPDATE`, so a second finaliser waits and then
 *     sees the first one's result rather than interleaving with it.
 *  2. The transition is a conditional UPDATE from the finalisable statuses only, so a
 *     loser matches zero rows and is told it lost instead of proceeding.
 *  3. `financial_entries_one_opening_per_payment` is a unique index, so even a caller
 *     that got past both would fail on the insert.
 *
 * The third exists because the first two are application behaviour and the third is not.
 * A future code path that forgets to lock still cannot double-credit.
 */
import { type CurrencyCode, ErrorCode, Money, type PaymentStatusValue } from '@sfs/shared';

import type { PaymentStatusChangeSource } from '../../generated/prisma/enums.js';
import { ConflictError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import { postEntry, reverseEntryFor } from '../fees/ledger.service.js';
import { isUniqueViolation, paymentRepository, type LockedPayment } from './payment.repository.js';
import { classifyTransition, FINALISABLE_STATUSES } from './payment.status.js';

const log = createLogger('payments.finalize');

/**
 * What is being offered as grounds for crediting.
 *
 * `confirmedAmount` is required. A caller with nothing to confirm has nothing to
 * finalise, and making the field optional would let "the provider did not say" reach the
 * comparison as a pass rather than as a reason to hold the payment.
 */
export interface FinalisationEvidence {
  readonly source: PaymentStatusChangeSource;
  /** The person accountable for the credit: the verifying bursar, or the payee's own
   *  verifier of record for a provider confirmation. */
  readonly actorUserId: string;
  /** Decimal string. Compared for exact equality against the payment amount. */
  readonly confirmedAmount: string;
  /** Null when the channel does not report one; then only the amount is compared. */
  readonly currency: string | null;
  readonly providerTransactionId: string | null;
  /** The attempt row to complete, when this came through a provider. */
  readonly transactionId: string | null;
  readonly note: string | null;
  /** A bank or provider reference to record against the payment, if newly learned. */
  readonly externalReference: string | null;
  /** Free-form context for the status-history row. Never secrets. */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export type FinalisationOutcome =
  /** Verified and credited by this call. */
  | {
      readonly kind: 'CREDITED';
      readonly paymentId: string;
      readonly ledgerEntryId: string;
      readonly amount: string;
    }
  /** Already successful. Nothing was written; the existing credit is the answer. */
  | {
      readonly kind: 'ALREADY_CREDITED';
      readonly paymentId: string;
      readonly ledgerEntryId: string | null;
    }
  /** Something did not add up. The payment is now REQUIRES_REVIEW. */
  | { readonly kind: 'HELD_FOR_REVIEW'; readonly paymentId: string; readonly reason: string }
  /** Not creditable from its current status. Nothing was written. */
  | {
      readonly kind: 'REJECTED';
      readonly paymentId: string;
      readonly status: PaymentStatusValue;
      readonly reason: string;
    };

/** A payment's currency as a `CurrencyCode`, for `Money`. */
function currencyOf(payment: LockedPayment): CurrencyCode {
  return payment.currency as CurrencyCode;
}

/** What the ledger line says on a statement. */
function describeEntry(payment: LockedPayment): string {
  const channel = payment.method.toLowerCase().replace(/_/g, ' ');
  return `Payment ${payment.reference} (${channel})`;
}

/**
 * Compare what is claimed against what the school asked for.
 *
 * Exact equality, deliberately. A tolerance would be a policy decision about how much
 * money the school is willing to lose per payment, and no such policy has been agreed —
 * so a difference of any size is a question for a person rather than an amount to absorb.
 */
function checkAmount(
  payment: LockedPayment,
  evidence: FinalisationEvidence,
): { ok: true } | { ok: false; reason: string } {
  const currency = currencyOf(payment);

  if (evidence.currency !== null && evidence.currency.toUpperCase() !== payment.currency) {
    return {
      ok: false,
      reason:
        `The confirmation is in ${evidence.currency.toUpperCase()} but the payment was ` +
        `accepted in ${payment.currency}. No conversion is applied.`,
    };
  }

  if (!Money.isValid(evidence.confirmedAmount, currency)) {
    return { ok: false, reason: 'The confirmed amount was not a usable decimal amount.' };
  }

  const confirmed = Money.of(evidence.confirmedAmount, currency);
  const expected = Money.of(payment.amount, currency);

  if (!confirmed.equals(expected)) {
    return {
      ok: false,
      reason:
        `The confirmed amount ${confirmed.toString()} does not match the ${expected.toString()} ` +
        'this payment was accepted for.',
    };
  }

  return { ok: true };
}

/**
 * Move a payment to REQUIRES_REVIEW and commit that, inside the caller's transaction.
 *
 * Parking is a real outcome with a real write, not an early return. A mismatch that left
 * the payment PENDING would be re-processed by the provider's next retry and mismatch
 * again, forever, with nobody told.
 */
async function park(
  payment: LockedPayment,
  evidence: FinalisationEvidence,
  reason: string,
  tx: PrismaTransactionClient,
): Promise<FinalisationOutcome> {
  const moved = await paymentRepository.transitionPayment(
    { paymentId: payment.id, fromStatuses: ['PENDING', 'PROCESSING'] },
    { status: 'REQUIRES_REVIEW' },
    tx,
  );

  // Zero rows means it was already REQUIRES_REVIEW or moved on; either way the history
  // below still records that this confirmation was rejected, which is the useful fact.
  if (moved > 0) {
    await paymentRepository.appendStatusHistory(
      {
        schoolId: payment.schoolId,
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: 'REQUIRES_REVIEW',
        source: evidence.source,
        reason,
        actorUserId: evidence.source === 'USER' ? evidence.actorUserId : null,
        metadata: {
          expectedAmount: payment.amount,
          confirmedAmount: evidence.confirmedAmount,
          ...(evidence.currency !== null ? { confirmedCurrency: evidence.currency } : {}),
          ...(evidence.providerTransactionId !== null
            ? { providerTransactionId: evidence.providerTransactionId }
            : {}),
        },
      },
      tx,
    );
  }

  await record(
    {
      action: AuditAction.PAYMENT_HELD_FOR_REVIEW,
      entityType: AuditEntity.PAYMENT,
      entityId: payment.id,
      result: 'FAILURE',
      reason,
      schoolId: payment.schoolId,
      beforeState: { status: payment.status, amount: payment.amount, currency: payment.currency },
      afterState: {
        status: 'REQUIRES_REVIEW',
        confirmedAmount: evidence.confirmedAmount,
        confirmedCurrency: evidence.currency,
        ledgerEntryPosted: false,
      },
    },
    tx,
  );

  log.warn(
    {
      paymentId: payment.id,
      reference: payment.reference,
      expectedAmount: payment.amount,
      confirmedAmount: evidence.confirmedAmount,
      source: evidence.source,
    },
    'Payment held for review rather than credited',
  );

  return { kind: 'HELD_FOR_REVIEW', paymentId: payment.id, reason };
}

/**
 * Verify a payment and credit the ledger, or refuse to.
 *
 * Runs in its own transaction unless the caller supplies one. A caller that already holds
 * a transaction — the manual verification path, which also writes a verification note —
 * passes it in so the whole operation stays atomic.
 */
export async function finalisePayment(
  paymentId: string,
  evidence: FinalisationEvidence,
  existingTx?: PrismaTransactionClient,
): Promise<FinalisationOutcome> {
  const run = async (tx: PrismaTransactionClient): Promise<FinalisationOutcome> => {
    // 1. Lock. Everything below reads the state this lock froze.
    const payment = await paymentRepository.lockPayment(paymentId, tx);
    if (payment === null) {
      return {
        kind: 'REJECTED',
        paymentId,
        status: 'FAILED',
        reason: 'That payment no longer exists.',
      };
    }

    // 2. Already done? The commonest case in production, because providers retry.
    if (payment.status === 'SUCCESSFUL') {
      const opening = await paymentRepository.findOpeningPaymentEntry(payment.id, tx);
      log.info(
        { paymentId: payment.id, reference: payment.reference, source: evidence.source },
        'Repeat confirmation for an already-credited payment: no second credit posted',
      );
      return {
        kind: 'ALREADY_CREDITED',
        paymentId: payment.id,
        ledgerEntryId: opening?.id ?? null,
      };
    }

    // 3. Is the move legal at all? A terminal payment is never reopened.
    const verdict = classifyTransition(payment.status, 'SUCCESSFUL');
    if (verdict.kind === 'REJECTED') {
      return {
        kind: 'REJECTED',
        paymentId: payment.id,
        status: payment.status,
        reason: verdict.reason,
      };
    }

    // 4. Does what is claimed match what was accepted?
    const amountCheck = checkAmount(payment, evidence);
    if (!amountCheck.ok) {
      return park(payment, evidence, amountCheck.reason, tx);
    }

    const verifiedAt = new Date();

    // 5. Conditional transition. The database decides the race, not this function.
    const moved = await paymentRepository.transitionPayment(
      { paymentId: payment.id, fromStatuses: FINALISABLE_STATUSES },
      {
        status: 'SUCCESSFUL',
        completedAt: verifiedAt,
        verifiedByUserId: evidence.actorUserId,
        verifiedAt,
        verificationNote: evidence.note,
        ...(evidence.externalReference !== null
          ? { externalReference: evidence.externalReference }
          : {}),
      },
      tx,
    );

    if (moved === 0) {
      // Someone finalised it between the lock being released and here. Under the row lock
      // this should be unreachable; it is handled because "should be unreachable" is not a
      // guarantee, and reporting success for a write that did not happen is the one thing
      // this module must never do.
      const current = await paymentRepository.lockPayment(payment.id, tx);
      const opening = await paymentRepository.findOpeningPaymentEntry(payment.id, tx);
      if (current?.status === 'SUCCESSFUL') {
        return {
          kind: 'ALREADY_CREDITED',
          paymentId: payment.id,
          ledgerEntryId: opening?.id ?? null,
        };
      }
      return {
        kind: 'REJECTED',
        paymentId: payment.id,
        status: current?.status ?? payment.status,
        reason: 'This payment was changed by another request. Reload and check its status.',
      };
    }

    // 6. Preserve the transition.
    await paymentRepository.appendStatusHistory(
      {
        schoolId: payment.schoolId,
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: 'SUCCESSFUL',
        source: evidence.source,
        reason: evidence.note,
        actorUserId: evidence.source === 'USER' ? evidence.actorUserId : null,
        metadata: {
          confirmedAmount: evidence.confirmedAmount,
          ...(evidence.providerTransactionId !== null
            ? { providerTransactionId: evidence.providerTransactionId }
            : {}),
          ...(evidence.metadata ?? {}),
        },
      },
      tx,
    );

    // 7. The ledger. This is the only thing in Phase 5 that changes a balance.
    const amount = Money.of(payment.amount, currencyOf(payment));
    let ledgerEntryId: string;
    try {
      const entry = await postEntry(
        {
          schoolId: payment.schoolId,
          studentId: payment.studentId,
          academicYearId: payment.academicYearId,
          termId: payment.termId,
          entryType: 'CREDIT',
          amount,
          description: describeEntry(payment),
          ref: { source: 'PAYMENT', paymentId: payment.id },
          postedByUserId: evidence.actorUserId,
        },
        tx,
      );
      ledgerEntryId = entry.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The last line of defence fired: something already posted this payment's credit.
        // Roll the whole transaction back rather than commit a SUCCESSFUL payment whose
        // credit this call did not post — the existing credit is already correct, and a
        // retry will read it through the ALREADY_CREDITED path above.
        log.error(
          { paymentId: payment.id, reference: payment.reference },
          'A second ledger credit for one payment was refused by the unique index',
        );
        throw new ConflictError(
          'This payment has already been credited.',
          ErrorCode.DUPLICATE_PAYMENT,
          { cause: error, logContext: { paymentId: payment.id } },
        );
      }
      throw error;
    }

    // 8. Complete the provider attempt, where there was one.
    if (evidence.transactionId !== null) {
      await paymentRepository.updateTransaction(
        evidence.transactionId,
        {
          status: 'SUCCEEDED',
          confirmedAmount: evidence.confirmedAmount,
          completedAt: verifiedAt,
          ...(evidence.providerTransactionId !== null
            ? { providerTransactionId: evidence.providerTransactionId }
            : {}),
        },
        tx,
      );
    }

    // 9. Audit, in the same transaction, so a rollback takes the claim with it.
    await record(
      {
        action: AuditAction.PAYMENT_VERIFIED,
        entityType: AuditEntity.PAYMENT,
        entityId: payment.id,
        schoolId: payment.schoolId,
        actorUserId: evidence.actorUserId,
        ...(evidence.note !== null ? { reason: evidence.note } : {}),
        beforeState: { status: payment.status },
        afterState: {
          status: 'SUCCESSFUL',
          reference: payment.reference,
          studentId: payment.studentId,
          amount: payment.amount,
          currency: payment.currency,
          method: payment.method,
          verificationMethod: payment.verificationMethod,
          verificationSource: evidence.source,
          providerTransactionId: evidence.providerTransactionId,
          ledgerEntryId,
        },
      },
      tx,
    );

    log.info(
      {
        paymentId: payment.id,
        reference: payment.reference,
        ledgerEntryId,
        source: evidence.source,
      },
      'Payment verified and credited to the ledger',
    );

    return { kind: 'CREDITED', paymentId: payment.id, ledgerEntryId, amount: amount.toString() };
  };

  return existingTx === undefined ? prisma.$transaction(run) : run(existingTx);
}

/**
 * Record that a payment did not succeed.
 *
 * A first-class operation rather than a field update, because a failure is a transition
 * with a reason and a witness, and because it must be refused from a terminal status: a
 * late "failed" callback for a payment already credited must not undo it — that needs a
 * reversal, which a named person authorises.
 */
export async function failPayment(
  paymentId: string,
  args: {
    readonly reason: string;
    readonly source: PaymentStatusChangeSource;
    readonly actorUserId: string | null;
    readonly transactionId?: string | null;
    readonly failureCode?: string | null;
  },
): Promise<{ applied: boolean; status: PaymentStatusValue }> {
  return prisma.$transaction(async (tx) => {
    const payment = await paymentRepository.lockPayment(paymentId, tx);
    if (payment === null) return { applied: false, status: 'FAILED' as PaymentStatusValue };

    const verdict = classifyTransition(payment.status, 'FAILED');
    if (verdict.kind !== 'ALLOWED') {
      log.warn(
        { paymentId, fromStatus: payment.status, verdict: verdict.kind },
        'Refused to fail a payment from its current status',
      );
      return { applied: false, status: payment.status };
    }

    const completedAt = new Date();
    const moved = await paymentRepository.transitionPayment(
      { paymentId, fromStatuses: ['PENDING', 'PROCESSING', 'REQUIRES_REVIEW'] },
      { status: 'FAILED', completedAt, failureReason: args.reason },
      tx,
    );
    if (moved === 0) return { applied: false, status: payment.status };

    await paymentRepository.appendStatusHistory(
      {
        schoolId: payment.schoolId,
        paymentId,
        fromStatus: payment.status,
        toStatus: 'FAILED',
        source: args.source,
        reason: args.reason,
        actorUserId: args.actorUserId,
      },
      tx,
    );

    if (args.transactionId != null) {
      await paymentRepository.updateTransaction(
        args.transactionId,
        {
          status: 'FAILED',
          completedAt,
          failureMessage: args.reason,
          ...(args.failureCode != null ? { failureCode: args.failureCode } : {}),
        },
        tx,
      );
    }

    await record(
      {
        action: AuditAction.PAYMENT_VERIFICATION_FAILED,
        entityType: AuditEntity.PAYMENT,
        entityId: paymentId,
        result: 'FAILURE',
        reason: args.reason,
        schoolId: payment.schoolId,
        ...(args.actorUserId !== null ? { actorUserId: args.actorUserId } : {}),
        beforeState: { status: payment.status },
        afterState: { status: 'FAILED', ledgerEntryPosted: false },
      },
      tx,
    );

    return { applied: true, status: 'FAILED' as PaymentStatusValue };
  });
}

/**
 * Park a payment for a person to decide about.
 *
 * The third outcome, alongside credited and failed, and a real one: a confirmation that
 * does not add up, a bursar who wants a second opinion, a claim whose slip is unreadable.
 * The payment leaves the daily queue and appears in the review list, with the reason
 * recorded — which is the difference between a question somebody is going to answer and a
 * payment quietly left PENDING forever (Section 20).
 *
 * Shared by the bursar path and the webhook path, because a held payment must look the
 * same whichever of them held it.
 */
export async function holdPaymentForReview(
  paymentId: string,
  args: {
    readonly reason: string;
    readonly source: PaymentStatusChangeSource;
    readonly actorUserId: string | null;
    /** Optimistic-lock guard, when a person is acting on a screen they loaded earlier. */
    readonly expectedVersion?: number | undefined;
    readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  },
): Promise<{ applied: boolean; status: PaymentStatusValue }> {
  return prisma.$transaction(async (tx) => {
    const payment = await paymentRepository.lockPayment(paymentId, tx);
    if (payment === null) {
      throw new ConflictError('That payment no longer exists.', ErrorCode.CONFLICT);
    }

    const verdict = classifyTransition(payment.status, 'REQUIRES_REVIEW');
    if (verdict.kind === 'ALREADY_APPLIED') {
      // Already where it is being asked to go. Not an error: two people can notice the
      // same problem, and the second one should not be told they broke something.
      return { applied: false, status: payment.status };
    }
    if (verdict.kind === 'REJECTED') {
      throw new ConflictError(verdict.reason, ErrorCode.INVALID_STATE_TRANSITION, {
        logContext: { paymentId, fromStatus: payment.status },
      });
    }

    const moved = await paymentRepository.transitionPayment(
      {
        paymentId,
        fromStatuses: ['PENDING', 'PROCESSING'],
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
      },
      { status: 'REQUIRES_REVIEW' },
      tx,
    );

    if (moved === 0) {
      throw new ConflictError(
        'This payment was changed by someone else while you were looking at it. Reload and ' +
          'try again.',
        ErrorCode.RECORD_MODIFIED,
        { logContext: { paymentId, expectedVersion: args.expectedVersion ?? null } },
      );
    }

    await paymentRepository.appendStatusHistory(
      {
        schoolId: payment.schoolId,
        paymentId,
        fromStatus: payment.status,
        toStatus: 'REQUIRES_REVIEW',
        source: args.source,
        reason: args.reason,
        actorUserId: args.actorUserId,
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      },
      tx,
    );

    await record(
      {
        action: AuditAction.PAYMENT_HELD_FOR_REVIEW,
        entityType: AuditEntity.PAYMENT,
        entityId: paymentId,
        result: 'FAILURE',
        reason: args.reason,
        schoolId: payment.schoolId,
        ...(args.actorUserId !== null ? { actorUserId: args.actorUserId } : {}),
        beforeState: { status: payment.status },
        afterState: { status: 'REQUIRES_REVIEW', ledgerEntryPosted: false },
      },
      tx,
    );

    log.warn(
      { paymentId, reference: payment.reference, source: args.source, reason: args.reason },
      'Payment held for review',
    );

    return { applied: true, status: 'REQUIRES_REVIEW' as PaymentStatusValue };
  });
}

/**
 * Undo a credited payment by posting the opposing entry.
 *
 * **Nothing is deleted and nothing is edited.** The payment keeps its amount, its payer,
 * its verifier and the timestamp it was verified at; the ledger keeps the credit it
 * posted. A compensating DEBIT of the same amount is posted and linked to that credit
 * through `reversal_of_entry_id`, so the balance returns to where it was and the account
 * reads as two facts — it was paid, then it was not (Section 20, ADR-022).
 *
 * `REVERSED` and `REFUNDED` differ only in what happened in the world: a reversal means
 * the money never really arrived, a refund means it arrived and was sent back. The
 * accounting is identical, and conflating them would lose the distinction an auditor
 * needs.
 */
export async function reversePayment(
  paymentId: string,
  args: {
    readonly target: Extract<PaymentStatusValue, 'REVERSED' | 'REFUNDED'>;
    readonly reason: string;
    readonly actorUserId: string;
    readonly expectedVersion: number;
  },
): Promise<{ status: PaymentStatusValue; reversalPosted: boolean }> {
  return prisma.$transaction(async (tx) => {
    const payment = await paymentRepository.lockPayment(paymentId, tx);
    if (payment === null) {
      throw new ConflictError('That payment no longer exists.', ErrorCode.CONFLICT);
    }

    const verdict = classifyTransition(payment.status, args.target);
    if (verdict.kind !== 'ALLOWED') {
      throw new ConflictError(
        verdict.kind === 'ALREADY_APPLIED'
          ? `This payment is already ${args.target.toLowerCase()}.`
          : 'Only a successful payment can be reversed or refunded.',
        ErrorCode.INVALID_STATE_TRANSITION,
        { logContext: { paymentId, fromStatus: payment.status, target: args.target } },
      );
    }

    const reversedAt = new Date();
    const moved = await paymentRepository.transitionPayment(
      {
        paymentId,
        fromStatuses: ['SUCCESSFUL'],
        expectedVersion: args.expectedVersion,
      },
      {
        status: args.target,
        reversedByUserId: args.actorUserId,
        reversedAt,
        reversalReason: args.reason,
      },
      tx,
    );

    if (moved === 0) {
      throw new ConflictError(
        'This payment was changed by someone else while you were looking at it. Reload and try again.',
        ErrorCode.RECORD_MODIFIED,
        { logContext: { paymentId, expectedVersion: args.expectedVersion } },
      );
    }

    await paymentRepository.appendStatusHistory(
      {
        schoolId: payment.schoolId,
        paymentId,
        fromStatus: 'SUCCESSFUL',
        toStatus: args.target,
        source: 'USER',
        reason: args.reason,
        actorUserId: args.actorUserId,
      },
      tx,
    );

    // The opposing entry. Returns false when there is no live credit to undo, which
    // would mean a SUCCESSFUL payment with no ledger effect — impossible through
    // `finalisePayment`, and worth knowing about loudly rather than passing over.
    const reversalPosted = await reverseEntryFor(
      { source: 'PAYMENT', paymentId },
      {
        description:
          args.target === 'REFUNDED'
            ? `Refund of payment ${payment.reference}`
            : `Reversal of payment ${payment.reference}`,
        postedByUserId: args.actorUserId,
      },
      tx,
    );

    if (!reversalPosted) {
      log.error(
        { paymentId, reference: payment.reference, target: args.target },
        'A successful payment had no live ledger credit to reverse',
      );
    }

    await record(
      {
        action:
          args.target === 'REFUNDED' ? AuditAction.PAYMENT_REFUNDED : AuditAction.PAYMENT_REVERSED,
        entityType: AuditEntity.PAYMENT,
        entityId: paymentId,
        reason: args.reason,
        schoolId: payment.schoolId,
        actorUserId: args.actorUserId,
        beforeState: {
          status: 'SUCCESSFUL',
          amount: payment.amount,
          currency: payment.currency,
          reference: payment.reference,
        },
        afterState: {
          status: args.target,
          // Named explicitly so the audit trail records that the original survived.
          originalPaymentRetained: true,
          compensatingEntryPosted: reversalPosted,
        },
      },
      tx,
    );

    log.info(
      { paymentId, reference: payment.reference, target: args.target, reversalPosted },
      'Payment undone by a compensating ledger entry',
    );

    return { status: args.target, reversalPosted };
  });
}
