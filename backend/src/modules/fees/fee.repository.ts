/**
 * Fee, charge and adjustment data access.
 *
 * One repository for the whole financial configuration because the reads cross it
 * constantly: a charge names a structure item, which names a category, and a balance
 * sums charges and adjustments together. Splitting them would mean a service reaching
 * into two repositories to answer one question, which is how tenant scoping gets
 * forgotten.
 *
 * Two things here are load-bearing:
 *
 *  - **Money never leaves as a number.** Every monetary column is selected as a Prisma
 *    Decimal and converted through `Money` by the service. Nothing in this file does
 *    arithmetic.
 *  - **Aggregates are computed by PostgreSQL, not in Node.** A balance sums over a
 *    student's whole history; pulling those rows into memory to add them up would be
 *    both slower and a different answer under concurrent writes.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  ApprovalStatus,
  ChargeStatus,
  EntryDirection,
  FeeStructureStatus,
  FinancialEntrySource,
  ResidencyType,
} from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { requireVersionedUpdate } from '../../lib/optimistic-lock.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

/* --------------------------------------------------------------- projections */

const CATEGORY_PROJECTION = {
  id: true,
  code: true,
  name: true,
  description: true,
  isActive: true,
  sortOrder: true,
  version: true,
  _count: { select: { charges: true } },
} as const satisfies Prisma.FeeCategorySelect;

const STRUCTURE_ITEM_PROJECTION = {
  id: true,
  feeCategoryId: true,
  label: true,
  amount: true,
  sortOrder: true,
  feeCategory: { select: { code: true, name: true } },
} as const satisfies Prisma.FeeStructureItemSelect;

const STRUCTURE_PROJECTION = {
  id: true,
  name: true,
  description: true,
  academicYearId: true,
  termId: true,
  programId: true,
  levelId: true,
  classSectionId: true,
  residency: true,
  status: true,
  version: true,
  academicYear: { select: { name: true } },
  term: { select: { name: true } },
  program: { select: { name: true } },
  level: { select: { name: true } },
  classSection: { select: { name: true } },
  items: {
    select: STRUCTURE_ITEM_PROJECTION,
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
  },
  _count: { select: { charges: true } },
} as const satisfies Prisma.FeeStructureSelect;

const CHARGE_PROJECTION = {
  id: true,
  studentId: true,
  academicYearId: true,
  termId: true,
  feeCategoryId: true,
  feeStructureId: true,
  feeStructureItemId: true,
  description: true,
  amount: true,
  status: true,
  notes: true,
  raisedAt: true,
  voidedAt: true,
  voidReason: true,
  version: true,
  student: { select: { studentId: true, firstName: true, lastName: true } },
  academicYear: { select: { name: true } },
  term: { select: { name: true } },
  feeCategory: { select: { name: true } },
  feeStructure: { select: { name: true } },
} as const satisfies Prisma.StudentChargeSelect;

/**
 * The columns every relief record shares.
 *
 * Spread into each of the four projections rather than duplicated, so adding a field to
 * the approval workflow cannot silently leave one of the four behind.
 */
const RELIEF_COMMON = {
  id: true,
  schoolId: true,
  studentId: true,
  studentChargeId: true,
  academicYearId: true,
  termId: true,
  amount: true,
  reason: true,
  status: true,
  requestedByUserId: true,
  requestedAt: true,
  decidedAt: true,
  decisionNote: true,
  reversedAt: true,
  reversalReason: true,
  version: true,
  student: { select: { studentId: true, firstName: true, lastName: true } },
  studentCharge: { select: { description: true } },
  term: { select: { name: true } },
  requestedBy: { select: { firstName: true, lastName: true } },
  decidedBy: { select: { firstName: true, lastName: true } },
} as const;

const DISCOUNT_PROJECTION = {
  ...RELIEF_COMMON,
  method: true,
  percentage: true,
} as const satisfies Prisma.DiscountSelect;

const SCHOLARSHIP_AWARD_PROJECTION = {
  ...RELIEF_COMMON,
  method: true,
  percentage: true,
  scholarshipId: true,
  scholarship: { select: { name: true, code: true } },
} as const satisfies Prisma.StudentScholarshipSelect;

const WAIVER_PROJECTION = { ...RELIEF_COMMON } as const satisfies Prisma.FeeWaiverSelect;

const ADJUSTMENT_PROJECTION = {
  ...RELIEF_COMMON,
  direction: true,
} as const satisfies Prisma.FinancialAdjustmentSelect;

const SCHOLARSHIP_PROJECTION = {
  id: true,
  code: true,
  name: true,
  description: true,
  sponsor: true,
  defaultMethod: true,
  defaultPercentage: true,
  defaultAmount: true,
  isActive: true,
  version: true,
  _count: { select: { awards: true } },
} as const satisfies Prisma.ScholarshipSelect;

const ENTRY_PROJECTION = {
  id: true,
  entryType: true,
  amount: true,
  source: true,
  description: true,
  academicYearId: true,
  termId: true,
  studentChargeId: true,
  reversalOfEntryId: true,
  postedAt: true,
  term: { select: { name: true } },
  postedBy: { select: { firstName: true, lastName: true } },
} as const satisfies Prisma.FinancialEntrySelect;

/** Just enough of an entry to post its reversal against it. */
const OPENING_ENTRY_PROJECTION = {
  id: true,
  schoolId: true,
  accountId: true,
  studentId: true,
  academicYearId: true,
  termId: true,
  entryType: true,
  amount: true,
  description: true,
} as const satisfies Prisma.FinancialEntrySelect;

export type FeeCategoryRecord = Prisma.FeeCategoryGetPayload<{
  select: typeof CATEGORY_PROJECTION;
}>;
export type FeeStructureRecord = Prisma.FeeStructureGetPayload<{
  select: typeof STRUCTURE_PROJECTION;
}>;
export type FeeStructureItemRecord = Prisma.FeeStructureItemGetPayload<{
  select: typeof STRUCTURE_ITEM_PROJECTION;
}>;
export type StudentChargeRecord = Prisma.StudentChargeGetPayload<{
  select: typeof CHARGE_PROJECTION;
}>;
export type DiscountRecord = Prisma.DiscountGetPayload<{ select: typeof DISCOUNT_PROJECTION }>;
export type ScholarshipAwardRecord = Prisma.StudentScholarshipGetPayload<{
  select: typeof SCHOLARSHIP_AWARD_PROJECTION;
}>;
export type WaiverRecord = Prisma.FeeWaiverGetPayload<{ select: typeof WAIVER_PROJECTION }>;
export type AdjustmentRecord = Prisma.FinancialAdjustmentGetPayload<{
  select: typeof ADJUSTMENT_PROJECTION;
}>;
export type ScholarshipRecord = Prisma.ScholarshipGetPayload<{
  select: typeof SCHOLARSHIP_PROJECTION;
}>;
export type FinancialEntryRecord = Prisma.FinancialEntryGetPayload<{
  select: typeof ENTRY_PROJECTION;
}>;
export type OpeningEntry = Prisma.FinancialEntryGetPayload<{
  select: typeof OPENING_ENTRY_PROJECTION;
}>;

/** Which relief table a record lives in. */
export type ReliefKind = 'DISCOUNT' | 'SCHOLARSHIP' | 'WAIVER' | 'ADJUSTMENT';

/**
 * The fields a status transition may set.
 *
 * Shared across the four tables, which is safe because their approval columns are
 * identical by design — the workflow is one workflow.
 */
export interface ReliefTransitionData {
  readonly status: ApprovalStatus;
  readonly decidedByUserId?: string | null;
  readonly decidedAt?: Date | null;
  readonly decisionNote?: string | null;
  readonly reversedByUserId?: string | null;
  readonly reversedAt?: Date | null;
  readonly reversalReason?: string | null;
}

/** One row of a ledger `groupBy`: a direction, a source and their total. */
export interface LedgerTotalRow {
  readonly entryType: EntryDirection;
  readonly source: FinancialEntrySource;
  readonly total: string;
}

/* ------------------------------------------------------------------ filters */

export interface FeeStructureFilters {
  readonly academicYearId?: string | undefined;
  readonly termId?: string | undefined;
  readonly levelId?: string | undefined;
  readonly programId?: string | undefined;
  readonly status?: FeeStructureStatus | undefined;
}

export interface ChargeFilters {
  readonly studentId?: string | undefined;
  readonly academicYearId?: string | undefined;
  readonly termId?: string | undefined;
  readonly feeCategoryId?: string | undefined;
  readonly levelId?: string | undefined;
  readonly classSectionId?: string | undefined;
  readonly status?: ChargeStatus | undefined;
  readonly raisedFrom?: Date | undefined;
  readonly raisedTo?: Date | undefined;
}

export interface ReliefFilters {
  readonly studentId?: string | undefined;
  readonly academicYearId?: string | undefined;
  readonly termId?: string | undefined;
  readonly kind?: ReliefKind | undefined;
  readonly status?: ApprovalStatus | undefined;
}

export interface PeriodKey {
  readonly academicYearId: string;
  readonly termId: string | null;
}

/**
 * A student matched by a fee structure's applicability filter, with the enrolment
 * context the charge will be pinned to.
 */
export interface ChargeableStudent {
  readonly studentId: string;
  readonly studentNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly enrollmentId: string;
  readonly levelId: string;
  readonly programId: string;
  readonly classSectionId: string | null;
  readonly residency: ResidencyType;
}

function buildChargeWhere(
  scope: AccessScope,
  filters: ChargeFilters,
): Prisma.StudentChargeWhereInput {
  const raisedAt: Prisma.DateTimeFilter = {};
  if (filters.raisedFrom !== undefined) raisedAt.gte = filters.raisedFrom;
  if (filters.raisedTo !== undefined) raisedAt.lte = filters.raisedTo;

  return {
    ...scope.filter,
    ...(filters.studentId !== undefined ? { studentId: filters.studentId } : {}),
    ...(filters.academicYearId !== undefined ? { academicYearId: filters.academicYearId } : {}),
    ...(filters.termId !== undefined ? { termId: filters.termId } : {}),
    ...(filters.feeCategoryId !== undefined ? { feeCategoryId: filters.feeCategoryId } : {}),
    ...(filters.status !== undefined ? { status: filters.status } : {}),
    ...(filters.levelId !== undefined || filters.classSectionId !== undefined
      ? {
          enrollment: {
            ...(filters.levelId !== undefined ? { levelId: filters.levelId } : {}),
            ...(filters.classSectionId !== undefined
              ? { classSectionId: filters.classSectionId }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(raisedAt).length > 0 ? { raisedAt } : {}),
  };
}

/* --------------------------------------------------------------- repository */

export const feeRepository = {
  /* ------------------------------------------------------------ categories */

  async listCategories(
    scope: AccessScope,
    options: { includeInactive: boolean },
  ): Promise<FeeCategoryRecord[]> {
    return prisma.feeCategory.findMany({
      where: { ...scope.filter, ...(options.includeInactive ? {} : { isActive: true }) },
      select: CATEGORY_PROJECTION,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  },

  async findCategoryById(id: string): Promise<(FeeCategoryRecord & { schoolId: string }) | null> {
    return prisma.feeCategory.findUnique({
      where: { id },
      select: { ...CATEGORY_PROJECTION, schoolId: true },
    });
  },

  async findCategoryByCode(schoolId: string, code: string): Promise<{ id: string } | null> {
    return prisma.feeCategory.findUnique({
      where: { schoolId_code: { schoolId, code } },
      select: { id: true },
    });
  },

  async createCategory(data: Prisma.FeeCategoryUncheckedCreateInput): Promise<FeeCategoryRecord> {
    return prisma.feeCategory.create({ data, select: CATEGORY_PROJECTION });
  },

  async updateCategory(
    id: string,
    expectedVersion: number,
    data: Prisma.FeeCategoryUncheckedUpdateInput,
  ): Promise<FeeCategoryRecord> {
    await requireVersionedUpdate(
      prisma.feeCategory.updateMany({
        where: { id, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      }),
      'fee category',
    );
    return prisma.feeCategory.findUniqueOrThrow({ where: { id }, select: CATEGORY_PROJECTION });
  },

  /* ------------------------------------------------------------ structures */

  async listStructures(
    scope: AccessScope,
    filters: FeeStructureFilters,
    pagination: ResolvedPagination,
  ): Promise<{ items: FeeStructureRecord[]; totalItems: number }> {
    const where: Prisma.FeeStructureWhereInput = {
      ...scope.filter,
      ...(filters.academicYearId !== undefined ? { academicYearId: filters.academicYearId } : {}),
      ...(filters.termId !== undefined ? { termId: filters.termId } : {}),
      ...(filters.levelId !== undefined ? { levelId: filters.levelId } : {}),
      ...(filters.programId !== undefined ? { programId: filters.programId } : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
    };

    const [items, totalItems] = await Promise.all([
      prisma.feeStructure.findMany({
        where,
        select: STRUCTURE_PROJECTION,
        orderBy: [{ academicYearId: 'asc' }, { name: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.feeStructure.count({ where }),
    ]);

    return { items, totalItems };
  },

  async findStructureById(id: string): Promise<(FeeStructureRecord & { schoolId: string }) | null> {
    return prisma.feeStructure.findUnique({
      where: { id },
      select: { ...STRUCTURE_PROJECTION, schoolId: true },
    });
  },

  async createStructure(
    data: Prisma.FeeStructureUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<FeeStructureRecord> {
    return client.feeStructure.create({ data, select: STRUCTURE_PROJECTION });
  },

  async updateStructure(
    id: string,
    expectedVersion: number,
    data: Prisma.FeeStructureUncheckedUpdateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<FeeStructureRecord> {
    await requireVersionedUpdate(
      client.feeStructure.updateMany({
        where: { id, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      }),
      'fee structure',
    );
    return client.feeStructure.findUniqueOrThrow({ where: { id }, select: STRUCTURE_PROJECTION });
  },

  async createStructureItem(
    data: Prisma.FeeStructureItemUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<FeeStructureItemRecord> {
    return client.feeStructureItem.create({ data, select: STRUCTURE_ITEM_PROJECTION });
  },

  async findStructureItemById(
    id: string,
  ): Promise<{ id: string; schoolId: string; feeStructureId: string } | null> {
    return prisma.feeStructureItem.findUnique({
      where: { id },
      select: { id: true, schoolId: true, feeStructureId: true },
    });
  },

  async updateStructureItem(
    id: string,
    data: Prisma.FeeStructureItemUncheckedUpdateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<FeeStructureItemRecord> {
    return client.feeStructureItem.update({
      where: { id },
      data,
      select: STRUCTURE_ITEM_PROJECTION,
    });
  },

  async deleteStructureItem(id: string, client: PrismaTransactionClient = prisma): Promise<void> {
    await client.feeStructureItem.delete({ where: { id } });
  },

  /**
   * Every ACTIVE structure whose applicability could match a student in this period.
   *
   * Deliberately does not filter by level or programme: matching is decided per student
   * in the service, against the student's own enrolment, so a structure can never be
   * applied using another student's placement.
   */
  async findActiveStructuresForPeriod(
    scope: AccessScope,
    args: { academicYearId: string; termId: string | null; feeStructureId?: string | undefined },
  ): Promise<FeeStructureRecord[]> {
    return prisma.feeStructure.findMany({
      where: {
        ...scope.filter,
        status: 'ACTIVE',
        academicYearId: args.academicYearId,
        termId: args.termId,
        ...(args.feeStructureId !== undefined ? { id: args.feeStructureId } : {}),
      },
      select: STRUCTURE_PROJECTION,
      orderBy: { name: 'asc' },
    });
  },

  /* --------------------------------------------------------------- charges */

  /**
   * Students with a live enrolment in the year, as the charge generator sees them.
   *
   * `status: 'ENROLLED'` is the authoritative placement — a withdrawn student is not
   * charged for a term they will not attend, and a student's *current* enrolment is the
   * only source of their level, programme, class and residency.
   */
  async findEnrolledStudents(
    scope: AccessScope,
    academicYearId: string,
  ): Promise<ChargeableStudent[]> {
    const rows = await prisma.enrollment.findMany({
      where: { ...scope.filter, academicYearId, status: 'ENROLLED', student: { status: 'ACTIVE' } },
      select: {
        id: true,
        studentId: true,
        levelId: true,
        programId: true,
        classSectionId: true,
        residency: true,
        student: { select: { studentId: true, firstName: true, lastName: true } },
      },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    });

    return rows.map((row) => ({
      studentId: row.studentId,
      studentNumber: row.student.studentId,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      enrollmentId: row.id,
      levelId: row.levelId,
      programId: row.programId,
      classSectionId: row.classSectionId,
      residency: row.residency,
    }));
  },

  /**
   * The (student, structure item) pairs that already carry a live charge for a period.
   *
   * Read once before a run rather than probed per student: a thousand students against
   * a dozen items is twelve thousand round trips otherwise.
   */
  async findExistingChargeKeys(
    scope: AccessScope,
    args: { academicYearId: string; termId: string | null },
    client: PrismaTransactionClient = prisma,
  ): Promise<Set<string>> {
    const rows = await client.studentCharge.findMany({
      where: {
        ...scope.filter,
        academicYearId: args.academicYearId,
        termId: args.termId,
        status: 'RAISED',
        feeStructureItemId: { not: null },
      },
      select: { studentId: true, feeStructureItemId: true },
    });

    return new Set(rows.map((row) => `${row.studentId}:${row.feeStructureItemId ?? ''}`));
  },

  async listCharges(
    scope: AccessScope,
    filters: ChargeFilters,
    pagination: ResolvedPagination,
  ): Promise<{ items: StudentChargeRecord[]; totalItems: number }> {
    const where = buildChargeWhere(scope, filters);

    const [items, totalItems] = await Promise.all([
      prisma.studentCharge.findMany({
        where,
        select: CHARGE_PROJECTION,
        orderBy: [{ raisedAt: 'desc' }, { id: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.studentCharge.count({ where }),
    ]);

    return { items, totalItems };
  },

  async findChargeById(id: string): Promise<(StudentChargeRecord & { schoolId: string }) | null> {
    return prisma.studentCharge.findUnique({
      where: { id },
      select: { ...CHARGE_PROJECTION, schoolId: true },
    });
  },

  async createCharge(
    data: Prisma.StudentChargeUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<StudentChargeRecord> {
    return client.studentCharge.create({ data, select: CHARGE_PROJECTION });
  },

  async createChargesInBulk(
    data: readonly Prisma.StudentChargeCreateManyInput[],
    client: PrismaTransactionClient,
  ): Promise<number> {
    const result = await client.studentCharge.createMany({ data: [...data] });
    return result.count;
  },

  async voidCharge(
    id: string,
    expectedVersion: number,
    data: { voidedByUserId: string; voidedAt: Date; voidReason: string },
    client: PrismaTransactionClient = prisma,
  ): Promise<StudentChargeRecord> {
    await requireVersionedUpdate(
      client.studentCharge.updateMany({
        where: { id, version: expectedVersion, status: 'RAISED' },
        data: { ...data, status: 'VOID', version: { increment: 1 } },
      }),
      'charge',
    );
    return client.studentCharge.findUniqueOrThrow({ where: { id }, select: CHARGE_PROJECTION });
  },

  async createChargeRun(
    data: Prisma.ChargeRunUncheckedCreateInput,
    client: PrismaTransactionClient,
  ): Promise<{ id: string }> {
    return client.chargeRun.create({ data, select: { id: true } });
  },

  async updateChargeRun(
    id: string,
    data: Prisma.ChargeRunUncheckedUpdateInput,
    client: PrismaTransactionClient,
  ): Promise<void> {
    await client.chargeRun.update({ where: { id }, data });
  },

  /* ------------------------------------------------------- relief records */

  async findDiscountById(id: string): Promise<DiscountRecord | null> {
    return prisma.discount.findUnique({ where: { id }, select: DISCOUNT_PROJECTION });
  },

  async createDiscount(
    data: Prisma.DiscountUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<DiscountRecord> {
    return client.discount.create({ data, select: DISCOUNT_PROJECTION });
  },

  async findScholarshipAwardById(id: string): Promise<ScholarshipAwardRecord | null> {
    return prisma.studentScholarship.findUnique({
      where: { id },
      select: SCHOLARSHIP_AWARD_PROJECTION,
    });
  },

  async createScholarshipAward(
    data: Prisma.StudentScholarshipUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<ScholarshipAwardRecord> {
    return client.studentScholarship.create({ data, select: SCHOLARSHIP_AWARD_PROJECTION });
  },

  async findWaiverById(id: string): Promise<WaiverRecord | null> {
    return prisma.feeWaiver.findUnique({ where: { id }, select: WAIVER_PROJECTION });
  },

  async createWaiver(
    data: Prisma.FeeWaiverUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<WaiverRecord> {
    return client.feeWaiver.create({ data, select: WAIVER_PROJECTION });
  },

  async findAdjustmentById(id: string): Promise<AdjustmentRecord | null> {
    return prisma.financialAdjustment.findUnique({
      where: { id },
      select: ADJUSTMENT_PROJECTION,
    });
  },

  async createAdjustment(
    data: Prisma.FinancialAdjustmentUncheckedCreateInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<AdjustmentRecord> {
    return client.financialAdjustment.create({ data, select: ADJUSTMENT_PROJECTION });
  },

  /**
   * Move a relief record to a new status, matching on both the expected version and the
   * status it is expected to be leaving.
   *
   * The status in the `where` is what makes a double approval impossible: two Finance
   * Managers pressing Approve at the same instant produce one update and one
   * `RECORD_MODIFIED`, rather than two approvals and two credits for one write-off
   * (Section 33).
   */
  async transitionRelief(
    kind: ReliefKind,
    id: string,
    args: { expectedVersion: number; fromStatus: ApprovalStatus },
    data: ReliefTransitionData,
    client: PrismaTransactionClient = prisma,
  ): Promise<void> {
    const where = { id, version: args.expectedVersion, status: args.fromStatus };
    const patch = { ...data, version: { increment: 1 } };

    switch (kind) {
      case 'DISCOUNT':
        await requireVersionedUpdate(
          client.discount.updateMany({ where, data: patch }),
          'discount',
        );
        return;
      case 'SCHOLARSHIP':
        await requireVersionedUpdate(
          client.studentScholarship.updateMany({ where, data: patch }),
          'scholarship award',
        );
        return;
      case 'WAIVER':
        await requireVersionedUpdate(client.feeWaiver.updateMany({ where, data: patch }), 'waiver');
        return;
      case 'ADJUSTMENT':
        await requireVersionedUpdate(
          client.financialAdjustment.updateMany({ where, data: patch }),
          'adjustment',
        );
        return;
    }
  },

  /**
   * Every relief record matching a filter, as four typed lists.
   *
   * Four queries rather than a union view: Prisma has no cross-model union, and four
   * indexed reads are cheap. The service merges and sorts them.
   */
  async listReliefs(
    scope: AccessScope,
    filters: ReliefFilters,
  ): Promise<{
    discounts: DiscountRecord[];
    scholarships: ScholarshipAwardRecord[];
    waivers: WaiverRecord[];
    adjustments: AdjustmentRecord[];
  }> {
    const where = {
      ...scope.filter,
      ...(filters.studentId !== undefined ? { studentId: filters.studentId } : {}),
      ...(filters.academicYearId !== undefined ? { academicYearId: filters.academicYearId } : {}),
      ...(filters.termId !== undefined ? { termId: filters.termId } : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
    };

    const wanted = (kind: ReliefKind): boolean =>
      filters.kind === undefined || filters.kind === kind;

    const [discounts, scholarships, waivers, adjustments] = await Promise.all([
      wanted('DISCOUNT')
        ? prisma.discount.findMany({ where, select: DISCOUNT_PROJECTION })
        : Promise.resolve([]),
      wanted('SCHOLARSHIP')
        ? prisma.studentScholarship.findMany({ where, select: SCHOLARSHIP_AWARD_PROJECTION })
        : Promise.resolve([]),
      wanted('WAIVER')
        ? prisma.feeWaiver.findMany({ where, select: WAIVER_PROJECTION })
        : Promise.resolve([]),
      wanted('ADJUSTMENT')
        ? prisma.financialAdjustment.findMany({ where, select: ADJUSTMENT_PROJECTION })
        : Promise.resolve([]),
    ]);

    return { discounts, scholarships, waivers, adjustments };
  },

  /** Requests still awaiting a decision. They have posted nothing to the ledger. */
  async countPendingReliefs(
    scope: AccessScope,
    args: {
      studentId: string;
      academicYearId?: string | undefined;
      termId?: string | null | undefined;
    },
  ): Promise<number> {
    const where = {
      ...scope.filter,
      studentId: args.studentId,
      status: 'PENDING_APPROVAL' as ApprovalStatus,
      ...(args.academicYearId !== undefined ? { academicYearId: args.academicYearId } : {}),
      ...(args.termId !== undefined ? { termId: args.termId } : {}),
    };

    const counts = await Promise.all([
      prisma.discount.count({ where }),
      prisma.studentScholarship.count({ where }),
      prisma.feeWaiver.count({ where }),
      prisma.financialAdjustment.count({ where }),
    ]);

    return counts.reduce((total, count) => total + count, 0);
  },

  /* ------------------------------------------------- scholarship programmes */

  async listScholarships(
    scope: AccessScope,
    options: { includeInactive: boolean },
  ): Promise<ScholarshipRecord[]> {
    return prisma.scholarship.findMany({
      where: { ...scope.filter, ...(options.includeInactive ? {} : { isActive: true }) },
      select: SCHOLARSHIP_PROJECTION,
      orderBy: { name: 'asc' },
    });
  },

  async findScholarshipById(
    id: string,
  ): Promise<(ScholarshipRecord & { schoolId: string }) | null> {
    return prisma.scholarship.findUnique({
      where: { id },
      select: { ...SCHOLARSHIP_PROJECTION, schoolId: true },
    });
  },

  async findScholarshipByCode(schoolId: string, code: string): Promise<{ id: string } | null> {
    return prisma.scholarship.findUnique({
      where: { schoolId_code: { schoolId, code } },
      select: { id: true },
    });
  },

  async createScholarship(
    data: Prisma.ScholarshipUncheckedCreateInput,
  ): Promise<ScholarshipRecord> {
    return prisma.scholarship.create({ data, select: SCHOLARSHIP_PROJECTION });
  },

  async updateScholarship(
    id: string,
    expectedVersion: number,
    data: Prisma.ScholarshipUncheckedUpdateInput,
  ): Promise<ScholarshipRecord> {
    await requireVersionedUpdate(
      prisma.scholarship.updateMany({
        where: { id, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      }),
      'scholarship',
    );
    return prisma.scholarship.findUniqueOrThrow({
      where: { id },
      select: SCHOLARSHIP_PROJECTION,
    });
  },

  /* ------------------------------------------------------------- the ledger */

  /**
   * The student's financial account, opening it if this is the first activity.
   *
   * Idempotent under concurrency: two requests racing to open the same account both
   * upsert on the unique `student_id`, and one simply finds the row the other created
   * rather than failing.
   */
  async ensureAccount(
    args: { schoolId: string; studentId: string; currency: string },
    client: PrismaTransactionClient,
  ): Promise<{ id: string; currency: string }> {
    return client.studentFinancialAccount.upsert({
      where: { studentId: args.studentId },
      create: { schoolId: args.schoolId, studentId: args.studentId, currency: args.currency },
      update: {},
      select: { id: true, currency: true },
    });
  },

  /**
   * Open accounts for many students at once, and return the id of each.
   *
   * `skipDuplicates` makes this idempotent against the unique `student_id`, so a run over
   * a thousand students opens only the accounts that are genuinely new and the read-back
   * returns all of them either way. Two queries rather than a thousand upserts.
   */
  async ensureAccountsForStudents(
    args: { schoolId: string; studentIds: readonly string[]; currency: string },
    client: PrismaTransactionClient,
  ): Promise<Map<string, string>> {
    if (args.studentIds.length === 0) return new Map();

    await client.studentFinancialAccount.createMany({
      data: args.studentIds.map((studentId) => ({
        schoolId: args.schoolId,
        studentId,
        currency: args.currency,
      })),
      skipDuplicates: true,
    });

    const accounts = await client.studentFinancialAccount.findMany({
      where: { studentId: { in: [...args.studentIds] } },
      select: { id: true, studentId: true },
    });

    return new Map(accounts.map((account) => [account.studentId, account.id]));
  },

  async findAccountByStudent(
    scope: AccessScope,
    studentId: string,
  ): Promise<{ id: string; currency: string } | null> {
    return prisma.studentFinancialAccount.findFirst({
      where: { ...scope.filter, studentId },
      select: { id: true, currency: true },
    });
  },

  /** Post one ledger entry. There is no update path; this is the only way in. */
  async postEntry(
    data: Prisma.FinancialEntryUncheckedCreateInput,
    client: PrismaTransactionClient,
  ): Promise<{ id: string }> {
    return client.financialEntry.create({ data, select: { id: true } });
  },

  async postEntries(
    data: readonly Prisma.FinancialEntryCreateManyInput[],
    client: PrismaTransactionClient,
  ): Promise<number> {
    const result = await client.financialEntry.createMany({ data: [...data] });
    return result.count;
  },

  /**
   * The live (unreversed) opening entry for a source record, if it has one.
   *
   * Read before posting a reversal, so a reversal is attached to the entry it actually
   * undoes rather than to a guess.
   */
  async findOpeningEntry(
    where: Prisma.FinancialEntryWhereInput,
    client: PrismaTransactionClient = prisma,
  ): Promise<OpeningEntry | null> {
    return client.financialEntry.findFirst({
      where: { ...where, reversalOfEntryId: null, reversedBy: null },
      select: OPENING_ENTRY_PROJECTION,
    });
  },

  async listEntriesForStudent(
    scope: AccessScope,
    args: {
      studentId: string;
      academicYearId?: string | undefined;
      termId?: string | null | undefined;
    },
  ): Promise<FinancialEntryRecord[]> {
    return prisma.financialEntry.findMany({
      where: {
        ...scope.filter,
        studentId: args.studentId,
        ...(args.academicYearId !== undefined ? { academicYearId: args.academicYearId } : {}),
        ...(args.termId !== undefined ? { termId: args.termId } : {}),
      },
      select: ENTRY_PROJECTION,
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Ledger totals for a student, grouped by direction and source.
   *
   * One `groupBy` rather than six aggregates: the balance and every figure that breaks
   * it down come from the same scan, so they cannot disagree with each other.
   */
  async sumEntriesBySource(
    scope: AccessScope,
    args: {
      studentId: string;
      academicYearId?: string | undefined;
      termId?: string | null | undefined;
    },
  ): Promise<readonly LedgerTotalRow[]> {
    const rows = await prisma.financialEntry.groupBy({
      by: ['entryType', 'source'],
      where: {
        ...scope.filter,
        studentId: args.studentId,
        ...(args.academicYearId !== undefined ? { academicYearId: args.academicYearId } : {}),
        ...(args.termId !== undefined ? { termId: args.termId } : {}),
      },
      _sum: { amount: true },
    });

    return rows.map((row) => ({
      entryType: row.entryType,
      source: row.source,
      total: (row._sum.amount ?? 0).toString(),
    }));
  },

  /** The same totals, split by the period each entry belongs to. */
  async sumEntriesByPeriod(
    scope: AccessScope,
    studentId: string,
  ): Promise<ReadonlyArray<PeriodKey & LedgerTotalRow>> {
    const rows = await prisma.financialEntry.groupBy({
      by: ['academicYearId', 'termId', 'entryType', 'source'],
      where: { ...scope.filter, studentId },
      _sum: { amount: true },
    });

    return rows.map((row) => ({
      academicYearId: row.academicYearId,
      termId: row.termId,
      entryType: row.entryType,
      source: row.source,
      total: (row._sum.amount ?? 0).toString(),
    }));
  },

  /**
   * Credits and debits standing against each of a set of charges, from the ledger.
   *
   * Entries whose source is not CHARGE but which point at one are the relief applied to
   * it; a reversal is an opposing entry that cancels its original. Returned as raw
   * per-direction totals, because netting is arithmetic and arithmetic belongs in the
   * service, through `Money`.
   */
  async sumEntriesByCharge(
    chargeIds: readonly string[],
  ): Promise<Map<string, { credit: string; debit: string }>> {
    if (chargeIds.length === 0) return new Map();

    const rows = await prisma.financialEntry.groupBy({
      by: ['studentChargeId', 'entryType'],
      where: { studentChargeId: { in: [...chargeIds] }, source: { not: 'CHARGE' } },
      _sum: { amount: true },
    });

    const byCharge = new Map<string, { credit: string; debit: string }>();
    for (const row of rows) {
      if (row.studentChargeId === null) continue;
      const existing = byCharge.get(row.studentChargeId) ?? { credit: '0', debit: '0' };
      const amount = (row._sum.amount ?? 0).toString();
      byCharge.set(
        row.studentChargeId,
        row.entryType === 'CREDIT'
          ? { ...existing, credit: amount }
          : { ...existing, debit: amount },
      );
    }

    return byCharge;
  },

  /* ---------------------------------------------------------------- lookups */

  /**
   * The school's currency, from its settings.
   *
   * Read rather than assumed: `Money` refuses to mix currencies, so the balance service
   * needs the real code. Falls back to the column default only when a school has no
   * settings row, which the seed always creates.
   */
  async findSchoolCurrency(schoolId: string): Promise<string> {
    const settings = await prisma.schoolSetting.findUnique({
      where: { schoolId },
      select: { currency: true },
    });
    return settings?.currency ?? 'RWF';
  },

  async findStudentIdentity(
    scope: AccessScope,
    studentId: string,
  ): Promise<{
    id: string;
    schoolId: string;
    studentId: string;
    firstName: string;
    lastName: string;
  } | null> {
    return prisma.student.findFirst({
      where: { ...scope.filter, id: studentId },
      select: { id: true, schoolId: true, studentId: true, firstName: true, lastName: true },
    });
  },

  /** Period names for rendering a balance breakdown, fetched in one pass. */
  async findPeriodNames(
    scope: AccessScope,
    periods: readonly PeriodKey[],
  ): Promise<{ years: Map<string, string>; terms: Map<string, string> }> {
    const yearIds = [...new Set(periods.map((period) => period.academicYearId))];
    const termIds = [
      ...new Set(periods.map((period) => period.termId).filter((id): id is string => id !== null)),
    ];

    const [years, terms] = await Promise.all([
      yearIds.length === 0
        ? Promise.resolve([])
        : prisma.academicYear.findMany({
            where: { ...scope.filter, id: { in: yearIds } },
            select: { id: true, name: true },
          }),
      termIds.length === 0
        ? Promise.resolve([])
        : prisma.term.findMany({
            where: { ...scope.filter, id: { in: termIds } },
            select: { id: true, name: true },
          }),
    ]);

    return {
      years: new Map(years.map((year) => [year.id, year.name])),
      terms: new Map(terms.map((term) => [term.id, term.name])),
    };
  },
} as const;

export type FeeRepository = typeof feeRepository;
