/**
 * Enrolment data access.
 *
 * The table is append-only in spirit and nearly so in practice: promotion, repetition,
 * completion, transfer and withdrawal each add a row or close one, and no historical
 * enrolment is ever rewritten (Sections 8 and 22). The only fields an existing row
 * accepts are the ones that record how it ended, plus a class move within the same
 * year.
 *
 * A partial unique index in the constraints migration allows exactly one `ENROLLED`
 * row per student per academic year, which is what stops a double enrolment producing
 * two sets of term charges. This layer relies on that rather than checking first and
 * hoping.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  EnrollmentStatus,
  EnrollmentType,
  ResidencyType,
} from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import { requireVersionedUpdate } from '../../lib/optimistic-lock.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import type { EnrollmentWithRelations } from '../students/student.repository.js';

const ENROLLMENT_RELATIONS = {
  academicYear: { select: { name: true } },
  program: { select: { name: true } },
  level: { select: { name: true } },
  classSection: { select: { name: true } },
} as const satisfies Prisma.EnrollmentInclude;

export interface CreateEnrollmentInput {
  readonly studentId: string;
  readonly academicYearId: string;
  readonly programId: string;
  readonly levelId: string;
  readonly classSectionId: string | null;
  readonly status: EnrollmentStatus;
  readonly enrollmentType: EnrollmentType;
  readonly residency: ResidencyType;
  readonly startDate: Date;
}

export class EnrollmentRepository {
  constructor(private readonly db: PrismaTransactionClient = prisma) {}

  withTransaction(tx: PrismaTransactionClient): EnrollmentRepository {
    return new EnrollmentRepository(tx);
  }

  async findById(scope: AccessScope, id: string): Promise<EnrollmentWithRelations | null> {
    return this.db.enrollment.findFirst({
      where: scope.where({ id }),
      include: ENROLLMENT_RELATIONS,
    });
  }

  /** A student's whole history, newest first. */
  async listForStudent(scope: AccessScope, studentId: string): Promise<EnrollmentWithRelations[]> {
    return this.db.enrollment.findMany({
      where: scope.where({ studentId }),
      include: ENROLLMENT_RELATIONS,
      orderBy: { startDate: 'desc' },
    });
  }

  /** The live enrolment for a student in a given year, if there is one. */
  async findLiveForStudent(
    scope: AccessScope,
    args: { studentId: string; academicYearId: string },
  ): Promise<EnrollmentWithRelations | null> {
    return this.db.enrollment.findFirst({
      where: scope.where({
        studentId: args.studentId,
        academicYearId: args.academicYearId,
        status: 'ENROLLED' as const,
      }),
      include: ENROLLMENT_RELATIONS,
    });
  }

  async create(scope: AccessScope, input: CreateEnrollmentInput): Promise<EnrollmentWithRelations> {
    return this.db.enrollment.create({
      data: { schoolId: scope.requireSchoolId(), ...input },
      include: ENROLLMENT_RELATIONS,
    });
  }

  /** Bulk path for the importer; the caller supplies the transaction. */
  async createMany(
    tx: PrismaTransactionClient,
    schoolId: string,
    rows: readonly CreateEnrollmentInput[],
  ): Promise<number> {
    const result = await tx.enrollment.createMany({
      data: rows.map((row) => ({ schoolId, ...row })),
    });
    return result.count;
  }

  /**
   * Move a live enrolment to a different class within the same year.
   *
   * The only mutation an ongoing enrolment accepts. Changing its level or year would
   * rewrite where the student was, rather than recording where they went — promotion
   * and re-admission create new rows instead.
   */
  async moveToClassSection(
    scope: AccessScope,
    args: { id: string; expectedVersion: number; classSectionId: string | null },
  ): Promise<EnrollmentWithRelations> {
    await requireVersionedUpdate(
      this.db.enrollment.updateMany({
        where: scope.where({
          id: args.id,
          version: args.expectedVersion,
          status: 'ENROLLED' as const,
        }),
        data: { classSectionId: args.classSectionId, version: { increment: 1 } },
      }),
      'enrolment',
    );

    return this.requireById(scope, args.id);
  }

  /**
   * Close an enrolment.
   *
   * Conditional on it still being `ENROLLED`, so two concurrent exits cannot both
   * apply and overwrite each other's reason and date — the second finds nothing to
   * update and is reported as a conflict by the caller.
   */
  async end(
    scope: AccessScope,
    args: {
      id: string;
      status: EnrollmentStatus;
      endDate: Date;
      exitReason: string | null;
    },
  ): Promise<EnrollmentWithRelations> {
    await requireVersionedUpdate(
      this.db.enrollment.updateMany({
        where: scope.where({ id: args.id, status: 'ENROLLED' as const }),
        data: {
          status: args.status,
          endDate: args.endDate,
          exitReason: args.exitReason,
          version: { increment: 1 },
        },
      }),
      'enrolment',
    );

    return this.requireById(scope, args.id);
  }

  /** Live enrolments for a year, for class lists and headcounts. */
  async countEnrolled(scope: AccessScope, academicYearId: string): Promise<number> {
    return this.db.enrollment.count({
      where: scope.where({ academicYearId, status: 'ENROLLED' as const }),
    });
  }

  private async requireById(scope: AccessScope, id: string): Promise<EnrollmentWithRelations> {
    const enrollment = await this.findById(scope, id);
    if (enrollment === null) {
      throw new Error(`Enrollment ${id} disappeared immediately after a successful write`);
    }
    return enrollment;
  }
}

export const enrollmentRepository = new EnrollmentRepository();
