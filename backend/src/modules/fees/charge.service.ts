/**
 * Student charges: the actual financial obligations, and how they are generated.
 *
 * The distinction this module exists to protect is that a fee structure is a *rule* and
 * a charge is a *fact*. A charge copies the amount and the label at the moment it is
 * raised and never consults the structure again, so editing or archiving a structure
 * cannot change what a family was told they owed (Section 12).
 *
 * Generation, in order:
 *
 *  1. Load every ACTIVE structure for the period, and every currently ENROLLED student.
 *  2. Match each student against each structure **using that student's own enrolment**.
 *     Applicability is a filter: a structure matches when every field it specifies
 *     matches, and a null field does not narrow. There is no precedence, so no rule has
 *     to be remembered to predict the outcome.
 *  3. Detect overlaps — two matching structures charging one student the same category —
 *     and refuse the whole run if any exist (ADR-019). A double charge is worse than a
 *     failed run, and it is almost always a misconfiguration.
 *  4. Skip pairs that already carry a live charge, so re-running is safe.
 *  5. Write everything in one transaction.
 *
 * The duplicate key itself lives in the database as two partial unique indexes, so a
 * concurrent second run racing this one fails on the constraint rather than on a check
 * that passed a moment ago (Section 33).
 */
import {
  type ChargeRunConflict,
  type ChargeRunPreview,
  type ChargeRunPreviewLine,
  type ChargeRunResult,
  type CurrencyCode,
  ErrorCode,
  Money,
  type StudentChargeSummary,
} from '@sfs/shared';

import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../generated/prisma/client.js';
import { ConflictError, DomainError, NotFoundError } from '../../lib/errors.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { academicRepository } from '../academic/academic.repository.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { computeChargeNet } from './balance.service.js';
import { postEntry, reverseEntryFor } from './ledger.service.js';
import {
  type ChargeableStudent,
  type ChargeFilters,
  feeRepository,
  type FeeStructureRecord,
  type StudentChargeRecord,
} from './fee.repository.js';
import type { ChargeRunBody, CreateChargeBody, VoidChargeBody } from './fee.schema.js';

/** How many preview lines are returned. Enough to eyeball; never the whole roll. */
const PREVIEW_SAMPLE_LIMIT = 50;

/* ---------------------------------------------------------------- projection */

/** Nothing has been applied to a charge yet. Named so the intent reads at call sites. */
const NOTHING_APPLIED = { credit: '0', debit: '0' } as const;

function toChargeSummary(
  charge: StudentChargeRecord,
  appliedAgainstIt: { credit: string; debit: string },
  currency: CurrencyCode,
): StudentChargeSummary {
  const amounts = computeChargeNet(
    Money.fromDatabase(charge.amount, currency).toString(),
    appliedAgainstIt,
    currency,
  );

  return {
    id: charge.id,
    studentId: charge.studentId,
    studentNumber: charge.student.studentId,
    studentName: `${charge.student.firstName} ${charge.student.lastName}`,
    academicYearId: charge.academicYearId,
    academicYearName: charge.academicYear.name,
    termId: charge.termId,
    termName: charge.term?.name ?? null,
    feeCategoryId: charge.feeCategoryId,
    feeCategoryName: charge.feeCategory.name,
    feeStructureId: charge.feeStructureId,
    feeStructureName: charge.feeStructure?.name ?? null,
    description: charge.description,
    amount: amounts.amount.toString(),
    adjustedAmount: amounts.adjusted.toString(),
    netAmount: amounts.net.toString(),
    status: charge.status,
    notes: charge.notes,
    raisedAt: charge.raisedAt.toISOString(),
    voidedAt: charge.voidedAt?.toISOString() ?? null,
    voidReason: charge.voidReason,
    version: charge.version,
  };
}

async function currencyFor(principal: Principal, schoolId: string): Promise<CurrencyCode> {
  void principal;
  return (await feeRepository.findSchoolCurrency(schoolId)) as CurrencyCode;
}

/* ----------------------------------------------------------------- matching */

/**
 * Does this structure apply to this student?
 *
 * Every field the structure specifies must match the student's own enrolment. A null
 * field does not narrow. Note what is *not* here: no fallback, no "closest match", no
 * defaulting. A structure that names a class the student is not in simply does not
 * apply, which is the only reading that cannot accidentally charge one student using
 * another student's placement (Section 10).
 */
export function structureApplies(
  structure: Pick<FeeStructureRecord, 'programId' | 'levelId' | 'classSectionId' | 'residency'>,
  student: Pick<ChargeableStudent, 'programId' | 'levelId' | 'classSectionId' | 'residency'>,
): boolean {
  if (structure.programId !== null && structure.programId !== student.programId) return false;
  if (structure.levelId !== null && structure.levelId !== student.levelId) return false;
  if (structure.classSectionId !== null && structure.classSectionId !== student.classSectionId) {
    return false;
  }
  if (structure.residency !== null && structure.residency !== student.residency) return false;
  return true;
}

interface PlannedCharge {
  readonly student: ChargeableStudent;
  readonly structure: FeeStructureRecord;
  readonly item: FeeStructureRecord['items'][number];
  readonly alreadyCharged: boolean;
}

/**
 * Work out what a run would do, without writing anything.
 *
 * Shared by the preview and the commit so the two cannot disagree — a preview that is
 * computed differently from the write it previews is worse than no preview.
 */
function planRun(
  structures: readonly FeeStructureRecord[],
  students: readonly ChargeableStudent[],
  existingKeys: ReadonlySet<string>,
): { planned: PlannedCharge[]; conflicts: ChargeRunConflict[] } {
  const planned: PlannedCharge[] = [];

  // category -> structures that would charge it -> students affected
  const overlaps = new Map<
    string,
    { categoryName: string; structures: Map<string, string>; students: Set<string> }
  >();

  for (const student of students) {
    const chargedCategories = new Map<string, { structureId: string; structureName: string }>();

    for (const structure of structures) {
      if (!structureApplies(structure, student)) continue;

      for (const item of structure.items) {
        const seen = chargedCategories.get(item.feeCategoryId);
        if (seen !== undefined && seen.structureId !== structure.id) {
          const entry = overlaps.get(item.feeCategoryId) ?? {
            categoryName: item.feeCategory.name,
            structures: new Map<string, string>(),
            students: new Set<string>(),
          };
          entry.structures.set(seen.structureId, seen.structureName);
          entry.structures.set(structure.id, structure.name);
          entry.students.add(student.studentId);
          overlaps.set(item.feeCategoryId, entry);
          continue;
        }
        chargedCategories.set(item.feeCategoryId, {
          structureId: structure.id,
          structureName: structure.name,
        });

        planned.push({
          student,
          structure,
          item,
          alreadyCharged: existingKeys.has(`${student.studentId}:${item.id}`),
        });
      }
    }
  }

  const conflicts: ChargeRunConflict[] = [...overlaps.values()].map((entry) => ({
    feeCategoryName: entry.categoryName,
    feeStructureIds: [...entry.structures.keys()],
    feeStructureNames: [...entry.structures.values()],
    affectedStudentCount: entry.students.size,
  }));

  return { planned, conflicts };
}

/** Load the period, the structures and the students a run operates over. */
async function loadRunInputs(
  principal: Principal,
  input: ChargeRunBody,
): Promise<{
  structures: FeeStructureRecord[];
  students: ChargeableStudent[];
  existingKeys: Set<string>;
  termId: string | null;
}> {
  const year = await academicRepository.findAcademicYear(principal.scope, input.academicYearId);
  if (year === null) throw new NotFoundError('That academic year was not found.');
  if (year.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.PERIOD_CLOSED,
      'That academic year is closed. Charges cannot be raised into a period that has been signed off.',
    );
  }

  const termId = input.termId ?? null;
  if (termId !== null) {
    const term = await academicRepository.findTerm(principal.scope, termId);
    if (term === null) throw new NotFoundError('That term was not found.');
    if (term.academicYearId !== input.academicYearId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That term belongs to a different academic year.',
      );
    }
    if (term.status === 'CLOSED') {
      throw new DomainError(
        ErrorCode.PERIOD_CLOSED,
        'That term is closed. Charges cannot be raised into it.',
      );
    }
  }

  const [structures, students, existingKeys] = await Promise.all([
    feeRepository.findActiveStructuresForPeriod(principal.scope, {
      academicYearId: input.academicYearId,
      termId,
      ...(input.feeStructureId !== undefined ? { feeStructureId: input.feeStructureId } : {}),
    }),
    feeRepository.findEnrolledStudents(principal.scope, input.academicYearId),
    feeRepository.findExistingChargeKeys(principal.scope, {
      academicYearId: input.academicYearId,
      termId,
    }),
  ]);

  return { structures, students, existingKeys, termId };
}

/* ---------------------------------------------------------------- commands */

export async function previewChargeRun(
  principal: Principal,
  input: ChargeRunBody,
): Promise<ChargeRunPreview> {
  const schoolId = principal.scope.requireSchoolId();
  const currency = await currencyFor(principal, schoolId);
  const { structures, students, existingKeys, termId } = await loadRunInputs(principal, input);

  const { planned, conflicts } = planRun(structures, students, existingKeys);
  const toCreate = planned.filter((entry) => !entry.alreadyCharged);

  const total = Money.sum(
    toCreate.map((entry) => Money.fromDatabase(entry.item.amount, currency)),
    currency,
  );

  const sample: ChargeRunPreviewLine[] = planned.slice(0, PREVIEW_SAMPLE_LIMIT).map((entry) => ({
    studentId: entry.student.studentId,
    studentNumber: entry.student.studentNumber,
    studentName: `${entry.student.firstName} ${entry.student.lastName}`,
    feeStructureId: entry.structure.id,
    feeStructureName: entry.structure.name,
    feeCategoryName: entry.item.feeCategory.name,
    description: entry.item.label,
    amount: Money.fromDatabase(entry.item.amount, currency).toString(),
    alreadyCharged: entry.alreadyCharged,
  }));

  return {
    academicYearId: input.academicYearId,
    termId,
    studentsMatched: new Set(planned.map((entry) => entry.student.studentId)).size,
    chargesToCreate: toCreate.length,
    chargesToSkip: planned.length - toCreate.length,
    totalAmount: total.toString(),
    conflicts,
    sample,
    sampleTruncated: planned.length > PREVIEW_SAMPLE_LIMIT,
  };
}

/**
 * Apply a run.
 *
 * Refuses on any overlap before writing. Everything else happens inside one transaction:
 * a run that creates 800 of 1,000 charges and then fails leaves a term half-billed,
 * which is far harder to recover from than a run that did nothing.
 */
export async function applyChargeRun(
  principal: Principal,
  input: ChargeRunBody,
): Promise<ChargeRunResult> {
  const schoolId = principal.scope.requireSchoolId();
  const currency = await currencyFor(principal, schoolId);
  const { structures, students, existingKeys, termId } = await loadRunInputs(principal, input);

  const { planned, conflicts } = planRun(structures, students, existingKeys);

  if (conflicts.length > 0) {
    const summary = conflicts
      .map(
        (conflict) =>
          `${conflict.feeCategoryName} (${conflict.feeStructureNames.join(' and ')}, ` +
          `${String(conflict.affectedStudentCount)} student(s))`,
      )
      .join('; ');

    throw new ConflictError(
      `Two fee structures would charge the same category to the same students: ${summary}. ` +
        'Nothing was written. Narrow one structure, or archive it, and run again.',
      ErrorCode.CONFLICT,
      { details: { conflicts } },
    );
  }

  const toCreate = planned.filter((entry) => !entry.alreadyCharged);
  const total = Money.sum(
    toCreate.map((entry) => Money.fromDatabase(entry.item.amount, currency)),
    currency,
  );
  const studentsMatched = new Set(planned.map((entry) => entry.student.studentId)).size;

  const runId = await prisma.$transaction(async (tx) => {
    const run = await feeRepository.createChargeRun(
      {
        schoolId,
        academicYearId: input.academicYearId,
        termId,
        feeStructureId: input.feeStructureId ?? null,
        status: 'APPLIED',
        studentsMatched,
        chargesCreated: toCreate.length,
        chargesSkipped: planned.length - toCreate.length,
        totalAmount: total.toString(),
        executedByUserId: principal.userId,
      },
      tx,
    );

    if (toCreate.length > 0) {
      // Ids are generated here rather than by the database, because each charge's ledger
      // entry has to name the charge it debits and `createMany` does not return ids.
      // Two bulk inserts beat a thousand round trips.
      const rows = toCreate.map((entry) => ({
        id: randomUUID(),
        schoolId,
        studentId: entry.student.studentId,
        enrollmentId: entry.student.enrollmentId,
        academicYearId: input.academicYearId,
        termId,
        feeCategoryId: entry.item.feeCategoryId,
        feeStructureId: entry.structure.id,
        feeStructureItemId: entry.item.id,
        chargeRunId: run.id,
        // Snapshots. The structure may be archived or its label changed tomorrow; this
        // charge keeps saying what it said today.
        description: entry.item.label,
        amount: Money.fromDatabase(entry.item.amount, currency).toString(),
        raisedByUserId: principal.userId,
      })) satisfies Prisma.StudentChargeCreateManyInput[];

      await feeRepository.createChargesInBulk(rows, tx);

      const accounts = await feeRepository.ensureAccountsForStudents(
        {
          schoolId,
          studentIds: [...new Set(toCreate.map((entry) => entry.student.studentId))],
          currency,
        },
        tx,
      );

      // Every charge debits the ledger. Posted in the same transaction as the charges,
      // so a failure cannot leave obligations that no balance reflects.
      const entries = rows.map((row) => ({
        schoolId,
        accountId: accounts.get(row.studentId)!,
        studentId: row.studentId,
        academicYearId: row.academicYearId,
        termId: row.termId,
        entryType: 'DEBIT' as const,
        amount: row.amount,
        source: 'CHARGE' as const,
        studentChargeId: row.id,
        description: row.description,
        postedByUserId: principal.userId,
      })) satisfies Prisma.FinancialEntryCreateManyInput[];

      await feeRepository.postEntries(entries, tx);
    }

    await record(
      {
        action: AuditAction.CHARGE_RUN_APPLIED,
        entityType: AuditEntity.CHARGE_RUN,
        entityId: run.id,
        afterState: {
          academicYearId: input.academicYearId,
          termId,
          feeStructureId: input.feeStructureId ?? null,
          studentsMatched,
          chargesCreated: toCreate.length,
          chargesSkipped: planned.length - toCreate.length,
          totalAmount: total.toString(),
        },
      },
      tx,
    );

    return run.id;
  });

  return {
    chargeRunId: runId,
    studentsMatched,
    chargesCreated: toCreate.length,
    chargesSkipped: planned.length - toCreate.length,
    totalAmount: total.toString(),
  };
}

export async function listCharges(
  principal: Principal,
  filters: ChargeFilters,
  pagination: ResolvedPagination,
): Promise<{ items: readonly StudentChargeSummary[]; totalItems: number }> {
  const result = await feeRepository.listCharges(principal.scope, filters, pagination);
  // One grouped read for the whole page rather than one per row: a 200-row charge list
  // would otherwise be 200 extra queries.
  const applied = await feeRepository.sumEntriesByCharge(result.items.map((charge) => charge.id));

  const schoolId = principal.scope.schoolId;
  const currency =
    schoolId === null ? ('RWF' as CurrencyCode) : await currencyFor(principal, schoolId);

  return {
    items: result.items.map((charge) =>
      toChargeSummary(charge, applied.get(charge.id) ?? NOTHING_APPLIED, currency),
    ),
    totalItems: result.totalItems,
  };
}

export async function getCharge(
  principal: Principal,
  chargeId: string,
): Promise<StudentChargeSummary> {
  const charge = await feeRepository.findChargeById(chargeId);
  principal.scope.assertPermits(charge, 'charge');
  if (charge === null) throw new NotFoundError('The requested charge was not found.');

  const currency = await currencyFor(principal, charge.schoolId);
  const applied = await feeRepository.sumEntriesByCharge([chargeId]);
  return toChargeSummary(charge, applied.get(chargeId) ?? NOTHING_APPLIED, currency);
}

/**
 * Raise a one-off charge against a single student.
 *
 * Deliberately carries no fee-structure item, which exempts it from the duplicate key.
 * That is the supported way to charge a student a second time in a category they already
 * hold — a resit fee, a replacement textbook — and the mandatory note is what keeps the
 * exemption deliberate rather than a loophole.
 */
export async function createAdHocCharge(
  principal: Principal,
  input: CreateChargeBody,
): Promise<StudentChargeSummary> {
  const schoolId = principal.scope.requireSchoolId();

  const year = await academicRepository.findAcademicYear(principal.scope, input.academicYearId);
  if (year === null) throw new NotFoundError('That academic year was not found.');
  if (year.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.PERIOD_CLOSED,
      'That academic year is closed. A charge cannot be raised into it.',
    );
  }

  if (input.termId != null) {
    const term = await academicRepository.findTerm(principal.scope, input.termId);
    if (term === null) throw new NotFoundError('That term was not found.');
    if (term.academicYearId !== input.academicYearId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That term belongs to a different academic year.',
      );
    }
    if (term.status === 'CLOSED') {
      throw new DomainError(
        ErrorCode.PERIOD_CLOSED,
        'That term is closed. A charge cannot be raised into it.',
      );
    }
  }

  const category = await feeRepository.findCategoryById(input.feeCategoryId);
  principal.scope.assertPermits(category, 'fee category');
  if (category === null) throw new NotFoundError('That fee category was not found.');

  // The enrolment is what pins the charge to the student's placement at this moment. A
  // student with no live enrolment for the year cannot be charged for it — there is no
  // level, class or programme to attribute the charge to.
  const enrolments = await feeRepository.findEnrolledStudents(
    principal.scope,
    input.academicYearId,
  );
  const enrolment = enrolments.find((candidate) => candidate.studentId === input.studentId);
  if (enrolment === undefined) {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      'That student has no active enrolment for this academic year, so there is nothing to charge against.',
    );
  }

  const currency = await currencyFor(principal, schoolId);

  // The charge and the DEBIT it posts are one operation. A charge with no ledger entry
  // would be an obligation that no balance reflects, which is the worst of both worlds:
  // visible on the student's record, invisible in what they owe.
  const created = await prisma.$transaction(async (tx) => {
    const charge = await feeRepository.createCharge(
      {
        schoolId,
        studentId: input.studentId,
        enrollmentId: enrolment.enrollmentId,
        academicYearId: input.academicYearId,
        termId: input.termId ?? null,
        feeCategoryId: input.feeCategoryId,
        description: input.description,
        amount: input.amount,
        notes: input.notes,
        raisedByUserId: principal.userId,
      },
      tx,
    );

    await postEntry(
      {
        schoolId,
        studentId: input.studentId,
        academicYearId: input.academicYearId,
        termId: input.termId ?? null,
        entryType: 'DEBIT',
        amount: Money.of(input.amount, currency),
        description: input.description,
        ref: { source: 'CHARGE', studentChargeId: charge.id },
        postedByUserId: principal.userId,
      },
      tx,
    );

    await record(
      {
        action: AuditAction.CHARGE_RAISED,
        entityType: AuditEntity.STUDENT_CHARGE,
        entityId: charge.id,
        reason: input.notes,
        afterState: {
          studentId: input.studentId,
          feeCategoryId: input.feeCategoryId,
          academicYearId: input.academicYearId,
          termId: input.termId ?? null,
          description: input.description,
          amount: input.amount,
          adHoc: true,
        },
      },
      tx,
    );

    return charge;
  });

  return toChargeSummary(created, NOTHING_APPLIED, currency);
}

/**
 * Void a charge raised in error.
 *
 * Not a delete. The row stays, excluded from every balance, carrying who voided it and
 * why — and a voided charge no longer blocks the duplicate key, so the correct charge
 * can be raised in its place (Section 20).
 *
 * Refuses while approved credits still point at it: unwinding the charge under an
 * approved waiver would leave the waiver crediting something that no longer exists.
 */
export async function voidCharge(
  principal: Principal,
  chargeId: string,
  input: VoidChargeBody,
): Promise<StudentChargeSummary> {
  const charge = await feeRepository.findChargeById(chargeId);
  principal.scope.assertPermits(charge, 'charge');
  if (charge === null) throw new NotFoundError('The requested charge was not found.');

  if (charge.status === 'VOID') {
    throw new ConflictError(
      'That charge has already been voided.',
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }

  const currency = await currencyFor(principal, charge.schoolId);
  const applied = await feeRepository.sumEntriesByCharge([chargeId]);
  const net = computeChargeNet(
    Money.fromDatabase(charge.amount, currency).toString(),
    applied.get(chargeId) ?? NOTHING_APPLIED,
    currency,
  );

  if (net.adjusted.isPositive()) {
    throw new ConflictError(
      'That charge carries approved relief. Reverse it first, so the record still explains itself.',
      ErrorCode.PRECONDITION_FAILED,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const voided = await feeRepository.voidCharge(
      chargeId,
      input.expectedVersion,
      {
        voidedByUserId: principal.userId,
        voidedAt: new Date(),
        voidReason: input.reason,
      },
      tx,
    );

    // The ledger is insert-only, so the charge's DEBIT is not removed — an opposing
    // CREDIT is posted. The balance nets to the same place, and the account still shows
    // that the charge was raised and then withdrawn.
    await reverseEntryFor(
      { source: 'CHARGE', studentChargeId: chargeId },
      {
        description: `Void of ${charge.description}`,
        postedByUserId: principal.userId,
      },
      tx,
    );

    await record(
      {
        action: AuditAction.CHARGE_VOIDED,
        entityType: AuditEntity.STUDENT_CHARGE,
        entityId: chargeId,
        reason: input.reason,
        beforeState: {
          status: charge.status,
          amount: Money.fromDatabase(charge.amount).toString(),
        },
        afterState: {
          status: voided.status,
          voidedByUserId: principal.userId,
          ledgerEntryReversed: true,
        },
      },
      tx,
    );

    return voided;
  });

  return toChargeSummary(updated, NOTHING_APPLIED, currency);
}
