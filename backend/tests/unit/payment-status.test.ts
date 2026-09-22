/**
 * The payment status machine.
 *
 * Tested without a database because it is pure, and tested thoroughly because it is the
 * code that decides whether a payment may become successful — and therefore whether money
 * appears on a student's account.
 *
 * The properties asserted here are the ones that make a payment provider's ordinary
 * behaviour harmless: providers retry, deliver out of order, and deliver late. A status
 * machine that let a late message resurrect a failed payment would credit accounts that
 * were never paid.
 */
import { describe, expect, it } from 'vitest';

import {
  canTransitionPayment,
  isTerminalPaymentStatus,
  PAYMENT_STATUS_TRANSITIONS,
  paymentHasCredited,
  type PaymentStatusValue,
} from '@sfs/shared';

import { ConflictError } from '../../src/lib/errors.js';
import {
  assertTransition,
  classifyTransition,
  describe as describeStatus,
  isFinalisable,
  isLiveStatus,
} from '../../src/modules/payments/payment.status.js';

const ALL_STATUSES = Object.keys(PAYMENT_STATUS_TRANSITIONS) as PaymentStatusValue[];

const TERMINAL: readonly PaymentStatusValue[] = ['FAILED', 'CANCELLED', 'REVERSED', 'REFUNDED'];

describe('the transition table', () => {
  it('has an entry for every status, so no status is a dead end by omission', () => {
    for (const status of ALL_STATUSES) {
      expect(PAYMENT_STATUS_TRANSITIONS[status]).toBeDefined();
    }
    expect(ALL_STATUSES).toHaveLength(8);
  });

  it('never lets a payment leave a terminal state', () => {
    for (const status of TERMINAL) {
      expect(isTerminalPaymentStatus(status)).toBe(true);
      for (const target of ALL_STATUSES) {
        expect(canTransitionPayment(status, target)).toBe(false);
      }
    }
  });

  it('reaches SUCCESSFUL only from a live status', () => {
    const sources = ALL_STATUSES.filter((status) => canTransitionPayment(status, 'SUCCESSFUL'));
    expect([...sources].sort()).toEqual(['PENDING', 'PROCESSING', 'REQUIRES_REVIEW']);
  });

  it('undoes a successful payment only as a reversal or a refund', () => {
    expect([...PAYMENT_STATUS_TRANSITIONS.SUCCESSFUL].sort()).toEqual(['REFUNDED', 'REVERSED']);
  });

  it('refuses to cancel a payment the provider already has', () => {
    // Once a request is with a provider, the school does not get to decide the money did
    // not move. It waits for the confirmation or the failure.
    expect(canTransitionPayment('PROCESSING', 'CANCELLED')).toBe(false);
    expect(canTransitionPayment('PENDING', 'CANCELLED')).toBe(true);
  });

  it('counts exactly the statuses that have moved the ledger as having credited', () => {
    const credited = ALL_STATUSES.filter(paymentHasCredited);
    expect([...credited].sort()).toEqual(['REFUNDED', 'REVERSED', 'SUCCESSFUL']);
  });
});

describe('classifyTransition', () => {
  it('allows a legal move', () => {
    expect(classifyTransition('PENDING', 'PROCESSING')).toEqual({ kind: 'ALLOWED' });
  });

  it('reports a repeat of the status already held as already applied, not as an error', () => {
    // This is the commonest real case: a provider confirming a payment it already
    // confirmed. Treating it as a fault would make an ordinary retry policy look like an
    // outage; treating it as a fresh event would credit twice.
    expect(classifyTransition('SUCCESSFUL', 'SUCCESSFUL')).toEqual({ kind: 'ALREADY_APPLIED' });
  });

  it('rejects a move out of a terminal state and says why', () => {
    const verdict = classifyTransition('FAILED', 'SUCCESSFUL');
    expect(verdict.kind).toBe('REJECTED');
    if (verdict.kind === 'REJECTED') {
      expect(verdict.reason).toContain('already failed');
      expect(verdict.reason).toContain('does not reopen it');
    }
  });

  it('rejects an impossible move between live states', () => {
    const verdict = classifyTransition('REQUIRES_REVIEW', 'PROCESSING');
    expect(verdict.kind).toBe('REJECTED');
  });
});

describe('assertTransition', () => {
  it('passes a legal move silently', () => {
    expect(() => {
      assertTransition('PENDING', 'SUCCESSFUL');
    }).not.toThrow();
  });

  it('refuses a second click on a button that already did its job', () => {
    // A person, unlike a provider, should be told their action was already applied.
    expect(() => {
      assertTransition('CANCELLED', 'CANCELLED');
    }).toThrow(ConflictError);
  });

  it('refuses an illegal move', () => {
    expect(() => {
      assertTransition('REFUNDED', 'SUCCESSFUL');
    }).toThrow(ConflictError);
  });
});

describe('the status groupings finalisation relies on', () => {
  it('treats the three live statuses as finalisable and nothing else', () => {
    for (const status of ALL_STATUSES) {
      const live = status === 'PENDING' || status === 'PROCESSING' || status === 'REQUIRES_REVIEW';
      expect(isFinalisable(status)).toBe(live);
      expect(isLiveStatus(status)).toBe(live);
    }
  });

  it('describes every status in words a parent would recognise', () => {
    for (const status of ALL_STATUSES) {
      const described = describeStatus(status);
      expect(described).not.toBe('');
      // No enum values leaking into a sentence somebody has to read.
      expect(described).not.toContain('_');
      expect(described).toBe(described.toLowerCase());
    }
  });
});
