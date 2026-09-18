/**
 * Optimistic locking (Section 13).
 *
 * The problem this solves is concrete: two bursars open the same student's financial
 * account, both edit, and the second save silently overwrites the first. No error, no
 * audit trail of the lost change, and a balance nobody can explain.
 *
 * Every co-edited row carries a `version` column. An update matches on the version the
 * caller last read and increments it. If zero rows match, someone else got there first,
 * and the caller is told to reload rather than having their write applied blindly.
 *
 * Usage:
 *
 *     const updated = await requireVersionedUpdate(
 *       tx.student.updateMany({
 *         where: { id, schoolId, version: expectedVersion },
 *         data: { ...changes, version: { increment: 1 } },
 *       }),
 *       'student',
 *     );
 */
import { RecordModifiedError } from './errors.js';

export interface UpdateCount {
  readonly count: number;
}

/**
 * Turn a zero-row update into a `RECORD_MODIFIED` response.
 *
 * Note that a zero count is ambiguous: the row may have been changed by someone else, or
 * deleted, or never have matched the scope. All three mean "your write did not apply and
 * you must look again", so one message covers them — and it never reports success for a
 * write that did not happen.
 */
export async function requireVersionedUpdate(
  operation: Promise<UpdateCount>,
  description = 'record',
): Promise<void> {
  const result = await operation;
  if (result.count === 0) {
    throw new RecordModifiedError(
      `This ${description} was changed by someone else while you were editing it. Reload and try again.`,
      { logContext: { description, matchedRows: 0 } },
    );
  }
}

/**
 * Guard for a read-modify-write done in application code rather than in one statement.
 * Prefer `requireVersionedUpdate`: a single conditional UPDATE has no window between the
 * check and the write, whereas this compares a version already in hand.
 */
export function assertVersionMatches(
  current: { version: number },
  expectedVersion: number,
  description = 'record',
): void {
  if (current.version !== expectedVersion) {
    throw new RecordModifiedError(
      `This ${description} was changed by someone else while you were editing it. Reload and try again.`,
      { logContext: { description, expectedVersion, actualVersion: current.version } },
    );
  }
}
