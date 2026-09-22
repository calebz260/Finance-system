/**
 * Matching a bank statement line to a payment.
 *
 * Tested without a database because it is pure, and tested hard because the two failure
 * modes are not symmetric: a missed match costs a bursar a minute of reading, and a wrong
 * one credits the wrong family while leaving the right one still owing.
 *
 * The property that matters most is the narrowness of the automatic pass. It is allowed to
 * decide **only** when the school's own reference is quoted on the line and the amounts
 * agree exactly. Every test below that asserts `UNMATCHED` or `AMBIGUOUS` is asserting
 * that the system declined to guess.
 */
import { describe, expect, it } from 'vitest';

import type { CandidatePaymentRecord } from '../../src/modules/reconciliation/reconciliation.repository.js';
import {
  classifyLine,
  referencesQuotedOn,
  scoreCandidate,
  type MatchableLine,
} from '../../src/modules/reconciliation/matching.service.js';

/**
 * A candidate payment.
 *
 * Cast at the boundary: the real type is a Prisma payload whose `amount` is a `Decimal`,
 * and everything under test reads it through `Money.fromDatabase`, which accepts anything
 * that stringifies. Building a Decimal here would test Prisma rather than the matcher.
 */
function payment(overrides: Partial<Record<string, unknown>> = {}): CandidatePaymentRecord {
  return {
    id: 'payment-1',
    schoolId: 'school-1',
    reference: 'PAY-2026-000000123',
    amount: '50000.00',
    currency: 'RWF',
    status: 'PENDING',
    payerName: 'Jean Uwase',
    externalReference: null,
    providerKey: 'BANK_OF_KIGALI',
    initiatedAt: new Date('2026-09-20T08:00:00.000Z'),
    initiatedByUserId: 'user-1',
    studentId: 'student-1',
    student: { studentId: 'STU-2026-00001', firstName: 'Aline', lastName: 'Uwase' },
    ...overrides,
  } as unknown as CandidatePaymentRecord;
}

function line(overrides: Partial<MatchableLine> = {}): MatchableLine {
  return {
    id: 'line-1',
    narrative: 'MOBILE TRANSFER PAY-2026-000000123',
    reference: null,
    amount: '50000.00',
    currency: 'RWF',
    valueDate: new Date('2026-09-21T00:00:00.000Z'),
    ...overrides,
  };
}

describe('finding a payment reference on a statement line', () => {
  it('finds one written exactly as the school issued it', () => {
    expect(referencesQuotedOn(line())).toEqual(['PAY-2026-000000123']);
  });

  it('finds one a payer typed with spaces instead of hyphens', () => {
    // Banks and payers reformat references freely. The canonical form is what is compared.
    expect(referencesQuotedOn(line({ narrative: 'DEPOSIT PAY 2026 000000123 THANKS' }))).toEqual([
      'PAY-2026-000000123',
    ]);
  });

  it('looks in the reference column as well as the narrative', () => {
    const found = referencesQuotedOn(
      line({ narrative: 'BANK TRANSFER', reference: 'pay-2026-000000123' }),
    );
    expect(found).toEqual(['PAY-2026-000000123']);
  });

  it('does not read a random digit string as a reference', () => {
    expect(referencesQuotedOn(line({ narrative: 'TRANSFER 2026 000000123' }))).toEqual([]);
    expect(referencesQuotedOn(line({ narrative: 'REF 123456789' }))).toEqual([]);
  });

  it('finds both when a line quotes two references', () => {
    const found = referencesQuotedOn(
      line({ narrative: 'PAY-2026-000000123 AND PAY-2026-000000124' }),
    );
    expect([...found].sort()).toEqual(['PAY-2026-000000123', 'PAY-2026-000000124']);
  });
});

describe('scoring one candidate', () => {
  it('scores a quoted reference and an equal amount highest', () => {
    const scored = scoreCandidate(line(), payment(), ['PAY-2026-000000123']);

    expect(scored).not.toBeNull();
    expect(scored?.referenceQuoted).toBe(true);
    expect(scored?.amountMatches).toBe(true);
    expect(scored?.reason).toContain('reference is quoted');
  });

  it('offers nothing for a name alone', () => {
    // "Jean" matches half a school's parents. A name with no amount and no reference is a
    // guess, and a list of guesses is how a bursar ends up clicking the first one.
    const scored = scoreCandidate(
      line({ narrative: 'TRANSFER FROM JEAN UWASE', amount: '12000.00' }),
      payment(),
      [],
    );

    expect(scored).toBeNull();
  });

  it('offers a candidate whose amount matches, and says so', () => {
    const scored = scoreCandidate(line({ narrative: 'BANK TRANSFER' }), payment(), []);

    expect(scored?.amountMatches).toBe(true);
    expect(scored?.referenceQuoted).toBe(false);
    expect(scored?.reason).toContain('amount is exactly the same');
  });

  it('recognises the bank reference the payer quoted to the school', () => {
    const scored = scoreCandidate(
      line({ narrative: 'RTGS BK-99881 INWARD', amount: '75000.00' }),
      payment({ amount: '75000.00', externalReference: 'BK-99881' }),
      [],
    );

    expect(scored?.reason).toContain('bank reference');
  });

  it('ignores an external reference too short to be distinctive', () => {
    const scored = scoreCandidate(
      line({ narrative: 'PAYMENT 12 SEPTEMBER', amount: '9000.00' }),
      payment({ amount: '1000.00', externalReference: '12' }),
      [],
    );

    expect(scored).toBeNull();
  });

  it('does not treat a different currency as the same amount', () => {
    const scored = scoreCandidate(
      line({ narrative: 'BANK TRANSFER', currency: 'USD' }),
      payment(),
      [],
    );

    expect(scored).toBeNull();
  });
});

describe('deciding what happens to a line', () => {
  it('matches automatically when the reference is quoted and the amount agrees', () => {
    const verdict = classifyLine(line(), 'MONEY_IN', [payment()]);

    expect(verdict.kind).toBe('AUTOMATIC');
    if (verdict.kind === 'AUTOMATIC') {
      expect(verdict.paymentId).toBe('payment-1');
    }
  });

  it('refuses to match a quoted reference whose amount is different', () => {
    // The most useful suggestion there is, and the least safe thing to apply: either the
    // payer paid a different amount or the line is not theirs, and both need a person.
    const verdict = classifyLine(line({ amount: '45000.00' }), 'MONEY_IN', [payment()]);

    expect(verdict.kind).toBe('UNMATCHED');
    if (verdict.kind === 'UNMATCHED') {
      expect(verdict.candidates).toHaveLength(1);
      expect(verdict.candidates[0]?.amountMatches).toBe(false);
    }
  });

  it('reports ambiguity rather than picking one of two equal candidates', () => {
    const verdict = classifyLine(line({ narrative: 'BANK TRANSFER' }), 'MONEY_IN', [
      payment({ id: 'payment-1' }),
      payment({ id: 'payment-2', reference: 'PAY-2026-000000124' }),
    ]);

    expect(verdict.kind).toBe('AMBIGUOUS');
  });

  it('never attributes money leaving the account', () => {
    // A bank charge is not a student's fees, whatever it happens to say on it.
    const verdict = classifyLine(line(), 'MONEY_OUT', [payment()]);

    expect(verdict.kind).toBe('UNMATCHED');
    if (verdict.kind === 'UNMATCHED') expect(verdict.candidates).toHaveLength(0);
  });

  it('leaves a line with no plausible candidate unmatched and empty-handed', () => {
    const verdict = classifyLine(
      line({ narrative: 'INTEREST CREDIT', amount: '312.40' }),
      'MONEY_IN',
      [payment()],
    );

    expect(verdict.kind).toBe('UNMATCHED');
    if (verdict.kind === 'UNMATCHED') expect(verdict.candidates).toHaveLength(0);
  });

  it('orders suggestions by strength, best first', () => {
    const verdict = classifyLine(
      line({ narrative: 'TRANSFER BK-99881 FROM JEAN UWASE' }),
      'MONEY_IN',
      [
        payment({ id: 'weaker' }),
        payment({ id: 'stronger', reference: 'PAY-2026-000000124', externalReference: 'BK-99881' }),
      ],
    );

    expect(verdict.kind).toBe('AMBIGUOUS');
    if (verdict.kind === 'AMBIGUOUS') {
      expect(verdict.candidates[0]?.payment.id).toBe('stronger');
    }
  });
});
