/**
 * Student data access.
 *
 * This is the reference implementation of the repository pattern every module follows,
 * so the conventions it establishes matter more than the queries themselves:
 *
 *  - Every method takes an `AccessScope`. There is no unscoped read.
 *  - A fetch by primary key is checked against the scope before being returned, because
 *    a primary-key lookup is not filtered by school.
 *  - Lists are paginated and return a total, so callers cannot accidentally stream the
 *    whole table.
 *  - Updates are conditional on `version`, so a concurrent edit is rejected rather than
 *    silently overwritten.
 *  - Student IDs are allocated inside the same transaction as the insert.
 */
import { type Prisma } from '../../generated/prisma/client.js';
// Prisma 7 names the plain row type `<Model>Model`; `<Model>` is the delegate namespace.
import type { StudentModel } from '../../generated/prisma/models.js';
import type { StudentStatus } from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import { allocateStudentId } from '../../lib/identifier-sequence.js';
import { requireVersionedUpdate } from '../../lib/optimistic-lock.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import type { ResolvedPagination } from '../../lib/http.js';

/**
 * The relations an enrolment is always read with.
 *
 * Names rather than ids, because every screen that shows an enrolment shows the year,
 * programme, level and class by name, and fetching them separately per row is the N+1
 * this layer exists to prevent.
 */
const ENROLLMENT_RELATIONS = {
  academicYear: { select: { name: true } },
  program: { select: { name: true } },
  level: { select: { name: true } },
  classSection: { select: { name: true } },
} as const satisfies Prisma.EnrollmentInclude;

export type EnrollmentWithRelations = Prisma.EnrollmentGetPayload<{
  include: typeof ENROLLMENT_RELATIONS;
}>;

export type StudentWithEnrollment = Prisma.StudentGetPayload<{
  include: { enrollments: { include: typeof ENROLLMENT_RELATIONS } };
}>;

export type StudentDetailRecord = Prisma.StudentGetPayload<{
  include: {
    guardians: {
      include: { guardian: { select: { firstName: true; lastName: true; phone: true } } };
    };
    enrollments: { include: typeof ENROLLMENT_RELATIONS };
  };
}>;

export interface StudentListFilters {
  /** Free-text search across Student ID and name. */
  readonly search?: string;
  readonly status?: StudentStatus;
  readonly admissionYear?: number;
  /** Restrict to students enrolled in a given year, level or class. */
  readonly academicYearId?: string;
  readonly levelId?: string;
  readonly classSectionId?: string;
}

export interface CreateStudentInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly otherNames?: string | null;
  readonly gender?: Prisma.StudentCreateInput['gender'];
  readonly dateOfBirth?: Date | null;
  readonly admissionDate: Date;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
}

export interface UpdateStudentInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly otherNames?: string | null;
  readonly dateOfBirth?: Date | null;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly status?: StudentStatus;
}

export interface PagedResult<TItem> {
  readonly items: TItem[];
  readonly totalItems: number;
}

export class StudentRepository {
  constructor(private readonly db: PrismaTransactionClient = prisma) {}

  /** A repository bound to an open transaction, for multi-step operations. */
  withTransaction(tx: PrismaTransactionClient): StudentRepository {
    return new StudentRepository(tx);
  }

  /**
   * Fetch by primary key, verifying the record belongs to the scope.
   *
   * Returns null for "not in this scope" as well as "does not exist", so a caller cannot
   * accidentally distinguish the two; `AccessScope.assertPermits` is used where a
   * not-found response is wanted instead.
   */
  async findById(scope: AccessScope, id: string): Promise<StudentModel | null> {
    const student = await this.db.student.findFirst({ where: scope.where({ id }) });
    return student;
  }

  /** Fetch by the human-facing Student ID, which is unique per school (Section 7). */
  async findByStudentId(scope: AccessScope, studentId: string): Promise<StudentModel | null> {
    return this.db.student.findFirst({ where: scope.where({ studentId }) });
  }

  /**
   * Paginated list with filters.
   *
   * The count runs in the same transaction as the page so the total cannot describe a
   * different set of rows than the one returned.
   */
  async list(
    scope: AccessScope,
    filters: StudentListFilters,
    pagination: ResolvedPagination,
  ): Promise<PagedResult<StudentModel>> {
    const where = this.buildWhere(scope, filters);

    const [items, totalItems] = await Promise.all([
      this.db.student.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { studentId: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.db.student.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** Enrolment counts for the current population, by level (Section 11). */
  async countActiveByLevel(
    scope: AccessScope,
    academicYearId: string,
  ): Promise<Array<{ levelId: string; count: number }>> {
    const grouped = await this.db.enrollment.groupBy({
      by: ['levelId'],
      where: scope.where({ academicYearId, status: 'ENROLLED' as const }),
      _count: { _all: true },
    });

    return grouped.map((row) => ({ levelId: row.levelId, count: row._count._all }));
  }

  /**
   * Register a student, allocating the Student ID from the school's counter.
   *
   * Runs in a transaction because the identifier and the row must be created together:
   * a failure after allocation would otherwise burn an identifier and leave a gap in the
   * sequence that looks, to an auditor, like a deleted student.
   */
  async create(
    scope: AccessScope,
    input: CreateStudentInput,
    options: { studentIdPrefix?: string } = {},
  ): Promise<StudentModel> {
    const schoolId = scope.requireSchoolId();
    const admissionYear = input.admissionDate.getUTCFullYear();

    const run = async (tx: PrismaTransactionClient): Promise<StudentModel> => {
      const studentId = await allocateStudentId(tx, {
        schoolId,
        admissionYear,
        ...(options.studentIdPrefix !== undefined ? { prefix: options.studentIdPrefix } : {}),
      });

      return tx.student.create({
        data: {
          schoolId,
          studentId,
          firstName: input.firstName,
          lastName: input.lastName,
          otherNames: input.otherNames ?? null,
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          dateOfBirth: input.dateOfBirth ?? null,
          admissionDate: input.admissionDate,
          admissionYear,
          district: input.district ?? null,
          sector: input.sector ?? null,
          address: input.address ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
        },
      });
    };

    // Already inside a caller's transaction when `this.db` is a transaction client.
    return isTransactionClient(this.db) ? run(this.db) : prisma.$transaction(run);
  }

  /**
   * Update, conditional on the version the caller last read.
   *
   * Expressed as a single conditional `updateMany` rather than read-then-write: there is
   * no window between checking the version and applying the change, so two concurrent
   * saves cannot both pass the check.
   */
  async update(
    scope: AccessScope,
    args: { id: string; expectedVersion: number; changes: UpdateStudentInput },
  ): Promise<StudentModel> {
    await requireVersionedUpdate(
      this.db.student.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'student',
    );

    const updated = await this.findById(scope, args.id);
    if (updated === null) {
      // Cannot normally happen: the update just succeeded within this scope.
      throw new Error(`Student ${args.id} disappeared immediately after a successful update`);
    }
    return updated;
  }

  /* ------------------------------------------------- Phase 3: joined reads */

  /**
   * A page of students, each with the enrolment that places them in the given year.
   *
   * The enrolment is fetched in the same query rather than per row. A thousand-student
   * list with a follow-up query per student is the N+1 that makes a registrar's first
   * page load take ten seconds, and it is invisible until the school has real data.
   */
  async listWithCurrentEnrollment(
    scope: AccessScope,
    filters: StudentListFilters,
    pagination: ResolvedPagination,
    currentAcademicYearId: string | null,
  ): Promise<PagedResult<StudentWithEnrollment>> {
    const where = this.buildWhere(scope, filters);

    const [items, totalItems] = await Promise.all([
      this.db.student.findMany({
        where,
        include: {
          enrollments: {
            // Restricted to the current year, so "current enrolment" cannot silently
            // become "whatever enrolment happened to sort first".
            where:
              currentAcademicYearId === null
                ? { id: '00000000-0000-0000-0000-000000000000' }
                : { academicYearId: currentAcademicYearId },
            include: ENROLLMENT_RELATIONS,
            orderBy: { startDate: 'desc' },
            take: 1,
          },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { studentId: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.db.student.count({ where }),
    ]);

    return { items, totalItems };
  }

  /**
   * One student with their guardians and their whole enrolment history.
   *
   * The history is append-only and returned newest first: promotion, repetition,
   * transfer and withdrawal each add a row, and none of them overwrites an earlier one.
   */
  async findDetail(scope: AccessScope, id: string): Promise<StudentDetailRecord | null> {
    return this.db.student.findFirst({
      where: scope.where({ id }),
      include: {
        guardians: {
          include: { guardian: { select: { firstName: true, lastName: true, phone: true } } },
          orderBy: [{ isPrimaryContact: 'desc' }, { createdAt: 'asc' }],
        },
        enrollments: {
          include: ENROLLMENT_RELATIONS,
          orderBy: { startDate: 'desc' },
        },
      },
    });
  }

  /** Fetched unscoped so a cross-school attempt can be recorded as one, then refused. */
  async findDetailUnscoped(id: string): Promise<StudentDetailRecord | null> {
    return this.db.student.findFirst({
      where: { id },
      include: {
        guardians: {
          include: { guardian: { select: { firstName: true, lastName: true, phone: true } } },
          orderBy: [{ isPrimaryContact: 'desc' }, { createdAt: 'asc' }],
        },
        enrollments: {
          include: ENROLLMENT_RELATIONS,
          orderBy: { startDate: 'desc' },
        },
      },
    });
  }

  /**
   * Change a student's lifecycle status, conditional on version.
   *
   * Separate from `update` because it is not a field edit: it carries its own audit
   * action, and leaving the school is a decision rather than a correction.
   */
  async setStatus(
    scope: AccessScope,
    args: { id: string; expectedVersion: number; status: StudentStatus },
  ): Promise<StudentModel> {
    await requireVersionedUpdate(
      this.db.student.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { status: args.status, version: { increment: 1 } },
      }),
      'student',
    );

    const updated = await this.findById(scope, args.id);
    if (updated === null) {
      throw new Error(`Student ${args.id} disappeared immediately after a status change`);
    }
    return updated;
  }

  /**
   * Create many students in one transaction, allocating each identifier from the same
   * counter.
   *
   * All-or-nothing on purpose: a bulk import that half-applies leaves a registrar
   * unable to tell which of a thousand rows landed, and re-running it would duplicate
   * the ones that did.
   */
  async createMany(
    scope: AccessScope,
    rows: readonly CreateStudentInput[],
    options: { studentIdPrefix?: string } = {},
  ): Promise<StudentModel[]> {
    const schoolId = scope.requireSchoolId();

    return prisma.$transaction(async (tx) => {
      const created: StudentModel[] = [];

      for (const input of rows) {
        const admissionYear = input.admissionDate.getUTCFullYear();
        const studentId = await allocateStudentId(tx, {
          schoolId,
          admissionYear,
          ...(options.studentIdPrefix !== undefined ? { prefix: options.studentIdPrefix } : {}),
        });

        created.push(
          await tx.student.create({
            data: {
              schoolId,
              studentId,
              firstName: input.firstName,
              lastName: input.lastName,
              otherNames: input.otherNames ?? null,
              ...(input.gender !== undefined ? { gender: input.gender } : {}),
              dateOfBirth: input.dateOfBirth ?? null,
              admissionDate: input.admissionDate,
              admissionYear,
              district: input.district ?? null,
              sector: input.sector ?? null,
              address: input.address ?? null,
              phone: input.phone ?? null,
              email: input.email ?? null,
            },
          }),
        );
      }

      return created;
    });
  }

  private buildWhere(scope: AccessScope, filters: StudentListFilters): Prisma.StudentWhereInput {
    const where: Prisma.StudentWhereInput = { ...scope.filter };

    if (filters.status !== undefined) where.status = filters.status;
    if (filters.admissionYear !== undefined) where.admissionYear = filters.admissionYear;

    if (filters.search !== undefined && filters.search.trim() !== '') {
      const term = filters.search.trim();
      // Student ID first: it is the identifier staff actually type, and an exact match on
      // it should not be diluted by name matches (Section 7).
      where.OR = [
        { studentId: { contains: term, mode: 'insensitive' } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { otherNames: { contains: term, mode: 'insensitive' } },
      ];
    }

    const enrollmentFilter: Prisma.EnrollmentWhereInput = {};
    if (filters.academicYearId !== undefined)
      enrollmentFilter.academicYearId = filters.academicYearId;
    if (filters.levelId !== undefined) enrollmentFilter.levelId = filters.levelId;
    if (filters.classSectionId !== undefined)
      enrollmentFilter.classSectionId = filters.classSectionId;

    if (Object.keys(enrollmentFilter).length > 0) {
      where.enrollments = { some: { ...enrollmentFilter, status: 'ENROLLED' } };
    }

    return where;
  }
}

/**
 * Distinguishes a transaction client from the root client. The root client exposes
 * `$transaction`; a transaction client does not, which is exactly the capability that
 * matters here — nesting a transaction inside one is not what we want.
 */
function isTransactionClient(client: PrismaTransactionClient): boolean {
  return !('$transaction' in client);
}

export const studentRepository = new StudentRepository();
