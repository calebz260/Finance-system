/**
 * Reading a bank's export.
 *
 * Every bank formats this file differently, so these tests are written as a small museum
 * of the shapes a Rwandan school actually receives: a credits-only CSV, separate Credit and
 * Debit columns, a single signed Amount column, thousands separators, accounting
 * parentheses, and a currency code sitting inside the amount cell.
 *
 * The rule the tests hold the parser to is that it never invents. A row it cannot read
 * becomes an error against the line number the bursar sees, and a direction it cannot
 * determine is refused rather than assumed to be money in — because assuming would credit
 * a family for a bank charge.
 */
import { describe, expect, it } from 'vitest';

import type { SheetRow } from '../../src/modules/imports/spreadsheet.js';
import {
  mapStatementColumns,
  normaliseStatementAmount,
  parseStatement,
} from '../../src/modules/reconciliation/statement.parser.js';

function sheet(rows: ReadonlyArray<readonly string[]>): SheetRow[] {
  return rows.map((values, index) => ({ row: index + 1, values: [...values] }));
}

function parse(rows: ReadonlyArray<readonly string[]>) {
  const result = parseStatement(sheet(rows), 'RWF');
  if ('missingColumns' in result) {
    throw new Error(`Expected a parse, got missing columns: ${result.missingColumns.join(', ')}`);
  }
  return result;
}

describe('mapping the header', () => {
  it('recognises headings whatever the spacing and case', () => {
    const columns = mapStatementColumns(['Value Date', 'TRANSACTION_DETAILS', 'ref no', 'Amount']);

    expect(columns.date).toBe(0);
    expect(columns.narrative).toBe(1);
    expect(columns.reference).toBe(2);
    expect(columns.amount).toBe(3);
  });

  it('recognises separate money-in and money-out columns', () => {
    const columns = mapStatementColumns(['Date', 'Particulars', 'Money In', 'Money Out']);

    expect(columns.credit).toBe(2);
    expect(columns.debit).toBe(3);
  });

  it('reports what a file is missing rather than failing on the first row', () => {
    const result = parseStatement(
      sheet([
        ['Narrative', 'Amount'],
        ['Fees', '1000'],
      ]),
      'RWF',
    );

    expect('missingColumns' in result).toBe(true);
    if ('missingColumns' in result) {
      expect(result.missingColumns.join(' ')).toContain('date');
    }
  });
});

describe('normalising an amount', () => {
  it('reads thousands separators and a trailing currency code', () => {
    expect(normaliseStatementAmount('1,250,000.00')).toEqual({
      amount: '1250000.00',
      negative: false,
    });
    expect(normaliseStatementAmount('50 000 RWF')).toEqual({ amount: '50000.00', negative: false });
  });

  it('reads accounting parentheses as a negative', () => {
    expect(normaliseStatementAmount('(2,500.00)')).toEqual({ amount: '2500.00', negative: true });
  });

  it('reads a leading minus as a negative', () => {
    expect(normaliseStatementAmount('-750.50')).toEqual({ amount: '750.50', negative: true });
  });

  it('refuses anything that is not an amount', () => {
    // A dash is how banks write "no movement in this column"; it is not a figure.
    expect(normaliseStatementAmount('-')).toBeNull();
    expect(normaliseStatementAmount('')).toBeNull();
    expect(normaliseStatementAmount('n/a')).toBeNull();
    expect(normaliseStatementAmount('1.2.3')).toBeNull();
  });
});

describe('reading rows', () => {
  it('reads a credits-only statement as money in', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Reference', 'Amount'],
      ['2026-09-21', 'MOBILE TRANSFER PAY-2026-000000123', 'MM-771', '50,000.00'],
    ]);

    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({
      lineNumber: 2,
      narrative: 'MOBILE TRANSFER PAY-2026-000000123',
      reference: 'MM-771',
      amount: '50000.00',
      direction: 'MONEY_IN',
      errors: [],
    });
    expect(parsed.lines[0]?.valueDate?.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('reads separate credit and debit columns', () => {
    const parsed = parse([
      ['Date', 'Details', 'Credit', 'Debit'],
      ['21/09/2026', 'SCHOOL FEES', '50000', ''],
      ['22/09/2026', 'LEDGER FEE', '', '2500'],
    ]);

    expect(parsed.lines[0]).toMatchObject({ amount: '50000.00', direction: 'MONEY_IN' });
    expect(parsed.lines[1]).toMatchObject({ amount: '2500.00', direction: 'MONEY_OUT' });
  });

  it('reads a signed single amount column', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Amount', 'Type'],
      ['2026-09-21', 'FEES', '50000', 'CR'],
      ['2026-09-22', 'CHARGE', '-2500', 'DR'],
    ]);

    expect(parsed.lines[0]?.direction).toBe('MONEY_IN');
    expect(parsed.lines[1]?.direction).toBe('MONEY_OUT');
  });

  it('reads a direction column when the amount carries no sign', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Amount', 'Dr/Cr'],
      ['2026-09-21', 'FEES', '50000', 'Credit'],
      ['2026-09-22', 'CHARGE', '2500', 'Debit'],
    ]);

    expect(parsed.lines[0]?.direction).toBe('MONEY_IN');
    expect(parsed.lines[1]?.direction).toBe('MONEY_OUT');
  });

  it('refuses a row whose direction cannot be told', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Amount', 'Type'],
      ['2026-09-21', 'FEES', '50000', ''],
    ]);

    // Not assumed to be money in: assuming would credit a family for a bank charge.
    expect(parsed.lines[0]?.direction).toBeNull();
    expect(parsed.lines[0]?.errors.join(' ')).toContain('money in or money out');
  });

  it('refuses a row with both a credit and a debit', () => {
    const parsed = parse([
      ['Date', 'Details', 'Credit', 'Debit'],
      ['2026-09-21', 'CORRECTION', '5000', '5000'],
    ]);

    expect(parsed.lines[0]?.errors.join(' ')).toContain('ambiguous');
  });

  it('reports an unreadable date against the row the bursar can see', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Amount'],
      ['2026-09-21', 'GOOD ROW', '1000'],
      ['last tuesday', 'BAD ROW', '1000'],
    ]);

    expect(parsed.lines[1]?.lineNumber).toBe(3);
    expect(parsed.lines[1]?.errors.join(' ')).toContain('not a date');
    // The good row is unaffected: one bad row does not spoil the report.
    expect(parsed.lines[0]?.errors).toEqual([]);
  });

  it('reports a missing description and a missing amount separately', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Amount'],
      ['2026-09-21', '', ''],
    ]);

    expect(parsed.lines[0]?.errors).toHaveLength(2);
  });

  it('skips a blank row without calling it an error', () => {
    // A page break from the original PDF, or a spacer above a totals line.
    const parsed = parse([
      ['Date', 'Narrative', 'Amount'],
      ['2026-09-21', 'FEES', '1000'],
      ['', '', ''],
      ['2026-09-22', 'FEES', '2000'],
    ]);

    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines.every((line) => line.errors.length === 0)).toBe(true);
    // Row numbers still point at the spreadsheet, so row 4 is row 4.
    expect(parsed.lines[1]?.lineNumber).toBe(4);
  });

  it('refuses a zero amount, which is not a transaction', () => {
    const parsed = parse([
      ['Date', 'Narrative', 'Credit'],
      ['2026-09-21', 'NIL MOVEMENT', '0.00'],
    ]);

    expect(parsed.lines[0]?.errors.join(' ')).toContain('zero');
  });
});
