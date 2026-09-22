/**
 * The manual verification workflow: claim → pending → a bursar confirms → the ledger.
 *
 * This is the path ADR-003 calls first-class, and for every channel the school currently
 * has it is the only path there is (docs/OPEN-QUESTIONS.md #1 and #2). It carries real
 * money, so the controls on it are the controls a school auditor would ask about:
 *
 *  - **A person, named, with a reason.** The verifier is recorded on the payment, in the
 *    status history and in the audit log, and a database check constraint refuses a
 *    SUCCESSFUL payment that is missing them. There is no system-verified payment.
 *  - **Separation of duties.** The bursar who submitted a claim may not be the one who
 *    confirms it, when the school has that setting on. Relaxable, because a small school
 *    may genuinely have one bursar — and the refusal is audited either way, so choosing
 *    to relax it is visible rather than invisible (Section 13B, OPEN-QUESTIONS #8).
 *  - **The statement figure, not the claimed figure.** `confirmedAmount` is what the
 *    verifier reads off the statement or counts in cash. It is compared for exact
 *    equality against what the payment was accepted for, and a difference parks the
 *    payment for review rather than crediting either number (Section 20).
 *
 * The crediting itself is `finalisePayment`, shared with the webhook path, because the
 * checks that guard a credit must not be able to differ depending on who asked.
 */
import {
  ErrorCode,
  type PaymentReversalResult,
  type PaymentStatusValue,
  type PaymentVerificationResult,
  PermissionKey,
} from '@sfs/shared';

import {
  ConflictError,
  DomainError,
  ForbiddenError,
  RecordModifiedError,
} from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import {
  failPayment,
  finalisePayment,
  holdPaymentForReview,
  reversePayment,
} from './payment.finalize.js';
import { toPaymentSummary } from './payment.presenter.js';
import { paymentRepository, type PaymentRecord } from './payment.repository.js';
import type { ReversePaymentBody, VerifyPaymentBody } from './payment.schema.js';
import { describe } from './payment.status.js';
import { loadReadablePayment } from './payment.service.js';

const log = createLogger('payments.verification');

/**
 * Whether this payment is one a person may decide about at all.
 *
 * A manual claim always is: that is what it was created for. A provider payment is not — with
 * two exceptions, and each of them exists because without it a payment would have nobody able
 * to resolve it (Section 20):
 *
 *  - **`REQUIRES_REVIEW`**, which is precisely the state a provider payment reaches when
 *    something did not add up. A parked payment nobody could close would sit there forever.
 *  - **`HOLD` on a `PROCESSING` payment.** A provider that accepted a request and then never
 *    answered leaves a payment in flight indefinitely: no callback is coming, and the payer is
 *    told their money is "being processed" for as long as anybody cares to look. A bursar may
 *    park it with a reason, which puts it in the review queue where it can then be confirmed
 *    against evidence or failed. Deliberately two steps rather than one — parking it is a
 *    statement that the provider went quiet, and crediting it is a separate claim about money
 *    having arrived.
 */
function assertVerifiable(payment: PaymentRecord, decision: VerifyPaymentBody['decision']): void {
  if (payment.verificationMethod === 'MANUAL') return;
  if (payment.status === 'REQUIRES_REVIEW') return;
  if (decision === 'HOLD' && payment.status === 'PROCESSING') return;

  throw new DomainError(
    ErrorCode.PRECONDITION_FAILED,
    payment.status === 'PROCESSING'
      ? 'This payment is with its provider. Hold it for review first if the provider has gone ' +
          'quiet; it cannot be confirmed by hand while it is still in flight.'
      : 'This payment is confirmed by its provider, not by hand. Only a payment held for ' +
          'review can be decided here.',
    {
      details: {
        verificationMethod: payment.verificationMethod,
        status: payment.status,
        decision,
      },
    },
  );
}

/**
 * Refuse a verifier who is confirming their own claim.
 *
 * Audited before it is refused, because "who tried to confirm their own payment" is
 * exactly the question a later investigation asks, and a refusal that left no trace would
 * make repeated attempts invisible.
 *
 * Takes the fields it uses rather than a whole payment row, so the reconciliation module —
 * which reads a narrower projection and reaches verification by matching a statement line —
 * enforces the identical rule rather than a second copy of it.
 */
export async function assertSeparationOfDuties(
  principal: Principal,
  payment: {
    readonly id: string;
    readonly schoolId: string;
    readonly reference: string;
    readonly initiatedByUserId: string;
    readonly amount: { toString: () => string };
  },
): Promise<void> {
  const policy = await paymentRepository.findSchoolPaymentPolicy(payment.schoolId);
  if (!policy.enforceVerificationSeparationOfDuties) return;
  if (payment.initiatedByUserId !== principal.userId) return;

  await record({
    action: AuditAction.MANUAL_CLAIM_SELF_VERIFICATION_BLOCKED,
    entityType: AuditEntity.PAYMENT,
    entityId: payment.id,
    result: 'FAILURE',
    schoolId: payment.schoolId,
    actorUserId: principal.userId,
    reason: 'The verifier submitted this claim, and the school enforces separation of duties.',
    metadata: { reference: payment.reference, amount: payment.amount.toString() },
  });

  throw new ForbiddenError(
    'You recorded this payment, so somebody else has to confirm it.',
    ErrorCode.AUTHORISATION_REQUIRED,
    { logContext: { paymentId: payment.id, userId: principal.userId } },
  );
}

/**
 * Guard against deciding a payment that has changed since it was put on screen.
 *
 * A read-then-check, deliberately, and not the thing that prevents a double credit — the
 * row lock and the conditional update inside `finalisePayment` do that. This exists so a
 * bursar who left the queue open for an hour is told the payment moved rather than acting
 * on what it used to say (Section 13).
 */
function assertUnchanged(payment: PaymentRecord, expectedVersion: number): void {
  if (payment.version === expectedVersion) return;

  throw new RecordModifiedError(
    'This payment changed while it was on screen. Reload the queue and look at it again.',
    { logContext: { paymentId: payment.id, expectedVersion, actualVersion: payment.version } },
  );
}

/**
 * A bursar's decision on a payment awaiting verification.
 *
 * `CONFIRM` credits the ledger, or parks the payment when the figures disagree. `REJECT`
 * fails it with a permanent reason. `HOLD` moves it to REQUIRES_REVIEW so somebody senior
 * looks at it — which is a real outcome, not an absence of one: the payment leaves the
 * daily queue and appears in the review list instead.
 */
export async function verifyPayment(
  principal: Principal,
  paymentId: string,
  input: VerifyPaymentBody,
): Promise<PaymentVerificationResult> {
  const payment = await loadReadablePayment(principal, paymentId);

  assertVerifiable(payment, input.decision);
  assertUnchanged(payment, input.expectedVersion);
  await assertSeparationOfDuties(principal, payment);

  switch (input.decision) {
    case 'CONFIRM':
      return confirm(principal, payment, input);
    case 'REJECT':
      return reject(principal, payment, input);
    case 'HOLD':
      return hold(principal, payment, input);
  }
}

/** Confirm against the statement, and credit if the figures agree. */
async function confirm(
  principal: Principal,
  payment: PaymentRecord,
  input: VerifyPaymentBody,
): Promise<PaymentVerificationResult> {
  // Guaranteed by the schema's refinement; asserted rather than defaulted, because
  // defaulting it to the claimed amount would quietly remove the comparison that is the
  // entire point of asking for it.
  if (input.confirmedAmount === undefined) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'State the amount the statement shows. It is compared against the claim rather than ' +
        'assumed to match it.',
    );
  }

  const outcome = await finalisePayment(payment.id, {
    source: 'USER',
    actorUserId: principal.userId,
    confirmedAmount: input.confirmedAmount,
    currency: input.currency ?? null,
    providerTransactionId: null,
    transactionId: null,
    note: input.note ?? null,
    externalReference: input.externalReference ?? null,
    metadata: { verifiedBy: 'bursar_confirmation' },
  });

  if (outcome.kind === 'CREDITED' || outcome.kind === 'ALREADY_CREDITED') {
    await record({
      action: AuditAction.MANUAL_CLAIM_VERIFIED,
      entityType: AuditEntity.PAYMENT,
      entityId: payment.id,
      schoolId: payment.schoolId,
      actorUserId: principal.userId,
      ...(input.note !== undefined ? { reason: input.note } : {}),
      metadata: {
        reference: payment.reference,
        confirmedAmount: input.confirmedAmount,
        // False on a repeat decision: the credit exists, but this call did not post it.
        creditPostedByThisCall: outcome.kind === 'CREDITED',
      },
    });
  }

  const reloaded = await reload(payment);

  switch (outcome.kind) {
    case 'CREDITED':
      log.info(
        {
          paymentId: payment.id,
          reference: payment.reference,
          verifiedByUserId: principal.userId,
        },
        'Manual payment claim verified and credited',
      );
      return {
        payment: toPaymentSummary(reloaded),
        outcome: 'CREDITED',
        ledgerEntryId: outcome.ledgerEntryId,
        message: `Payment ${payment.reference} is confirmed and the balance has been updated.`,
      };

    case 'ALREADY_CREDITED':
      return {
        payment: toPaymentSummary(reloaded),
        outcome: 'ALREADY_CREDITED',
        ledgerEntryId: outcome.ledgerEntryId,
        message: 'This payment was already confirmed. Nothing was credited twice.',
      };

    case 'HELD_FOR_REVIEW':
      return {
        payment: toPaymentSummary(reloaded),
        outcome: 'HELD_FOR_REVIEW',
        ledgerEntryId: null,
        message: outcome.reason,
      };

    case 'REJECTED':
      // The payment could not move from where it is. Reported as a conflict rather than
      // as a quiet no-op, because the verifier pressed Confirm and nothing happened.
      throw new ConflictError(outcome.reason, ErrorCode.INVALID_STATE_TRANSITION, {
        logContext: { paymentId: payment.id, status: outcome.status },
      });
  }
}

/** Refuse a claim: the money is not there, and the reason is kept for good. */
async function reject(
  principal: Principal,
  payment: PaymentRecord,
  input: VerifyPaymentBody,
): Promise<PaymentVerificationResult> {
  const reason = input.reason ?? 'The payment could not be matched to a statement.';

  const failed = await failPayment(payment.id, {
    reason,
    source: 'USER',
    actorUserId: principal.userId,
  });

  if (!failed.applied) {
    throw new ConflictError(
      `This payment is ${describe(failed.status)} and can no longer be rejected.`,
      ErrorCode.INVALID_STATE_TRANSITION,
      { logContext: { paymentId: payment.id, status: failed.status } },
    );
  }

  await record({
    action: AuditAction.MANUAL_CLAIM_REJECTED,
    entityType: AuditEntity.PAYMENT,
    entityId: payment.id,
    result: 'SUCCESS',
    schoolId: payment.schoolId,
    actorUserId: principal.userId,
    reason,
    metadata: { reference: payment.reference },
  });

  return {
    payment: toPaymentSummary(await reload(payment)),
    outcome: 'FAILED',
    ledgerEntryId: null,
    message: `Payment ${payment.reference} was rejected. The reason has been recorded.`,
  };
}

/** Park a claim for somebody with more authority, or more information. */
async function hold(
  principal: Principal,
  payment: PaymentRecord,
  input: VerifyPaymentBody,
): Promise<PaymentVerificationResult> {
  const reason = input.reason ?? 'Held for review.';

  // Delegated so a payment held by a bursar and one held by an unattributable callback
  // look identical afterwards: same status, same history row, same audit action.
  await holdPaymentForReview(payment.id, {
    reason,
    source: 'USER',
    actorUserId: principal.userId,
    expectedVersion: input.expectedVersion,
  });

  return {
    payment: toPaymentSummary(await reload(payment)),
    outcome: 'HELD_FOR_REVIEW',
    ledgerEntryId: null,
    message: `Payment ${payment.reference} is held for review.`,
  };
}

/* ------------------------------------------------------ reversal and refund */

/**
 * Undo a credited payment.
 *
 * The permission is checked here rather than only on the route, because which permission
 * applies depends on the body: reversing a payment that never really arrived and refunding
 * one that did are different acts with different consequences for the family, and a school
 * may well trust someone with one and not the other.
 *
 * Neither deletes anything. Both post a compensating ledger entry through
 * `reversePayment`, so the account reads as two facts rather than one that was edited
 * (Section 20, ADR-022).
 */
export async function reverseCreditedPayment(
  principal: Principal,
  paymentId: string,
  input: ReversePaymentBody,
): Promise<PaymentReversalResult> {
  const payment = await loadReadablePayment(principal, paymentId);
  assertUnchanged(payment, input.expectedVersion);

  const required =
    input.kind === 'REFUND' ? PermissionKey.PAYMENT_REFUND : PermissionKey.PAYMENT_REVERSE;

  if (!principal.permissions.has(required)) {
    throw new ForbiddenError(
      input.kind === 'REFUND'
        ? 'You do not have permission to refund a payment.'
        : 'You do not have permission to reverse a payment.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      { logContext: { paymentId, userId: principal.userId, required } },
    );
  }

  const target: Extract<PaymentStatusValue, 'REVERSED' | 'REFUNDED'> =
    input.kind === 'REFUND' ? 'REFUNDED' : 'REVERSED';

  const result = await reversePayment(paymentId, {
    target,
    reason: input.reason,
    actorUserId: principal.userId,
    expectedVersion: input.expectedVersion,
  });

  return {
    payment: toPaymentSummary(await reload(payment)),
    status: result.status,
    compensatingEntryPosted: result.reversalPosted,
    message:
      target === 'REFUNDED'
        ? `Payment ${payment.reference} is recorded as refunded, and the balance has been adjusted back.`
        : `Payment ${payment.reference} is reversed, and the balance has been adjusted back.`,
  };
}

/** Re-read a payment after a write, falling back to what we already hold. */
async function reload(payment: PaymentRecord): Promise<PaymentRecord> {
  return (await paymentRepository.findPaymentById(payment.id)) ?? payment;
}
