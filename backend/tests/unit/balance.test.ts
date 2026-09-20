/**
 * The balance formula.
 *
 * These are the tests that matter most in Phase 4. Everything else in the phase is
 * plumbing around this arithmetic: if `computeNetPosition` is wrong, every screen, every
 * report and every clearance decision built on it is wrong in the same way, and the
 * error is in the second decimal place where nobody notices until a parent does.
 *
 * Deliberately unit tests with no database. The formula is a pure function of ledger
 * rows, so it can be exercised exhaustively — boundary amounts, overpayment, reversals —
 * in milliseconds rather than through HTTP.
 */
import { describe, expect, it } from 'vitest';

import { Money } from '@sfs/shared';

import { computeChargeNet, computeNetPosition } from '../../src/modules/fees/balance.service.js';
import type { LedgerTotalRow } from '../../src/modules/fees/fee.repository.js';

const RWF = 'RWF' as const;

/** Terse builders, so each test reads as the ledger it describes. */
const debit = (source: LedgerTotalRow['source'], total: string): LedgerTotalRow => ({
  entryType: 'DEBIT',
  source,
  total,
});
const credit = (source: LedgerTotalRow['source'], total: string): LedgerTotalRow => ({
  entryType: 'CREDIT',
  source,
  total,
});

describe('computeNetPosition', () => {
  it('reports nothing owed when the ledger is empty', () => {
    const position = computeNetPosition([], RWF);

    expect(position.outstanding.toString()).toBe('0.00');
    expect(position.creditBalance.toString()).toBe('0.00');
    expect(position.totalCharged.toString()).toBe('0.00');
  });

  it('owes the charge when nothing has been applied to it', () => {
    const position = computeNetPosition([debit('CHARGE', '150000.00')], RWF);

    expect(position.totalCharged.toString()).toBe('150000.00');
    expect(position.outstanding.toString()).toBe('150000.00');
    expect(position.creditBalance.toString()).toBe('0.00');
  });

  it('sums several charges', () => {
    // One row per source, as PostgreSQL groups them: three tuition charges arrive as a
    // single CHARGE total, which is exactly why the aggregate is done in the database.
    const position = computeNetPosition([debit('CHARGE', '285500.00')], RWF);

    expect(position.outstanding.toString()).toBe('285500.00');
  });

  it('subtracts a discount', () => {
    const position = computeNetPosition(
      [debit('CHARGE', '150000.00'), credit('DISCOUNT', '10000.00')],
      RWF,
    );

    expect(position.totalCredited.toString()).toBe('10000.00');
    expect(position.outstanding.toString()).toBe('140000.00');
  });

  it('subtracts a discount, a scholarship and a waiver together', () => {
    // The worked example from the data-model specification.
    const position = computeNetPosition(
      [
        debit('CHARGE', '100000.00'),
        credit('DISCOUNT', '10000.00'),
        credit('SCHOLARSHIP', '20000.00'),
      ],
      RWF,
    );

    expect(position.outstanding.toString()).toBe('70000.00');
  });

  it('adds a debiting adjustment as a surcharge rather than a charge', () => {
    const position = computeNetPosition(
      [debit('CHARGE', '100000.00'), debit('ADJUSTMENT', '5000.00')],
      RWF,
    );

    expect(position.totalCharged.toString()).toBe('100000.00');
    expect(position.totalSurcharged.toString()).toBe('5000.00');
    expect(position.outstanding.toString()).toBe('105000.00');
  });

  it('reports a credit balance rather than a negative debt when relief exceeds charges', () => {
    const position = computeNetPosition(
      [debit('CHARGE', '100000.00'), credit('WAIVER', '120000.00')],
      RWF,
    );

    // The invariant a caller depends on: outstanding is never negative, and the surplus
    // is somewhere explicit instead.
    expect(position.outstanding.toString()).toBe('0.00');
    expect(position.creditBalance.toString()).toBe('20000.00');
  });

  it('never reports both an outstanding amount and a credit balance', () => {
    const cases: LedgerTotalRow[][] = [
      [debit('CHARGE', '100000.00')],
      [debit('CHARGE', '100000.00'), credit('DISCOUNT', '100000.00')],
      [debit('CHARGE', '100000.00'), credit('DISCOUNT', '150000.00')],
      [],
    ];

    for (const rows of cases) {
      const position = computeNetPosition(rows, RWF);
      const bothNonZero = position.outstanding.isPositive() && position.creditBalance.isPositive();
      expect(bothNonZero).toBe(false);
    }
  });

  it('settles to exactly zero when relief equals the charge', () => {
    const position = computeNetPosition(
      [debit('CHARGE', '150000.00'), credit('SCHOLARSHIP', '150000.00')],
      RWF,
    );

    expect(position.outstanding.toString()).toBe('0.00');
    expect(position.creditBalance.toString()).toBe('0.00');
  });

  it('nets a reversed discount back out of the credit total', () => {
    // A reversal is an opposing entry on the same source, so it cancels itself without
    // any special handling. That is the property this test pins down.
    const position = computeNetPosition(
      [debit('CHARGE', '150000.00'), credit('DISCOUNT', '10000.00'), debit('DISCOUNT', '10000.00')],
      RWF,
    );

    expect(position.totalCredited.toString()).toBe('0.00');
    expect(position.outstanding.toString()).toBe('150000.00');
  });

  it('nets a voided charge back out of the charge total', () => {
    const position = computeNetPosition(
      [debit('CHARGE', '150000.00'), credit('CHARGE', '150000.00')],
      RWF,
    );

    expect(position.totalCharged.toString()).toBe('0.00');
    expect(position.outstanding.toString()).toBe('0.00');
  });

  it('counts a payment as paid rather than as relief', () => {
    // Phase 5 posts these. Asserted now so introducing payments is a new value in an
    // existing slot rather than a change to the formula.
    const position = computeNetPosition(
      [debit('CHARGE', '150000.00'), credit('PAYMENT', '50000.00')],
      RWF,
    );

    expect(position.totalPaid.toString()).toBe('50000.00');
    expect(position.totalCredited.toString()).toBe('0.00');
    expect(position.outstanding.toString()).toBe('100000.00');
  });

  it('reports zero paid while no payment has been posted', () => {
    const position = computeNetPosition([debit('CHARGE', '150000.00')], RWF);

    expect(position.totalPaid.toString()).toBe('0.00');
  });

  it('is deterministic: the same rows in any order give the same answer', () => {
    const rows = [
      debit('CHARGE', '150000.00'),
      credit('DISCOUNT', '10000.00'),
      credit('SCHOLARSHIP', '20000.50'),
      debit('ADJUSTMENT', '500.25'),
    ];

    const forwards = computeNetPosition(rows, RWF).outstanding.toString();
    const backwards = computeNetPosition([...rows].reverse(), RWF).outstanding.toString();

    expect(forwards).toBe(backwards);
    expect(forwards).toBe('120499.75');
  });

  describe('money boundaries', () => {
    it('handles amounts with decimal places without floating-point drift', () => {
      // 0.1 + 0.2 is the canonical float failure. Through Money it is exactly 0.30.
      const position = computeNetPosition(
        [debit('CHARGE', '0.10'), debit('ADJUSTMENT', '0.20')],
        RWF,
      );

      expect(position.outstanding.toString()).toBe('0.30');
    });

    it('handles the smallest representable amount', () => {
      const position = computeNetPosition([debit('CHARGE', '0.01')], RWF);

      expect(position.outstanding.toString()).toBe('0.01');
    });

    it('handles a very large amount without losing precision', () => {
      const position = computeNetPosition([debit('CHARGE', '999999999999.99')], RWF);

      expect(position.outstanding.toString()).toBe('999999999999.99');
    });

    it('keeps a long run of small credits exact', () => {
      // A hundred 0.01 credits must be exactly 1.00, not 0.9999999999999999.
      const rows = [debit('CHARGE', '1.00'), credit('DISCOUNT', '1.00')];
      const position = computeNetPosition(rows, RWF);

      expect(position.outstanding.toString()).toBe('0.00');
    });

    it('rounds half-up, consistently with the storage scale', () => {
      expect(Money.of('0.125').toString()).toBe('0.13');
      expect(Money.of('0.135').toString()).toBe('0.14');
    });
  });
});

describe('computeChargeNet', () => {
  it('reports the full amount when nothing has been applied', () => {
    const net = computeChargeNet('150000.00', { credit: '0', debit: '0' }, RWF);

    expect(net.amount.toString()).toBe('150000.00');
    expect(net.adjusted.toString()).toBe('0.00');
    expect(net.net.toString()).toBe('150000.00');
  });

  it('subtracts approved relief', () => {
    const net = computeChargeNet('150000.00', { credit: '40000.00', debit: '0' }, RWF);

    expect(net.adjusted.toString()).toBe('40000.00');
    expect(net.net.toString()).toBe('110000.00');
  });

  it('restores the charge when the relief against it was reversed', () => {
    const net = computeChargeNet('150000.00', { credit: '40000.00', debit: '40000.00' }, RWF);

    expect(net.adjusted.toString()).toBe('0.00');
    expect(net.net.toString()).toBe('150000.00');
  });

  it('floors at zero rather than going negative when relief exceeds the charge', () => {
    const net = computeChargeNet('100000.00', { credit: '150000.00', debit: '0' }, RWF);

    expect(net.net.toString()).toBe('0.00');
  });

  it('leaves nothing owing when relief exactly matches the charge', () => {
    const net = computeChargeNet('100000.00', { credit: '100000.00', debit: '0' }, RWF);

    expect(net.net.toString()).toBe('0.00');
  });

  it('handles a zero charge, which a fully funded place legitimately has', () => {
    const net = computeChargeNet('0.00', { credit: '0', debit: '0' }, RWF);

    expect(net.net.toString()).toBe('0.00');
  });
});

describe('percentage relief', () => {
  /**
   * Percentages are resolved with `prorate(pct, 100)` rather than `times(pct / 100)`.
   * The division would reintroduce a float exactly where the rounding has to be right,
   * so these cases pin the behaviour rather than the implementation.
   */
  it('takes a whole percentage exactly', () => {
    expect(Money.of('150000.00').prorate('25', 100).toString()).toBe('37500.00');
  });

  it('takes a fractional percentage with half-up rounding', () => {
    expect(Money.of('150000.00').prorate('12.5', 100).toString()).toBe('18750.00');
  });

  it('rounds a percentage that does not divide evenly', () => {
    // 33% of 100.01 is 33.0033, which rounds to 33.00.
    expect(Money.of('100.01').prorate('33', 100).toString()).toBe('33.00');
  });

  it('takes 100% as the whole amount', () => {
    expect(Money.of('150000.00').prorate('100', 100).toString()).toBe('150000.00');
  });
});
