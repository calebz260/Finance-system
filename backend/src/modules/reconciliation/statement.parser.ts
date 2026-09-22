/**
 * Turning a bank's export into statement lines.
 *
 * There is no standard for this file. Bank of Kigali, Zigama CSS and a SACCO's Excel
 * export disagree about column names, about whether money in and money out are two
 * columns or one signed column, about thousands separators, and about date order. This
 * module absorbs that variety and refuses anything it cannot read, rather than guessing.
 *
 * Three rules it exists to hold:
 *
 *  - **Nothing is corrected to make a row fit.** An unreadable amount is an error against
 *    the row number the bursar can see, not a figure rounded into something plausible.
 *    Reconciliation exists to compare the school's record against the bank's; a parser
 *    that tidied the bank's numbers would be comparing the school's record against
 *    itself (Section 20).
 *  - **Money never becomes a JavaScript number.** Amounts are normalised as text and
 *    validated by `Money`, exactly as at the HTTP boundary (ADR-001).
 *  - **Direction is explicit.** A line is money in or money out, decided from the columns
 *    the file actually has, and never inferred from whether it happens to match a
 *    payment.
 *
 * Dates are read by `parseImportDate`, shared with the student import, so the same
 * day-first convention applies to every file the school uploads.
 */
import { Money, type CurrencyCode } from '@sfs/shared';

import type { BankStatementDirection } from '../../generated/prisma/enums.js';
import { parseImportDate } from '../imports/student-import.service.js';
import type { SheetRow } from '../imports/spreadsheet.js';

/** One row, as far as it could be read. */
export interface ParsedStatementLine {
  readonly lineNumber: number;
  readonly valueDate: Date | null;
  readonly narrative: string;
  readonly reference: string | null;
  /** Normalised decimal string, or null when the row had no usable amount. */
  readonly amount: string | null;
  readonly direction: BankStatementDirection | null;
  readonly errors: readonly string[];
}

export interface ParsedStatement {
  readonly lines: readonly ParsedStatementLine[];
  /** The columns that were recognised, for the preview to report. */
  readonly columns: readonly string[];
}

/**
 * Column aliases, by the field they feed.
 *
 * Matched after lower-casing and stripping everything that is not a letter or a digit, so
 * `Value Date`, `value_date` and `VALUEDATE` are one heading. Deliberately generous: a
 * heading this list does not know costs a bursar a failed import and a support call,
 * whereas an extra alias costs nothing.
 */
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  date: [
    'date',
    'valuedate',
    'transactiondate',
    'postingdate',
    'txndate',
    'bookingdate',
    'effectivedate',
  ],
  narrative: [
    'narrative',
    'description',
    'details',
    'particulars',
    'transactiondetails',
    'remarks',
    'memo',
  ],
  reference: [
    'reference',
    'ref',
    'refno',
    'referencenumber',
    'transactionreference',
    'bankreference',
    'chequeno',
    'chequenumber',
    'transactionid',
  ],
  amount: ['amount', 'value', 'transactionamount'],
  credit: ['credit', 'creditamount', 'moneyin', 'deposit', 'deposits', 'cr', 'paidin'],
  debit: ['debit', 'debitamount', 'moneyout', 'withdrawal', 'withdrawals', 'dr', 'paidout'],
  direction: ['direction', 'type', 'drcr', 'crdr', 'transactiontype'],
};

export type StatementColumnMap = Readonly<Record<string, number | undefined>>;

function normaliseHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Map the header row onto the fields the importer needs.
 *
 * Exported for the unit tests: the header of a real bank export is the part most likely to
 * change without warning, so it is worth testing on its own.
 */
export function mapStatementColumns(header: readonly string[]): StatementColumnMap {
  const map: Record<string, number | undefined> = {};

  header.forEach((heading, index) => {
    const normalised = normaliseHeading(heading);
    if (normalised === '') return;

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      // First match wins, so a file with both `Reference` and `Bank Reference` uses the
      // leftmost — which is the one a person reading the file would quote.
      if (map[field] === undefined && aliases.includes(normalised)) {
        map[field] = index;
        return;
      }
    }
  });

  return map;
}

/** What the file must have before any row is worth reading. */
export function describeMissingColumns(columns: StatementColumnMap): readonly string[] {
  const missing: string[] = [];
  if (columns.date === undefined) missing.push('a date column (Date or Value Date)');
  if (columns.narrative === undefined) {
    missing.push('a description column (Narrative, Description or Details)');
  }
  if (columns.amount === undefined && columns.credit === undefined && columns.debit === undefined) {
    missing.push('an amount column, or separate Credit and Debit columns');
  }
  return missing;
}

function cell(values: readonly string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (values[index] ?? '').trim();
}

/**
 * Normalise whatever a bank wrote in an amount column.
 *
 * Handles thousands separators, a currency code or symbol sitting in the cell, and
 * accounting parentheses for a negative. Returns null when what is left is not an amount —
 * which is the honest answer for a running-balance column that slipped in, or a row of
 * dashes where a bank writes "no movement".
 */
export function normaliseStatementAmount(
  raw: string,
): { amount: string; negative: boolean } | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '—') return null;

  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  const inner = parenthesised?.[1] ?? trimmed;

  // Strip currency codes, symbols and spaces, and thousands separators. What must remain
  // is digits, at most one decimal point, and an optional leading sign.
  const cleaned = inner
    .replace(/[A-Za-z]/g, '')
    .replace(/[\s,'’]/g, '')
    .replace(/^\+/, '');

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const negative = parenthesised !== null || cleaned.startsWith('-');
  const magnitude = cleaned.replace(/^-/, '');

  if (!Money.isValid(magnitude)) return null;

  return { amount: Money.of(magnitude).toString(), negative };
}

/** `CR`, `credit`, `money in` and `deposit` all mean the money arrived. */
function directionFromWord(raw: string): BankStatementDirection | null {
  const word = normaliseHeading(raw);
  if (word === '') return null;
  if (['cr', 'credit', 'moneyin', 'in', 'deposit', 'c'].includes(word)) return 'MONEY_IN';
  if (['dr', 'debit', 'moneyout', 'out', 'withdrawal', 'd'].includes(word)) return 'MONEY_OUT';
  return null;
}

/**
 * Read one row.
 *
 * Every problem is collected rather than thrown, so the preview can report a file's
 * fifteen bad rows in one pass instead of one per upload.
 */
function parseRow(
  row: SheetRow,
  columns: StatementColumnMap,
  currency: CurrencyCode,
): ParsedStatementLine {
  const errors: string[] = [];

  const rawDate = cell(row.values, columns.date);
  const valueDate = parseImportDate(rawDate);
  if (valueDate === null) {
    errors.push(
      rawDate === ''
        ? 'No date.'
        : `"${rawDate}" is not a date this system reads. Use YYYY-MM-DD or DD/MM/YYYY.`,
    );
  }

  const narrative = cell(row.values, columns.narrative);
  if (narrative === '') errors.push('No description.');

  // Two shapes of file. Separate credit and debit columns are read first, because a file
  // that has them may also carry a signed `amount` column holding the same figure, and
  // the explicit columns are the less ambiguous of the two.
  let amount: string | null = null;
  let direction: BankStatementDirection | null = null;

  const credit = normaliseStatementAmount(cell(row.values, columns.credit));
  const debit = normaliseStatementAmount(cell(row.values, columns.debit));

  if (credit !== null && debit !== null) {
    errors.push('Both a credit and a debit are filled in, so the direction is ambiguous.');
  } else if (credit !== null) {
    amount = credit.amount;
    direction = 'MONEY_IN';
  } else if (debit !== null) {
    amount = debit.amount;
    direction = 'MONEY_OUT';
  } else {
    const single = normaliseStatementAmount(cell(row.values, columns.amount));
    if (single === null) {
      errors.push('No usable amount.');
    } else {
      amount = single.amount;
      // A sign in the amount decides; failing that, a direction column; failing that, the
      // row is refused rather than assumed to be money in, because assuming would credit
      // a family for a bank charge.
      const stated = directionFromWord(cell(row.values, columns.direction));
      if (single.negative) direction = 'MONEY_OUT';
      else if (stated !== null) direction = stated;
      else if (columns.direction === undefined && columns.debit === undefined) {
        // A file with one unsigned amount column and nothing to say otherwise is a
        // credits-only export, which is what most schools are sent.
        direction = 'MONEY_IN';
      } else {
        errors.push('Cannot tell whether this is money in or money out.');
      }
    }
  }

  if (amount !== null && !Money.of(amount, currency).isPositive()) {
    errors.push('An amount of zero is not a transaction.');
  }

  const reference = cell(row.values, columns.reference);

  return {
    lineNumber: row.row,
    valueDate,
    narrative,
    reference: reference === '' ? null : reference,
    amount,
    direction,
    errors,
  };
}

/**
 * Read a whole statement.
 *
 * The header is row 1 and is consumed here; every returned `lineNumber` is the row the
 * bursar sees in their spreadsheet, which is what makes an error message actionable.
 */
export function parseStatement(
  rows: readonly SheetRow[],
  currency: CurrencyCode,
): ParsedStatement | { missingColumns: readonly string[] } {
  const header = rows[0];
  if (header === undefined) return { missingColumns: ['a header row'] };

  const columns = mapStatementColumns(header.values);
  const missingColumns = describeMissingColumns(columns);
  if (missingColumns.length > 0) return { missingColumns };

  const lines = rows
    .slice(1)
    // A wholly blank row in the middle of a bank export is ordinary — a page break in the
    // original PDF, a spacer before a totals line — and is not an error worth reporting.
    .filter((row) => row.values.some((value) => value.trim() !== ''))
    .map((row) => parseRow(row, columns, currency));

  return {
    lines,
    columns: Object.keys(columns).filter((field) => columns[field] !== undefined),
  };
}
