/**
 * The CSV reader.
 *
 * Every case here is one this system will actually meet, because the file comes from
 * a registrar's spreadsheet rather than from a generator: a byte-order mark Excel
 * writes invisibly, an address with a comma in it, a name someone typed a quote into,
 * and hundreds of blank rows below the data.
 */
import { describe, expect, it } from 'vitest';

import { CsvParseError, parseCsv, withoutBlankRows } from '../../src/modules/imports/csv.js';

describe('parseCsv', () => {
  it('reads a simple file', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('strips the byte-order mark Excel writes', () => {
    // Without this the first heading is "\uFEFFfirstName" and every lookup of that
    // column fails, for a file that looks perfectly normal on screen. The mark is
    // written as an escape here so it stays visible in the source.
    const rows = parseCsv('\uFEFFfirstName,lastName\nAline,Mutesi');

    expect(rows[0]).toEqual(['firstName', 'lastName']);
  });

  it('keeps a comma inside a quoted field', () => {
    const rows = parseCsv('name,address\nAline,"KG 11 Ave, Kicukiro"');

    expect(rows[1]).toEqual(['Aline', 'KG 11 Ave, Kicukiro']);
  });

  it('reads a doubled quote as one literal quote', () => {
    const rows = parseCsv('name\n"She said ""hello"""');

    expect(rows[1]).toEqual(['She said "hello"']);
  });

  it('keeps a newline inside a quoted field', () => {
    const rows = parseCsv('name,address\nAline,"Line one\nLine two"');

    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe('Line one\nLine two');
  });

  it('accepts CRLF, LF and lone CR line endings', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
    expect(parseCsv('a,b\r\n1,2\r\n')).toHaveLength(2);
  });

  it('preserves empty fields rather than collapsing them', () => {
    // Column position is how a value is identified; dropping an empty field would
    // shift every value after it into the wrong column.
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('treats a quote in the middle of a field as a literal', () => {
    // `5" pipe` is what a spreadsheet exports for an unquoted field containing a quote.
    expect(parseCsv('size\n5" pipe')).toEqual([['size'], ['5" pipe']]);
  });

  it('reports an unclosed quote rather than swallowing the rest of the file', () => {
    expect(() => parseCsv('name\n"Aline')).toThrow(CsvParseError);
    expect(() => parseCsv('name\n"Aline')).toThrow(/not closed/);
  });

  it('refuses a file beyond the row limit', () => {
    const rows = Array.from({ length: 12 }, (_, index) => `row${String(index)}`).join('\n');

    expect(() => parseCsv(rows, { maxRows: 10 })).toThrow(/more than 10 rows/);
  });

  it('returns nothing for an empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('withoutBlankRows', () => {
  it('drops empty rows but keeps the original row numbers', () => {
    // Spreadsheets carry hundreds of blank rows below the data. Dropping them without
    // renumbering is what keeps "row 4 is wrong" pointing at row 4 on screen.
    const rows = parseCsv('a,b\n1,2\n,\n\n5,6\n');

    expect(withoutBlankRows(rows)).toEqual([
      { row: 1, values: ['a', 'b'] },
      { row: 2, values: ['1', '2'] },
      { row: 5, values: ['5', '6'] },
    ]);
  });

  it('treats a row of whitespace as blank', () => {
    const rows = parseCsv('a,b\n   ,  \n1,2');

    expect(withoutBlankRows(rows).map((entry) => entry.row)).toEqual([1, 3]);
  });
});
