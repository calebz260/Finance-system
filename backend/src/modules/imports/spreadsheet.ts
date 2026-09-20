/**
 * Turning an uploaded file into rows of strings.
 *
 * Two formats, because a school has both: a CSV exported from anything, and the
 * `.xlsx` the registrar actually keeps the list in. Both end up as the same
 * `{ row, values }` shape, so the importer has one code path and the row numbers
 * match what the person sees on screen.
 *
 * The file is never written to disk. Phase 5 is where upload storage, its path rules
 * and malware scanning are designed; until then an import is parsed in memory and the
 * buffer is discarded when the request ends. That keeps this feature from quietly
 * establishing an upload convention that Phase 5 then has to undo.
 *
 * Cell values are normalised to strings here rather than in the importer, because the
 * two formats disagree about types in ways that matter: a date in `.xlsx` arrives as a
 * `Date`, the same date in CSV arrives as text, and a phone number starting `07` is a
 * number in one and a string in the other.
 */
import ExcelJS from 'exceljs';

import { CsvParseError, parseCsv, withoutBlankRows } from './csv.js';

export interface SheetRow {
  /** 1-based, counting the header, so it matches the spreadsheet on screen. */
  readonly row: number;
  readonly values: readonly string[];
}

export type SheetFormat = 'csv' | 'xlsx';

/** Guards a single request; the route also caps the upload size. */
const MAX_ROWS = 5000;

export class SpreadsheetError extends Error {
  constructor(
    message: string,
    readonly row?: number,
  ) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

/**
 * Decide the format from the file name.
 *
 * The browser's MIME type is not trusted for this: Excel files arrive variously as
 * `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
 * `application/octet-stream` or nothing at all, depending on the operating system.
 * The extension is what the person chose when they saved the file.
 */
export function detectFormat(fileName: string): SheetFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}

/**
 * A single cell as text.
 *
 * `.xlsx` cells are richer than strings, and each of these cases appears in a real
 * school list: a formula cell carrying a cached result, a date, a hyperlinked email,
 * and rich text where the registrar bolded part of a name.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    // Excel dates are stored without a zone; the UTC parts are what was typed.
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('result' in value) {
      // A cached formula result is usually a primitive, but it can also be a date or
      // an error object. Only the forms with a meaningful text rendering are converted;
      // anything else would stringify to "[object Object]" and land in a student record.
      const result: unknown = value.result;
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      if (typeof result === 'string') return result.trim();
      if (typeof result === 'number' || typeof result === 'boolean') return String(result);
      return '';
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    }
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return (
        'text' in value && typeof value.text === 'string' ? value.text : value.hyperlink
      ).trim();
    }
    if ('error' in value) return '';
    return '';
  }

  return String(value).trim();
}

async function readXlsx(buffer: Buffer): Promise<SheetRow[]> {
  const workbook = new ExcelJS.Workbook();

  try {
    // ExcelJS types the reader against the DOM `ArrayBuffer`; a Node Buffer is a view
    // over one, and this is the conversion its own examples use.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    // The underlying message is a zip-parsing detail that means nothing to a registrar.
    throw new SpreadsheetError(
      'That file could not be read as an Excel workbook. Re-save it as .xlsx or export it as CSV.',
    );
  }

  const sheet = workbook.worksheets[0];
  if (sheet === undefined) {
    throw new SpreadsheetError('That workbook has no sheets.');
  }

  const rows: SheetRow[] = [];

  sheet.eachRow({ includeEmpty: false }, (excelRow, rowNumber) => {
    if (rows.length >= MAX_ROWS) return;

    // `row.values` is 1-based with a hole at index 0, which is why this maps by column
    // index rather than iterating the array directly.
    const values: string[] = [];
    const columnCount = Math.max(sheet.columnCount, excelRow.cellCount);
    for (let column = 1; column <= columnCount; column += 1) {
      values.push(cellToString(excelRow.getCell(column).value));
    }

    if (values.some((value) => value !== '')) {
      rows.push({ row: rowNumber, values });
    }
  });

  if (rows.length >= MAX_ROWS) {
    throw new SpreadsheetError(
      `This file has more than ${String(MAX_ROWS)} rows. Split it and import in batches.`,
    );
  }

  return rows;
}

function readCsv(buffer: Buffer): SheetRow[] {
  try {
    const parsed = parseCsv(buffer.toString('utf8'), { maxRows: MAX_ROWS });
    return withoutBlankRows(parsed).map((entry) => ({
      row: entry.row,
      values: entry.values.map((value) => value.trim()),
    }));
  } catch (error) {
    if (error instanceof CsvParseError) {
      throw new SpreadsheetError(error.message, error.row);
    }
    throw error;
  }
}

/**
 * Read an uploaded file into rows.
 *
 * The first row is the header and is returned along with the rest: the importer needs
 * it to map columns, and keeping it in place is what makes every later row number
 * match the spreadsheet.
 */
export async function readSheet(args: { fileName: string; buffer: Buffer }): Promise<SheetRow[]> {
  const format = detectFormat(args.fileName);
  if (format === null) {
    throw new SpreadsheetError('Upload a .csv or .xlsx file.');
  }
  if (args.buffer.length === 0) {
    throw new SpreadsheetError('That file is empty.');
  }

  const rows = format === 'csv' ? readCsv(args.buffer) : await readXlsx(args.buffer);

  if (rows.length === 0) {
    throw new SpreadsheetError('That file has no rows.');
  }
  if (rows.length === 1) {
    throw new SpreadsheetError('That file has a header row but no student rows beneath it.');
  }

  return rows;
}
