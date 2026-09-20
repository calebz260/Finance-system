/**
 * Balance calculation. The only place the formula exists.
 *
 *     balance = Σ DEBIT − Σ CREDIT      (over `financial_entries`)
 *
 * **Everything is computed from the ledger.** Charges, discounts, scholarship awards,
 * waivers and adjustments are business records that *justify* entries; not one of them is
 * ever summed to produce a balance. That is what makes double-counting structurally
 * impossible rather than a rule someone has to remember: a record that never posted an
 * entry cannot appear in a total, and one that posted twice is stopped by a unique index
 * before it can be counted (ADR-022).
 *
 * Everything that reports a balance — the student financial screen, the charge list, a
 * clearance check in Phase 10, a report in Phase 8 — calls in here. There is no second
 * implementation in a controller, a report query or a React component, because two
 * implementations of a balance is how a system ends up with two answers to "what does
 * this family owe?" and no way to say which is right (Section 13A).
 *
 * Two further rules the shape enforces:
 *
 *  - **Nothing is stored.** There is no balance column anywhere to drift, and no
 *    migration could leave one stale.
 *  - **A negative net is a credit, not a negative debt.** `outstanding` is floored at
 *    zero and the overpayment surfaces as `creditBalance`, so no caller ever has to
 *    decide what a negative balance means (ADR-021).
 *
 * Phase 5 posts payments as `source = PAYMENT` CREDIT entries. Nothing here changes when
 * it does — `totalPaid` simply stops being zero. That is the point of the shape.
 */
import {
  type CurrencyCode,
  Money,
  type StudentBalance,
  type StudentBalancePeriod,
} from '@sfs/shared';

import type { AccessScope } from '../../lib/access-scope.js';
import { NotFoundError } from '../../lib/errors.js';
import { feeRepository, type LedgerTotalRow } from './fee.repository.js';

export interface NetPosition {
  readonly totalCharged: Money;
  readonly totalCredited: Money;
  readonly totalSurcharged: Money;
  readonly totalPaid: Money;
  readonly outstanding: Money;
  readonly creditBalance: Money;
}

/**
 * Fold ledger rows into a position.
 *
 * Exported because the unit tests exercise it directly: the arithmetic is the part that
 * must be right, and it should be testable without a database behind it.
 *
 * The breakdown fields are the same rows sliced by source, so they add back up to the
 * net by construction rather than by coincidence:
 *
 *   - `totalCharged`    DEBITs whose source is CHARGE
 *   - `totalSurcharged` DEBITs whose source is ADJUSTMENT (an authorised late fee)
 *   - `totalCredited`   CREDITs from discounts, scholarships, waivers and adjustments
 *   - `totalPaid`       CREDITs from payments
 *
 * A reversal is an opposing entry, so it lands in the same buckets with the other sign
 * and nets itself out. Nothing special is needed to handle one.
 */
export function computeNetPosition(
  rows: readonly LedgerTotalRow[],
  currency: CurrencyCode,
): NetPosition {
  const zero = Money.zero(currency);
  let charged = zero;
  let surcharged = zero;
  let credited = zero;
  let paid = zero;
  let debitTotal = zero;
  let creditTotal = zero;

  for (const row of rows) {
    const amount = Money.of(row.total, currency);

    if (row.entryType === 'DEBIT') {
      debitTotal = debitTotal.plus(amount);
      if (row.source === 'CHARGE') charged = charged.plus(amount);
      // A DEBIT from any relief source is a reversal of a credit. It belongs against the
      // credit it undoes, not in the charge total, or reversing a discount would look
      // like the school had raised a new charge.
      else if (row.source === 'PAYMENT') paid = paid.minus(amount);
      else if (row.source === 'ADJUSTMENT') surcharged = surcharged.plus(amount);
      else credited = credited.minus(amount);
    } else {
      creditTotal = creditTotal.plus(amount);
      if (row.source === 'PAYMENT') paid = paid.plus(amount);
      // A CREDIT whose source is CHARGE is the reversal of a voided charge.
      else if (row.source === 'CHARGE') charged = charged.minus(amount);
      else credited = credited.plus(amount);
    }
  }

  const net = debitTotal.minus(creditTotal);

  return {
    totalCharged: charged,
    totalCredited: credited,
    totalSurcharged: surcharged,
    totalPaid: paid,
    // Exactly one of these is non-zero. Clamping the negation is what turns an
    // overpayment into a credit rather than a debt with a minus sign in front of it.
    outstanding: net.clampToZero(),
    creditBalance: net.negated().clampToZero(),
  };
}

/**
 * What a charge is still worth, from the ledger entries that point at it.
 *
 * `credit` is the relief applied to it and `debit` the reversals of that relief, so the
 * net is what has actually been taken off.
 */
export function computeChargeNet(
  amount: string,
  applied: { credit: string; debit: string },
  currency: CurrencyCode,
): { amount: Money; adjusted: Money; net: Money } {
  const charged = Money.of(amount, currency);
  const adjusted = Money.of(applied.credit, currency)
    .minus(Money.of(applied.debit, currency))
    .clampToZero();

  return {
    amount: charged,
    adjusted,
    // Floored: relief larger than the charge it sits against does not make the charge
    // negative. Any surplus shows up in the student's credit balance instead.
    net: charged.minus(adjusted).clampToZero(),
  };
}

async function resolveCurrency(schoolId: string): Promise<CurrencyCode> {
  return (await feeRepository.findSchoolCurrency(schoolId)) as CurrencyCode;
}

/**
 * A student's financial position, optionally narrowed to one period.
 *
 * Throws `NotFoundError` for a student outside the caller's scope — the same 404 a
 * missing student gets, so balances cannot be used to enumerate other schools' students.
 */
export async function getStudentBalance(
  scope: AccessScope,
  studentId: string,
  period: { academicYearId?: string | undefined; termId?: string | null | undefined } = {},
): Promise<StudentBalance> {
  const identity = await feeRepository.findStudentIdentity(scope, studentId);
  if (identity === null) {
    throw new NotFoundError('The requested student was not found.');
  }

  const currency = await resolveCurrency(identity.schoolId);
  const scoped = {
    studentId,
    ...(period.academicYearId !== undefined ? { academicYearId: period.academicYearId } : {}),
    ...(period.termId !== undefined ? { termId: period.termId } : {}),
  };

  const [rows, pendingApprovalCount] = await Promise.all([
    feeRepository.sumEntriesBySource(scope, scoped),
    feeRepository.countPendingReliefs(scope, scoped),
  ]);

  const position = computeNetPosition(rows, currency);

  return {
    studentId: identity.id,
    studentNumber: identity.studentId,
    studentName: `${identity.firstName} ${identity.lastName}`,
    currency,
    totalCharged: position.totalCharged.toString(),
    totalCredited: position.totalCredited.toString(),
    totalSurcharged: position.totalSurcharged.toString(),
    totalPaid: position.totalPaid.toString(),
    outstanding: position.outstanding.toString(),
    creditBalance: position.creditBalance.toString(),
    pendingApprovalCount,
  };
}

/** The same position, broken down by academic year and term. */
export async function getStudentBalanceByPeriod(
  scope: AccessScope,
  studentId: string,
): Promise<readonly StudentBalancePeriod[]> {
  const identity = await feeRepository.findStudentIdentity(scope, studentId);
  if (identity === null) {
    throw new NotFoundError('The requested student was not found.');
  }

  const currency = await resolveCurrency(identity.schoolId);
  const rows = await feeRepository.sumEntriesByPeriod(scope, studentId);

  const grouped = new Map<
    string,
    { academicYearId: string; termId: string | null; rows: LedgerTotalRow[] }
  >();
  for (const row of rows) {
    const key = `${row.academicYearId}:${row.termId ?? ''}`;
    const existing = grouped.get(key) ?? {
      academicYearId: row.academicYearId,
      termId: row.termId,
      rows: [],
    };
    existing.rows.push({ entryType: row.entryType, source: row.source, total: row.total });
    grouped.set(key, existing);
  }

  const names = await feeRepository.findPeriodNames(scope, [...grouped.values()]);

  return [...grouped.values()]
    .map((group) => {
      const position = computeNetPosition(group.rows, currency);
      return {
        academicYearId: group.academicYearId,
        academicYearName: names.years.get(group.academicYearId) ?? 'Unknown year',
        termId: group.termId,
        termName: group.termId === null ? null : (names.terms.get(group.termId) ?? null),
        totalCharged: position.totalCharged.toString(),
        totalCredited: position.totalCredited.toString(),
        totalSurcharged: position.totalSurcharged.toString(),
        totalPaid: position.totalPaid.toString(),
        outstanding: position.outstanding.toString(),
        creditBalance: position.creditBalance.toString(),
      } satisfies StudentBalancePeriod;
    })
    .sort((a, b) => {
      const byYear = a.academicYearName.localeCompare(b.academicYearName);
      if (byYear !== 0) return byYear;
      return (a.termName ?? '').localeCompare(b.termName ?? '');
    });
}

/**
 * How much relief a charge can still absorb.
 *
 * Used when a discount, scholarship or waiver is requested against a specific charge: the
 * request is refused if it would exceed what remains, which is what stops a charge of
 * 100,000 from quietly collecting 150,000 of write-offs (Section 14).
 */
export async function getRemainingChargeValue(
  chargeId: string,
  amount: string,
  currency: CurrencyCode,
): Promise<Money> {
  const applied = await feeRepository.sumEntriesByCharge([chargeId]);
  return computeChargeNet(amount, applied.get(chargeId) ?? { credit: '0', debit: '0' }, currency)
    .net;
}
