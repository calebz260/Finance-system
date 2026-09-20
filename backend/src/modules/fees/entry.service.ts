/**
 * Reading the ledger.
 *
 * Separate from `ledger.service.ts`, which writes it. The split is deliberate: writing
 * an entry is only ever done from inside another operation's transaction, while reading
 * one is an ordinary query anyone with `charge.read` may make. Keeping them apart means
 * a read path cannot accidentally acquire a way to post.
 */
import { type FinancialEntrySummary, Money } from '@sfs/shared';

import { NotFoundError } from '../../lib/errors.js';
import type { Principal } from '../auth/principal.js';
import { feeRepository, type FinancialEntryRecord } from './fee.repository.js';

function toSummary(entry: FinancialEntryRecord): FinancialEntrySummary {
  return {
    id: entry.id,
    entryType: entry.entryType,
    amount: Money.fromDatabase(entry.amount).toString(),
    source: entry.source,
    description: entry.description,
    academicYearId: entry.academicYearId,
    termId: entry.termId,
    termName: entry.term?.name ?? null,
    studentChargeId: entry.studentChargeId,
    reversalOfEntryId: entry.reversalOfEntryId,
    postedByName: `${entry.postedBy.firstName} ${entry.postedBy.lastName}`,
    postedAt: entry.postedAt.toISOString(),
  };
}

/**
 * A student's ledger, oldest first.
 *
 * Chronological rather than newest-first, because a ledger is read as a running account:
 * the balance at the bottom is the one that matters, and each line explains how it got
 * there.
 */
export async function listStudentEntries(
  principal: Principal,
  studentId: string,
  period: { academicYearId?: string | undefined; termId?: string | null | undefined } = {},
): Promise<readonly FinancialEntrySummary[]> {
  const identity = await feeRepository.findStudentIdentity(principal.scope, studentId);
  if (identity === null) throw new NotFoundError('The requested student was not found.');

  const entries = await feeRepository.listEntriesForStudent(principal.scope, {
    studentId,
    ...(period.academicYearId !== undefined ? { academicYearId: period.academicYearId } : {}),
    ...(period.termId !== undefined ? { termId: period.termId } : {}),
  });

  return entries.map(toSummary);
}
