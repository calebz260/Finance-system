/**
 * Allocation of human-facing identifiers: Student IDs and receipt numbers.
 *
 * Correctness requirement: an identifier must never be issued twice. Two students
 * sharing `STU-2026-00125` would corrupt every financial record, receipt and report that
 * references it, and the damage would only surface later, in a reconciliation that does
 * not balance.
 *
 * `MAX(student_id) + 1` is therefore not good enough — it races whenever two
 * registrations, or a bulk import and a registration, overlap. Instead a dedicated
 * counter row is incremented with a single atomic statement:
 *
 *     UPDATE identifier_sequences SET last_value = last_value + 1 ... RETURNING last_value
 *
 * PostgreSQL takes a row lock for the duration of that statement, so concurrent callers
 * are serialised and each receives a distinct value. No advisory lock, no retry loop.
 *
 * Allocation must run inside the same transaction as the insert that consumes it, so a
 * failed registration does not leave a gap.
 */
import { formatReceiptNumber, formatStudentId } from '@sfs/shared';

import { SequenceKind } from '../generated/prisma/enums.js';
import type { PrismaTransactionClient } from './prisma.js';

export { SequenceKind };

/**
 * Reserve the next value for a counter, creating the counter on first use.
 *
 * The upsert-then-increment is expressed as a single statement so that the
 * create-if-missing path is also race-safe: two callers arriving at once for a brand-new
 * year cannot both insert, because the unique constraint turns the loser into an update.
 */
export async function nextSequenceValue(
  tx: PrismaTransactionClient,
  args: { schoolId: string; kind: SequenceKind; year: number },
): Promise<number> {
  const { schoolId, kind, year } = args;

  const rows = await tx.$queryRaw<Array<{ last_value: number }>>`
    INSERT INTO identifier_sequences (id, school_id, kind, year, last_value, created_at, updated_at)
    VALUES (gen_random_uuid(), ${schoolId}::uuid, ${kind}::sequence_kind, ${year}, 1, now(), now())
    ON CONFLICT (school_id, kind, year)
    DO UPDATE SET last_value = identifier_sequences.last_value + 1, updated_at = now()
    RETURNING last_value
  `;

  const value = rows[0]?.last_value;
  if (value === undefined) {
    throw new Error(
      `Failed to allocate a ${kind} identifier for school ${schoolId} in ${String(year)}`,
    );
  }
  return value;
}

/**
 * Allocate the next Student ID, e.g. `STU-2026-00125`.
 *
 * The prefix comes from the school's settings so a school can use its own convention,
 * but the shape (`PREFIX-YYYY-NNNNN`) is fixed and enforced by a database check
 * constraint as well as by the shared validator.
 */
export async function allocateStudentId(
  tx: PrismaTransactionClient,
  args: { schoolId: string; admissionYear: number; prefix?: string },
): Promise<string> {
  const sequence = await nextSequenceValue(tx, {
    schoolId: args.schoolId,
    kind: SequenceKind.STUDENT,
    year: args.admissionYear,
  });

  const identifier = formatStudentId(args.admissionYear, sequence);
  if (args.prefix === undefined || args.prefix === 'STU') return identifier;
  return identifier.replace(/^STU-/, `${args.prefix}-`);
}

/** Allocate the next receipt number, e.g. `RCP-2026-000001234`. */
export async function allocateReceiptNumber(
  tx: PrismaTransactionClient,
  args: { schoolId: string; year: number; prefix?: string },
): Promise<string> {
  const sequence = await nextSequenceValue(tx, {
    schoolId: args.schoolId,
    kind: SequenceKind.RECEIPT,
    year: args.year,
  });

  const identifier = formatReceiptNumber(args.year, sequence);
  if (args.prefix === undefined || args.prefix === 'RCP') return identifier;
  return identifier.replace(/^RCP-/, `${args.prefix}-`);
}
