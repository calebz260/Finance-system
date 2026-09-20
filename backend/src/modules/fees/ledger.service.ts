/**
 * Posting to the financial ledger.
 *
 * Every entry in `financial_entries` is written through this module, and every one of
 * those writes happens inside the caller's transaction. That is deliberate: an entry is
 * only ever posted *because* a business record was created or approved, and if that
 * record rolls back, the money it moved must roll back with it. A ledger that can
 * disagree with the records justifying it is worse than no ledger.
 *
 * The rules, in one place:
 *
 *  - **Insert only.** There is no update and no delete. An entry that turns out to be
 *    wrong is undone by posting an opposing entry linked through `reversalOfEntryId`, so
 *    the ledger records that something was undone as well as that it happened (Section
 *    20). Phase 11 revokes UPDATE and DELETE on the table from the application role.
 *  - **Amounts are positive; direction is `entryType`.** No call site has to remember a
 *    sign convention, and no sum has to guess one.
 *  - **One opening entry per source record.** Enforced by partial unique indexes, so a
 *    retried request or two concurrent approvals cannot both credit the same discount.
 *  - **The account is opened on demand.** A student gets a financial account the first
 *    time anything financial happens to them, rather than on registration, so the table
 *    holds accounts that mean something.
 */
import { type CurrencyCode, type Money } from '@sfs/shared';

import type { EntryDirection, FinancialEntrySource } from '../../generated/prisma/enums.js';
import type { PrismaTransactionClient } from '../../lib/prisma.js';
import { feeRepository } from './fee.repository.js';

/** Which source record an entry is being posted for. Exactly one id is set. */
export type EntrySourceRef =
  | { readonly source: 'CHARGE'; readonly studentChargeId: string }
  | { readonly source: 'DISCOUNT'; readonly discountId: string }
  | { readonly source: 'SCHOLARSHIP'; readonly studentScholarshipId: string }
  | { readonly source: 'WAIVER'; readonly feeWaiverId: string }
  | { readonly source: 'ADJUSTMENT'; readonly financialAdjustmentId: string };

export interface PostEntryInput {
  readonly schoolId: string;
  readonly studentId: string;
  readonly academicYearId: string;
  readonly termId: string | null;
  readonly entryType: EntryDirection;
  readonly amount: Money;
  readonly description: string;
  readonly ref: EntrySourceRef;
  readonly postedByUserId: string;
  /** The charge this entry applies to, when the source is relief against one. */
  readonly studentChargeId?: string | null;
}

/** Turn a source reference into the column set the row needs. */
function refColumns(ref: EntrySourceRef): {
  source: FinancialEntrySource;
  studentChargeId?: string;
  discountId?: string;
  studentScholarshipId?: string;
  feeWaiverId?: string;
  financialAdjustmentId?: string;
} {
  switch (ref.source) {
    case 'CHARGE':
      return { source: 'CHARGE', studentChargeId: ref.studentChargeId };
    case 'DISCOUNT':
      return { source: 'DISCOUNT', discountId: ref.discountId };
    case 'SCHOLARSHIP':
      return { source: 'SCHOLARSHIP', studentScholarshipId: ref.studentScholarshipId };
    case 'WAIVER':
      return { source: 'WAIVER', feeWaiverId: ref.feeWaiverId };
    case 'ADJUSTMENT':
      return { source: 'ADJUSTMENT', financialAdjustmentId: ref.financialAdjustmentId };
  }
}

/**
 * The student's account, opening it if this is their first financial activity.
 *
 * The currency is copied from school settings at opening and then belongs to the account,
 * so a school that changes its currency later cannot silently reinterpret the history
 * already posted.
 */
export async function ensureAccount(
  args: { schoolId: string; studentId: string },
  client: PrismaTransactionClient,
): Promise<{ id: string; currency: CurrencyCode }> {
  const currency = await feeRepository.findSchoolCurrency(args.schoolId);
  const account = await feeRepository.ensureAccount(
    { schoolId: args.schoolId, studentId: args.studentId, currency },
    client,
  );
  return { id: account.id, currency: account.currency as CurrencyCode };
}

/**
 * Post one entry.
 *
 * Refuses a non-positive amount before it reaches the database. The check constraint
 * would catch it too, but a domain error naming the amount is far more useful during
 * development than a constraint violation naming a column.
 */
export async function postEntry(
  input: PostEntryInput,
  client: PrismaTransactionClient,
): Promise<{ id: string }> {
  if (!input.amount.isPositive()) {
    throw new Error(
      `Refusing to post a ledger entry of ${input.amount.toString()}: entries are strictly positive and carry direction in entryType.`,
    );
  }

  const account = await ensureAccount(
    { schoolId: input.schoolId, studentId: input.studentId },
    client,
  );
  const columns = refColumns(input.ref);

  return feeRepository.postEntry(
    {
      schoolId: input.schoolId,
      accountId: account.id,
      studentId: input.studentId,
      academicYearId: input.academicYearId,
      termId: input.termId,
      entryType: input.entryType,
      amount: input.amount.toString(),
      description: input.description,
      postedByUserId: input.postedByUserId,
      ...columns,
      // Relief against a specific charge carries the charge id as well as its own source
      // id, so "what has been taken off this charge?" is one indexed read.
      ...(input.studentChargeId != null && columns.studentChargeId === undefined
        ? { studentChargeId: input.studentChargeId }
        : {}),
    },
    client,
  );
}

/**
 * Undo an entry by posting its opposite.
 *
 * The original is left exactly as it was. The reversal carries the opposite direction,
 * the same amount and a link back, so the ledger reads as two facts — it happened, then
 * it was undone — rather than as one fact that has been edited.
 *
 * Returns false when there is nothing live to reverse, which is not an error: a rejected
 * request never posted anything, and an already-reversed one must not be reversed twice.
 */
export async function reverseEntryFor(
  ref: EntrySourceRef,
  args: { description: string; postedByUserId: string },
  client: PrismaTransactionClient,
): Promise<boolean> {
  const columns = refColumns(ref);
  const opening = await feeRepository.findOpeningEntry(
    {
      source: columns.source,
      ...(columns.discountId !== undefined ? { discountId: columns.discountId } : {}),
      ...(columns.studentScholarshipId !== undefined
        ? { studentScholarshipId: columns.studentScholarshipId }
        : {}),
      ...(columns.feeWaiverId !== undefined ? { feeWaiverId: columns.feeWaiverId } : {}),
      ...(columns.financialAdjustmentId !== undefined
        ? { financialAdjustmentId: columns.financialAdjustmentId }
        : {}),
      ...(columns.source === 'CHARGE' && columns.studentChargeId !== undefined
        ? { studentChargeId: columns.studentChargeId }
        : {}),
    },
    client,
  );

  if (opening === null) return false;

  await feeRepository.postEntry(
    {
      schoolId: opening.schoolId,
      accountId: opening.accountId,
      studentId: opening.studentId,
      academicYearId: opening.academicYearId,
      termId: opening.termId,
      // The opposite direction. This is the whole mechanism.
      entryType: opening.entryType === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amount: opening.amount.toString(),
      description: args.description,
      postedByUserId: args.postedByUserId,
      reversalOfEntryId: opening.id,
      ...columns,
    },
    client,
  );

  return true;
}
