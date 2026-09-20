/**
 * The import's interpretation rules, tested without a database.
 *
 * These are the parts that decide what a registrar's spreadsheet *means*: which
 * heading is the first name, whether `03/04/2026` is March or April, and whether the
 * same parent written four different ways is one person or four.
 */
import { describe, expect, it } from 'vitest';

import {
  mapColumns,
  normalisePhone,
  parseImportDate,
} from '../../src/modules/imports/student-import.service.js';

describe('mapColumns', () => {
  it('matches headings regardless of case, spacing and punctuation', () => {
    const { columns, missing } = mapColumns(['First Name', 'last_name', 'LEVEL']);

    expect(missing).toEqual([]);
    expect(columns.firstName).toBe(0);
    expect(columns.lastName).toBe(1);
    expect(columns.levelCode).toBe(2);
  });

  it('accepts the aliases these files actually use', () => {
    const { columns, missing } = mapColumns([
      'Surname',
      'Given Name',
      'Class',
      'Parent Contact',
      'DOB',
    ]);

    expect(missing).toEqual([]);
    expect(columns.lastName).toBe(0);
    expect(columns.firstName).toBe(1);
    expect(columns.levelCode).toBe(2);
    expect(columns.guardianPhone).toBe(3);
    expect(columns.dateOfBirth).toBe(4);
  });

  it('reports missing required columns as one file-level problem', () => {
    // A wrong heading otherwise produces one identical error per row, which buries
    // every real problem in the file.
    const { missing } = mapColumns(['Name', 'Age']);

    expect(missing).toEqual(['firstName', 'lastName', 'levelCode']);
  });

  it('leaves optional columns unmapped rather than guessing', () => {
    const { columns } = mapColumns(['First Name', 'Last Name', 'Level']);

    expect(columns.guardianPhone).toBeUndefined();
    expect(columns.residency).toBeUndefined();
  });
});

describe('parseImportDate', () => {
  it('reads the format a spreadsheet exports', () => {
    expect(parseImportDate('2026-01-15')?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('reads day-first dates, which is the local convention', () => {
    expect(parseImportDate('15/01/2026')?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(parseImportDate('15-01-2026')?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('parses at UTC midnight, so a date does not shift with a time zone', () => {
    const parsed = parseImportDate('2026-01-15');

    expect(parsed?.getUTCHours()).toBe(0);
    expect(parsed?.getUTCDate()).toBe(15);
  });

  it('refuses a date that does not exist', () => {
    // `Date.UTC` would roll 31 February forward to 3 March and record a birth date
    // nobody typed.
    expect(parseImportDate('2026-02-31')).toBeNull();
    expect(parseImportDate('2026-13-01')).toBeNull();
    expect(parseImportDate('32/01/2026')).toBeNull();
  });

  it('refuses anything it does not recognise, rather than guessing', () => {
    for (const value of ['15 Jan 2026', 'January 2026', 'yesterday', '2026/01/15', 'abc']) {
      expect(parseImportDate(value)).toBeNull();
    }
  });

  it('treats blank as absent rather than invalid', () => {
    expect(parseImportDate('')).toBeNull();
    expect(parseImportDate('   ')).toBeNull();
  });
});

describe('normalisePhone', () => {
  it('reduces the ways one Rwandan number is written to a single form', () => {
    // This is what makes a parent with four children one guardian rather than four.
    const expected = '+250788123456';

    expect(normalisePhone('0788123456')).toBe(expected);
    expect(normalisePhone('788123456')).toBe(expected);
    expect(normalisePhone('250788123456')).toBe(expected);
    expect(normalisePhone('+250788123456')).toBe(expected);
    expect(normalisePhone('+250 788 123 456')).toBe(expected);
    expect(normalisePhone('(0788) 123-456')).toBe(expected);
  });

  it('keeps distinct numbers distinct', () => {
    expect(normalisePhone('0788123456')).not.toBe(normalisePhone('0788123457'));
  });

  it('returns empty for a value with no digits', () => {
    expect(normalisePhone('')).toBe('');
    expect(normalisePhone('n/a')).toBe('');
    expect(normalisePhone('-')).toBe('');
  });

  it('does not mangle an international number from outside Rwanda', () => {
    expect(normalisePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
});
