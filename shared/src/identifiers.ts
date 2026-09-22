/**
 * Human-facing identifiers.
 *
 * The Student ID is the primary human-facing identifier for a student (Section 7);
 * names are never treated as unique. Both backend and frontend validate against the
 * same pattern so a typed-in ID is rejected consistently on either side.
 */

/** e.g. `STU-2026-00125` */
export const STUDENT_ID_PATTERN = /^STU-\d{4}-\d{5}$/;

/** e.g. `RCP-2026-000001234` */
export const RECEIPT_NUMBER_PATTERN = /^RCP-\d{4}-\d{9}$/;

/** e.g. `PAY-2026-000001234` */
export const PAYMENT_REFERENCE_PATTERN = /^PAY-\d{4}-\d{9}$/;

export const STUDENT_ID_PREFIX = 'STU';
export const RECEIPT_NUMBER_PREFIX = 'RCP';
export const PAYMENT_REFERENCE_PREFIX = 'PAY';

export const STUDENT_ID_SEQUENCE_WIDTH = 5;
export const RECEIPT_NUMBER_SEQUENCE_WIDTH = 9;
export const PAYMENT_REFERENCE_SEQUENCE_WIDTH = 9;

function pad(sequence: number, width: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Sequence must be a positive integer, received ${String(sequence)}`);
  }
  const text = String(sequence);
  if (text.length > width) {
    throw new RangeError(`Sequence ${text} does not fit in ${String(width)} digits`);
  }
  return text.padStart(width, '0');
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new RangeError(`Year must be a 4-digit integer, received ${String(year)}`);
  }
}

/** Build a Student ID from the admission year and a per-year sequence number. */
export function formatStudentId(year: number, sequence: number): string {
  assertYear(year);
  return `${STUDENT_ID_PREFIX}-${String(year)}-${pad(sequence, STUDENT_ID_SEQUENCE_WIDTH)}`;
}

export function formatReceiptNumber(year: number, sequence: number): string {
  assertYear(year);
  return `${RECEIPT_NUMBER_PREFIX}-${String(year)}-${pad(sequence, RECEIPT_NUMBER_SEQUENCE_WIDTH)}`;
}

/**
 * Build a payment reference from the year and a per-year sequence number.
 *
 * This is the identifier a parent quotes to the bursar's office and the one a
 * reconciliation report will join on, so it comes from the same atomic per-year counter
 * as a Student ID rather than from a row's UUID: a reference has to be readable over the
 * phone, and it must never be issued twice.
 */
export function formatPaymentReference(year: number, sequence: number): string {
  assertYear(year);
  return `${PAYMENT_REFERENCE_PREFIX}-${String(year)}-${pad(sequence, PAYMENT_REFERENCE_SEQUENCE_WIDTH)}`;
}

export function isValidStudentId(value: string): boolean {
  return STUDENT_ID_PATTERN.test(value);
}

export function isValidReceiptNumber(value: string): boolean {
  return RECEIPT_NUMBER_PATTERN.test(value);
}

export function isValidPaymentReference(value: string): boolean {
  return PAYMENT_REFERENCE_PATTERN.test(value);
}

export interface ParsedSequentialId {
  readonly prefix: string;
  readonly year: number;
  readonly sequence: number;
}

/** Split `STU-2026-00125` into its parts, or return null if it is not a valid ID. */
export function parseStudentId(value: string): ParsedSequentialId | null {
  if (!isValidStudentId(value)) return null;
  const [prefix, year, sequence] = value.split('-') as [string, string, string];
  return { prefix, year: Number(year), sequence: Number(sequence) };
}

/**
 * Normalise user-typed input so a Bursar searching `stu 2026 125` or `STU-2026-125`
 * still finds the student. Returns the canonical form when recoverable, else the
 * trimmed upper-cased input for a plain text search.
 */
export function normaliseStudentIdInput(value: string): string {
  const compact = value
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-');
  const match = /^STU-?(\d{4})-?(\d{1,5})$/.exec(compact.replace(/-+/g, '-'));
  if (match) {
    return formatStudentId(Number(match[1]), Number(match[2]));
  }
  return compact;
}
