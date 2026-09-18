import { describe, expect, it } from 'vitest';

import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  MONEY_MAX,
  MONEY_STORAGE_SCALE,
  Money,
  MoneyError,
  rwf,
} from '../src/money.js';

describe('Money construction', () => {
  it('defaults to the school currency', () => {
    expect(Money.of('1000').currency).toBe(DEFAULT_CURRENCY);
    expect(DEFAULT_CURRENCY).toBe('RWF');
  });

  it('serialises to a fixed-scale decimal string', () => {
    expect(rwf('1000').toString()).toBe('1000.00');
    expect(rwf(0).toString()).toBe('0.00');
    expect(rwf('-250.5').toString()).toBe('-250.50');
  });

  it('crosses the API boundary as a string, never a JSON number', () => {
    const payload = JSON.stringify({ outstandingBalance: rwf('125000') });
    expect(payload).toBe('{"outstandingBalance":"125000.00"}');
  });

  it('accepts strings, numbers, bigints and other Money instances', () => {
    expect(Money.of('45000.25').toString()).toBe('45000.25');
    expect(Money.of(45000.25).toString()).toBe('45000.25');
    expect(Money.of(45000n).toString()).toBe('45000.00');
    expect(Money.of(rwf('45000.25')).toString()).toBe('45000.25');
  });

  it('accepts a Decimal-like object such as a value read back from Prisma', () => {
    const prismaLike = {
      toFixed: (places: number) => (123.5).toFixed(places),
      toString: () => '123.5',
    };
    expect(Money.fromDatabase(prismaLike).toString()).toBe('123.50');
    expect(Money.fromDatabase('98765.43').toString()).toBe('98765.43');
  });

  it('rejects values that are not plain decimal numbers', () => {
    for (const bad of ['', '  ', '1,000', 'abc', '1e5', '12.34.56', '--5', 'Infinity']) {
      expect(() => Money.of(bad), bad).toThrow(MoneyError);
    }
    expect(() => Money.of(Number.NaN)).toThrow(MoneyError);
    expect(() => Money.of(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it('rejects an unknown currency code', () => {
    // @ts-expect-error -- guarding the runtime path used by untrusted input
    expect(() => Money.of('100', 'XYZ')).toThrow(MoneyError);
  });

  it('rejects amounts beyond NUMERIC(14, 2)', () => {
    expect(Money.of(MONEY_MAX).toString()).toBe('999999999999.99');
    expect(() => Money.of('1000000000000.00')).toThrow(/exceeds the maximum/);
    expect(() => Money.of('-1000000000000.00')).toThrow(/exceeds the maximum/);
  });

  it('validates without throwing via isValid', () => {
    expect(Money.isValid('500')).toBe(true);
    expect(Money.isValid('five hundred')).toBe(false);
    expect(Money.isValid(null)).toBe(false);
  });
});

describe('Money rounding', () => {
  it('rounds half-up to the storage scale on construction', () => {
    expect(MONEY_STORAGE_SCALE).toBe(2);
    expect(rwf('1.005').toString()).toBe('1.01');
    expect(rwf('1.004').toString()).toBe('1.00');
    expect(rwf('2.675').toString()).toBe('2.68');
  });

  it('rounds negative amounts half-up (away from zero at the midpoint)', () => {
    expect(rwf('-1.005').toString()).toBe('-1.01');
    expect(rwf('-1.004').toString()).toBe('-1.00');
  });

  it('does not inherit binary floating-point drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    expect(rwf('0.1').plus(rwf('0.2')).toString()).toBe('0.30');
    let total = Money.zero();
    for (let i = 0; i < 10; i += 1) total = total.plus(rwf('0.1'));
    expect(total.toString()).toBe('1.00');
  });
});

describe('Money arithmetic', () => {
  it('adds, subtracts, multiplies and divides', () => {
    expect(rwf('120000').plus(rwf('30000')).toString()).toBe('150000.00');
    expect(rwf('120000').minus(rwf('45000')).toString()).toBe('75000.00');
    expect(rwf('120000').times('0.25').toString()).toBe('30000.00');
    expect(rwf('120000').dividedBy(3).toString()).toBe('40000.00');
  });

  it('refuses to divide by zero', () => {
    expect(() => rwf('100').dividedBy(0)).toThrow(MoneyError);
    expect(() => rwf('100').prorate(1, 0)).toThrow(MoneyError);
  });

  it('refuses to combine different currencies', () => {
    const local = Money.of('1000', 'RWF');
    const foreign = Money.of('1000', 'USD');
    expect(() => local.plus(foreign)).toThrow(/Cannot combine RWF with USD/);
    expect(() => local.minus(foreign)).toThrow(MoneyError);
    expect(() => local.compare(foreign)).toThrow(MoneyError);
    expect(local.equals(foreign)).toBe(false);
  });

  it('computes a term balance the way the ledger does', () => {
    // charges - verified payments +/- adjustments (Section 13)
    const charges = Money.sum([rwf('120000'), rwf('15000'), rwf('8000')]);
    const payments = Money.sum([rwf('50000'), rwf('25000')]);
    const adjustments = rwf('10000').negated(); // a bursary reduces what is owed
    const outstanding = charges.minus(payments).plus(adjustments);

    expect(charges.toString()).toBe('143000.00');
    expect(payments.toString()).toBe('75000.00');
    expect(outstanding.toString()).toBe('58000.00');
    expect(outstanding.isPositive()).toBe(true);
  });

  it('sums an empty list to zero', () => {
    expect(Money.sum([]).toString()).toBe('0.00');
    expect(Money.sum([], 'USD').currency).toBe('USD');
  });

  it('exposes sign helpers that treat zero as neither positive nor negative', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
    expect(Money.zero().isNegative()).toBe(false);
    expect(rwf('-0.00').isNegative()).toBe(false);
    expect(rwf('-0.01').isNegative()).toBe(true);
  });

  it('clamps an overpaid (negative) balance to zero for display', () => {
    expect(rwf('-5000').clampToZero().toString()).toBe('0.00');
    expect(rwf('5000').clampToZero().toString()).toBe('5000.00');
  });

  it('compares and picks extremes', () => {
    expect(rwf('100').lessThan(rwf('200'))).toBe(true);
    expect(rwf('200').greaterThanOrEqual(rwf('200'))).toBe(true);
    expect(Money.min(rwf('100'), rwf('200')).toString()).toBe('100.00');
    expect(Money.max(rwf('100'), rwf('200')).toString()).toBe('200.00');
    expect(rwf('100').abs().toString()).toBe('100.00');
    expect(rwf('-100').abs().toString()).toBe('100.00');
  });
});

describe('Money.prorate', () => {
  it('prorates a term charge by days attended (Section 8)', () => {
    // A student withdraws after 30 of a 90-day term.
    expect(rwf('120000').prorate(30, 90).toString()).toBe('40000.00');
    expect(rwf('100000').prorate(1, 3).toString()).toBe('33333.33');
  });
});

describe('Money.allocate', () => {
  it('splits evenly when the amount divides cleanly', () => {
    const parts = rwf('120000').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['40000.00', '40000.00', '40000.00']);
  });

  it('preserves the total when the split has a remainder', () => {
    const parts = rwf('100').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts).toString()).toBe('100.00');
  });

  it('respects unequal weights, e.g. a 50/30/20 instalment plan', () => {
    const parts = rwf('145000').allocate([50, 30, 20]);
    expect(parts.map(String)).toEqual(['72500.00', '43500.00', '29000.00']);
    expect(Money.sum(parts).toString()).toBe('145000.00');
  });

  it('preserves the total for negative amounts such as a split refund', () => {
    const parts = rwf('-100').allocate([1, 1, 1]);
    expect(Money.sum(parts).toString()).toBe('-100.00');
  });

  it('rejects degenerate weightings', () => {
    expect(() => rwf('100').allocate([])).toThrow(MoneyError);
    expect(() => rwf('100').allocate([0, 0])).toThrow(MoneyError);
    expect(() => rwf('100').allocate([1, -1])).toThrow(MoneyError);
  });
});

describe('Money formatting', () => {
  it('shows RWF without subunits but keeps full precision underneath', () => {
    expect(CURRENCIES.RWF.displayScale).toBe(0);
    const amount = rwf('125000.49');
    expect(amount.toString()).toBe('125000.49');
    expect(amount.format()).toBe('RWF 125,000');
    expect(amount.format({ withCurrency: false })).toBe('125,000');
  });

  it('rounds display half-up at the currency display scale', () => {
    expect(rwf('125000.50').format({ withCurrency: false })).toBe('125,001');
  });

  it('shows subunits for currencies that use them', () => {
    expect(Money.of('1234.5', 'USD').format()).toBe('$ 1,234.50');
  });
});

describe('Money immutability', () => {
  it('returns new instances instead of mutating', () => {
    const original = rwf('1000');
    const increased = original.plus(rwf('500'));
    expect(original.toString()).toBe('1000.00');
    expect(increased.toString()).toBe('1500.00');
    expect(Object.isFrozen(original)).toBe(true);
  });
});
