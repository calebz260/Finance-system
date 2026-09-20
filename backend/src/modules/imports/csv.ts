/**
 * A CSV reader, to RFC 4180.
 *
 * Hand-rolled rather than taken from a package, for the same reason the frontend's
 * `fetch` stub is: the format is small and completely specified, the failure modes are
 * the ones this system actually meets, and a parser is a piece of code that reads
 * untrusted input from outside the school. Fewer moving parts there is worth more than
 * the few lines saved.
 *
 * What it handles, because real exports from Excel contain all of them:
 *
 *  - a UTF-8 byte-order mark, which Excel writes and which otherwise becomes part of
 *    the first column heading and makes every lookup of that column fail;
 *  - quoted fields containing commas, newlines and doubled quotes;
 *  - `CRLF`, `LF` and lone `CR` line endings;
 *  - a trailing newline, which is not an empty final row.
 *
 * What it deliberately does not do is guess. A row with the wrong number of fields is
 * returned as-is and reported by the caller against its row number, rather than being
 * padded or truncated into something plausible.
 */

/** Rows as they appear in the file, including the header. */
export type CsvRows = ReadonlyArray<readonly string[]>;

const BOM = '﻿';

export interface ParseCsvOptions {
  /** Guards against a file that is enormous by accident rather than by intent. */
  readonly maxRows?: number;
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    /** 1-based, matching what the spreadsheet shows. */
    readonly row: number,
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * Parse CSV text into rows of raw strings.
 *
 * No type coercion happens here: everything is a string, and interpreting it is the
 * importer's job, where a bad value can be reported against a column and a row.
 */
export function parseCsv(input: string, options: ParseCsvOptions = {}): CsvRows {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let rowNumber = 1;

  const endField = (): void => {
    row.push(field);
    field = '';
  };

  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    rowNumber += 1;

    if (rows.length > maxRows) {
      throw new CsvParseError(
        `This file has more than ${String(maxRows)} rows. Split it and import in batches.`,
        rowNumber,
      );
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char !== '"') {
        field += char;
        continue;
      }

      // A doubled quote inside a quoted field is a literal quote.
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }

      inQuotes = false;
      continue;
    }

    if (char === '"') {
      // Quotes only open a field at its start; anywhere else they are literal, which
      // is what a spreadsheet exporting `5" pipe` produces.
      if (field === '') {
        inQuotes = true;
        continue;
      }
      field += char;
      continue;
    }

    if (char === ',') {
      endField();
      continue;
    }

    if (char === '\r') {
      // Consume CRLF as one terminator; a lone CR is an old Mac line ending.
      if (text[index + 1] === '\n') index += 1;
      endRow();
      continue;
    }

    if (char === '\n') {
      endRow();
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new CsvParseError(
      'A quoted value is not closed. Check for a stray double quote.',
      rowNumber,
    );
  }

  // A trailing newline ends the last row rather than starting an empty one.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Drop rows that are entirely empty.
 *
 * Spreadsheets routinely carry hundreds of blank rows below the data, and reporting
 * "row 1043: first name is required" for each of them would bury the real problems.
 * Row numbers are preserved so the ones that remain still point at the right line.
 */
export function withoutBlankRows(
  rows: CsvRows,
): ReadonlyArray<{ row: number; values: readonly string[] }> {
  return rows
    .map((values, index) => ({ row: index + 1, values }))
    .filter((entry) => entry.values.some((value) => value.trim() !== ''));
}
