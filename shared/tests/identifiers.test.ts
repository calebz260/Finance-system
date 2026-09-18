import { describe, expect, it } from 'vitest';

import {
  formatReceiptNumber,
  formatStudentId,
  isValidReceiptNumber,
  isValidStudentId,
  normaliseStudentIdInput,
  parseStudentId,
} from '../src/identifiers.js';

describe('formatStudentId', () => {
  it('produces the documented STU-YYYY-NNNNN form', () => {
    expect(formatStudentId(2026, 125)).toBe('STU-2026-00125');
    expect(formatStudentId(2026, 1)).toBe('STU-2026-00001');
    expect(formatStudentId(2026, 99999)).toBe('STU-2026-99999');
  });

  it('rejects out-of-range years and sequences', () => {
    expect(() => formatStudentId(26, 1)).toThrow(RangeError);
    expect(() => formatStudentId(2026, 0)).toThrow(RangeError);
    expect(() => formatStudentId(2026, 1.5)).toThrow(RangeError);
    expect(() => formatStudentId(2026, 100000)).toThrow(RangeError);
  });
});

describe('formatReceiptNumber', () => {
  it('produces the documented RCP-YYYY-NNNNNNNNN form', () => {
    expect(formatReceiptNumber(2026, 1234)).toBe('RCP-2026-000001234');
    expect(isValidReceiptNumber(formatReceiptNumber(2026, 1))).toBe(true);
  });
});

describe('validation', () => {
  it('accepts well-formed identifiers only', () => {
    expect(isValidStudentId('STU-2026-00125')).toBe(true);
    expect(isValidStudentId('STU-2026-125')).toBe(false);
    expect(isValidStudentId('stu-2026-00125')).toBe(false);
    expect(isValidStudentId('')).toBe(false);
    expect(isValidReceiptNumber('RCP-2026-1234')).toBe(false);
  });
});

describe('parseStudentId', () => {
  it('splits a valid id into parts', () => {
    expect(parseStudentId('STU-2026-00125')).toEqual({
      prefix: 'STU',
      year: 2026,
      sequence: 125,
    });
  });

  it('returns null for anything malformed', () => {
    expect(parseStudentId('STU-2026-125')).toBeNull();
    expect(parseStudentId('nonsense')).toBeNull();
  });
});

describe('normaliseStudentIdInput', () => {
  it('recovers the canonical id from sloppy operator input', () => {
    expect(normaliseStudentIdInput('stu-2026-125')).toBe('STU-2026-00125');
    expect(normaliseStudentIdInput('  STU 2026 125 ')).toBe('STU-2026-00125');
    expect(normaliseStudentIdInput('STU2026125')).toBe('STU-2026-00125');
    expect(normaliseStudentIdInput('STU-2026-00125')).toBe('STU-2026-00125');
  });

  it('falls back to an upper-cased search term when it is not an id', () => {
    expect(normaliseStudentIdInput(' mukamana ')).toBe('MUKAMANA');
  });
});
