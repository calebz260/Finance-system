/**
 * The payment status machine.
 *
 * Pure, dependency-free and unit-tested, because this is the module that decides whether
 * a payment may become successful — and therefore whether money appears on a student's
 * account. The transition table itself lives in `@sfs/shared` so the browser renders
 * from the same rules the server enforces; this file is where those rules become
 * refusals.
 *
 * Two properties are load-bearing, and both are about repeated messages rather than
 * about the happy path:
 *
 *  - **A terminal status is final.** `FAILED`, `CANCELLED`, `REVERSED` and `REFUNDED`
 *    have no outgoing transitions, so a callback arriving late — after a timeout was
 *    recorded as a failure, or after a reversal — cannot resurrect the payment and
 *    credit it. This is the rule that makes a provider's retry policy harmless.
 *  - **A transition to the status already held is not an error and not a transition.**
 *    A duplicate callback reporting success for a payment that already succeeded is the
 *    normal behaviour of every payment provider. It must be recognised as a repeat and
 *    answered from the existing record, never treated as a fresh event and never
 *    rejected as a fault. `classifyTransition` is what tells those two cases apart.
 */
import {
  canTransitionPayment,
  ErrorCode,
  isTerminalPaymentStatus,
  type PaymentStatusValue,
} from '@sfs/shared';

import { ConflictError } from '../../lib/errors.js';

/**
 * Statuses from which a payment can still reach a successful outcome.
 *
 * Used as the `WHERE` clause of the conditional update that finalises a payment, so the
 * database decides the race rather than a check the application made a moment earlier.
 */
export const FINALISABLE_STATUSES: readonly PaymentStatusValue[] = [
  'PENDING',
  'PROCESSING',
  'REQUIRES_REVIEW',
];

/** Statuses that are still in flight: nothing has been credited and something may yet. */
export const LIVE_STATUSES: readonly PaymentStatusValue[] = [
  'PENDING',
  'PROCESSING',
  'REQUIRES_REVIEW',
];

export function isLiveStatus(status: PaymentStatusValue): boolean {
  return LIVE_STATUSES.includes(status);
}

export function isFinalisable(status: PaymentStatusValue): boolean {
  return FINALISABLE_STATUSES.includes(status);
}

export type TransitionVerdict =
  /** A legal move. Apply it. */
  | { readonly kind: 'ALLOWED' }
  /** Already there. Do nothing and report the existing state as the outcome. */
  | { readonly kind: 'ALREADY_APPLIED' }
  /** Not permitted from here. */
  | { readonly kind: 'REJECTED'; readonly reason: string };

/**
 * Decide what a requested transition means, without performing it.
 *
 * Separate from `assertTransition` because the two callers want different things from
 * the same decision: a user action wants an error it can show, while webhook processing
 * wants to distinguish "duplicate delivery" (answer 200 from the existing record) from
 * "the provider is telling us something impossible" (record it and park the payment).
 * Collapsing them would mean either 500-ing on an ordinary provider retry or silently
 * accepting a contradiction.
 */
export function classifyTransition(
  from: PaymentStatusValue,
  to: PaymentStatusValue,
): TransitionVerdict {
  if (from === to) return { kind: 'ALREADY_APPLIED' };

  if (canTransitionPayment(from, to)) return { kind: 'ALLOWED' };

  if (isTerminalPaymentStatus(from)) {
    return {
      kind: 'REJECTED',
      reason:
        `This payment is already ${describe(from)} and cannot change again. ` +
        'A later message about it does not reopen it.',
    };
  }

  return {
    kind: 'REJECTED',
    reason: `A payment that is ${describe(from)} cannot become ${describe(to)}.`,
  };
}

/**
 * Refuse an illegal transition outright.
 *
 * Used by the endpoints a person drives, where "already there" is not a duplicate
 * delivery to be absorbed but a second click on a button that has already done its job,
 * and saying so is more honest than silently reporting success.
 */
export function assertTransition(from: PaymentStatusValue, to: PaymentStatusValue): void {
  const verdict = classifyTransition(from, to);
  if (verdict.kind === 'ALLOWED') return;

  throw new ConflictError(
    verdict.kind === 'ALREADY_APPLIED'
      ? `This payment is already ${describe(to)}.`
      : verdict.reason,
    ErrorCode.INVALID_STATE_TRANSITION,
    { logContext: { fromStatus: from, toStatus: to } },
  );
}

/** A status in the words a bursar or parent would use. */
export function describe(status: PaymentStatusValue): string {
  switch (status) {
    case 'PENDING':
      return 'pending';
    case 'PROCESSING':
      return 'being processed';
    case 'SUCCESSFUL':
      return 'successful';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'REQUIRES_REVIEW':
      return 'held for review';
    case 'REVERSED':
      return 'reversed';
    case 'REFUNDED':
      return 'refunded';
  }
}
