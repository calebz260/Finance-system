/**
 * Academic-structure data access: years, terms, departments, programmes, levels and
 * class sections.
 *
 * One repository rather than six, because these entities are almost never read alone.
 * A registrar opening the enrolment screen needs the current year, its terms, the
 * programmes, their level chains and this year's class sections in one go; splitting
 * that across six files would spread one query plan over six places and invite the
 * N+1 reads this layer exists to prevent.
 *
 * Every method takes an `AccessScope`. There is no unscoped read.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { PeriodStatus, ProgramStatus } from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import { requireVersionedUpdate } from '../../lib/optimistic-lock.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

const TERM_PROJECTION = {
  id: true,
  academicYearId: true,
  name: true,
  sequence: true,
  startDate: true,
  endDate: true,
  status: true,
  isCurrent: true,
  version: true,
} as const satisfies Prisma.TermSelect;

const YEAR_PROJECTION = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  status: true,
  isCurrent: true,
  version: true,
  terms: { select: TERM_PROJECTION, orderBy: { sequence: 'asc' } },
} as const satisfies Prisma.AcademicYearSelect;

const PROGRAM_PROJECTION = {
  id: true,
  code: true,
  name: true,
  description: true,
  departmentId: true,
  durationYears: true,
  status: true,
  sortOrder: true,
  version: true,
  department: { select: { name: true } },
  _count: { select: { levels: true } },
} as const satisfies Prisma.ProgramSelect;

const LEVEL_PROJECTION = {
  id: true,
  programId: true,
  code: true,
  name: true,
  sequence: true,
  isTerminal: true,
  nextLevelId: true,
  program: { select: { name: true } },
} as const satisfies Prisma.LevelSelect;

const CLASS_SECTION_PROJECTION = {
  id: true,
  academicYearId: true,
  levelId: true,
  code: true,
  name: true,
  capacity: true,
  classTeacherName: true,
  version: true,
  level: { select: { name: true } },
  // Only live enrolments count towards occupancy: a withdrawn student is not taking up
  // a seat, and a class that reads as full because of last year's leavers is wrong.
  _count: { select: { enrollments: { where: { status: 'ENROLLED' } } } },
} as const satisfies Prisma.ClassSectionSelect;

export type AcademicYearRecord = Prisma.AcademicYearGetPayload<{
  select: typeof YEAR_PROJECTION;
}>;
export type TermRecord = Prisma.TermGetPayload<{ select: typeof TERM_PROJECTION }>;
export type ProgramRecord = Prisma.ProgramGetPayload<{ select: typeof PROGRAM_PROJECTION }>;
export type LevelRecord = Prisma.LevelGetPayload<{ select: typeof LEVEL_PROJECTION }>;
export type ClassSectionRecord = Prisma.ClassSectionGetPayload<{
  select: typeof CLASS_SECTION_PROJECTION;
}>;

export class AcademicRepository {
  constructor(private readonly db: PrismaTransactionClient = prisma) {}

  withTransaction(tx: PrismaTransactionClient): AcademicRepository {
    return new AcademicRepository(tx);
  }

  /* ------------------------------------------------------------ academic years */

  async listAcademicYears(scope: AccessScope): Promise<AcademicYearRecord[]> {
    return this.db.academicYear.findMany({
      where: scope.filter,
      select: YEAR_PROJECTION,
      orderBy: { startDate: 'desc' },
    });
  }

  async findAcademicYear(scope: AccessScope, id: string): Promise<AcademicYearRecord | null> {
    return this.db.academicYear.findFirst({ where: scope.where({ id }), select: YEAR_PROJECTION });
  }

  /**
   * The year the system treats as "now".
   *
   * A partial unique index allows only one per school, so this cannot be ambiguous —
   * which matters because enrolment, fee structures and every "current" report resolve
   * through it.
   */
  async findCurrentAcademicYear(scope: AccessScope): Promise<AcademicYearRecord | null> {
    return this.db.academicYear.findFirst({
      where: scope.where({ isCurrent: true }),
      select: YEAR_PROJECTION,
    });
  }

  async createAcademicYear(
    scope: AccessScope,
    input: { name: string; startDate: Date; endDate: Date; status: PeriodStatus },
  ): Promise<AcademicYearRecord> {
    return this.db.academicYear.create({
      data: { schoolId: scope.requireSchoolId(), ...input },
      select: YEAR_PROJECTION,
    });
  }

  async updateAcademicYear(
    scope: AccessScope,
    args: {
      id: string;
      expectedVersion: number;
      changes: { name?: string; startDate?: Date; endDate?: Date; status?: PeriodStatus };
    },
  ): Promise<AcademicYearRecord> {
    await requireVersionedUpdate(
      this.db.academicYear.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'academic year',
    );
    return this.requireAcademicYear(scope, args.id);
  }

  /**
   * Make one year current, clearing the previous one.
   *
   * Both statements run in a transaction: a partial unique index permits only one
   * current year per school, so clearing and setting must not be separable — an
   * interrupted switch would otherwise leave the school with no current year at all.
   */
  async setCurrentAcademicYear(scope: AccessScope, id: string): Promise<void> {
    const schoolId = scope.requireSchoolId();

    await prisma.$transaction(async (tx) => {
      await tx.academicYear.updateMany({
        where: { schoolId, isCurrent: true, id: { not: id } },
        data: { isCurrent: false },
      });
      await tx.academicYear.updateMany({ where: { schoolId, id }, data: { isCurrent: true } });
    });
  }

  /* -------------------------------------------------------------------- terms */

  async findTerm(scope: AccessScope, id: string): Promise<TermRecord | null> {
    return this.db.term.findFirst({ where: scope.where({ id }), select: TERM_PROJECTION });
  }

  async findCurrentTerm(scope: AccessScope): Promise<TermRecord | null> {
    return this.db.term.findFirst({
      where: scope.where({ isCurrent: true }),
      select: TERM_PROJECTION,
    });
  }

  async listTerms(scope: AccessScope, academicYearId: string): Promise<TermRecord[]> {
    return this.db.term.findMany({
      where: scope.where({ academicYearId }),
      select: TERM_PROJECTION,
      orderBy: { sequence: 'asc' },
    });
  }

  async createTerm(
    scope: AccessScope,
    input: {
      academicYearId: string;
      name: string;
      sequence: number;
      startDate: Date;
      endDate: Date;
      status: PeriodStatus;
    },
  ): Promise<TermRecord> {
    return this.db.term.create({
      data: { schoolId: scope.requireSchoolId(), ...input },
      select: TERM_PROJECTION,
    });
  }

  async updateTerm(
    scope: AccessScope,
    args: {
      id: string;
      expectedVersion: number;
      changes: {
        name?: string;
        sequence?: number;
        startDate?: Date;
        endDate?: Date;
        status?: PeriodStatus;
      };
    },
  ): Promise<TermRecord> {
    await requireVersionedUpdate(
      this.db.term.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'term',
    );
    const term = await this.findTerm(scope, args.id);
    if (term === null) throw new Error(`Term ${args.id} vanished after a successful update`);
    return term;
  }

  async setCurrentTerm(scope: AccessScope, id: string): Promise<void> {
    const schoolId = scope.requireSchoolId();

    await prisma.$transaction(async (tx) => {
      await tx.term.updateMany({
        where: { schoolId, isCurrent: true, id: { not: id } },
        data: { isCurrent: false },
      });
      await tx.term.updateMany({ where: { schoolId, id }, data: { isCurrent: true } });
    });
  }

  /* -------------------------------------------------------------- departments */

  async listDepartments(scope: AccessScope): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      description: string | null;
      _count: { programs: number };
    }>
  > {
    return this.db.department.findMany({
      where: scope.filter,
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        _count: { select: { programs: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createDepartment(
    scope: AccessScope,
    input: { code: string; name: string; description?: string | null },
  ): Promise<{ id: string; code: string; name: string; description: string | null }> {
    return this.db.department.create({
      data: {
        schoolId: scope.requireSchoolId(),
        code: input.code,
        name: input.name,
        description: input.description ?? null,
      },
      select: { id: true, code: true, name: true, description: true },
    });
  }

  /* ---------------------------------------------------------------- programmes */

  async listPrograms(
    scope: AccessScope,
    filters: { status?: ProgramStatus } = {},
  ): Promise<ProgramRecord[]> {
    return this.db.program.findMany({
      where: scope.where(filters.status === undefined ? {} : { status: filters.status }),
      select: PROGRAM_PROJECTION,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findProgram(scope: AccessScope, id: string): Promise<ProgramRecord | null> {
    return this.db.program.findFirst({ where: scope.where({ id }), select: PROGRAM_PROJECTION });
  }

  async findProgramByCode(scope: AccessScope, code: string): Promise<ProgramRecord | null> {
    return this.db.program.findFirst({ where: scope.where({ code }), select: PROGRAM_PROJECTION });
  }

  async createProgram(
    scope: AccessScope,
    input: {
      code: string;
      name: string;
      description?: string | null;
      departmentId?: string | null;
      durationYears?: number | null;
      sortOrder: number;
    },
  ): Promise<ProgramRecord> {
    return this.db.program.create({
      data: {
        schoolId: scope.requireSchoolId(),
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        departmentId: input.departmentId ?? null,
        durationYears: input.durationYears ?? null,
        sortOrder: input.sortOrder,
      },
      select: PROGRAM_PROJECTION,
    });
  }

  async updateProgram(
    scope: AccessScope,
    args: {
      id: string;
      expectedVersion: number;
      changes: {
        name?: string;
        description?: string | null;
        departmentId?: string | null;
        durationYears?: number | null;
        status?: ProgramStatus;
        sortOrder?: number;
      };
    },
  ): Promise<ProgramRecord> {
    await requireVersionedUpdate(
      this.db.program.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'programme',
    );
    const program = await this.findProgram(scope, args.id);
    if (program === null) throw new Error(`Program ${args.id} vanished after a successful update`);
    return program;
  }

  /* -------------------------------------------------------------------- levels */

  async listLevels(
    scope: AccessScope,
    filters: { programId?: string } = {},
  ): Promise<LevelRecord[]> {
    return this.db.level.findMany({
      where: scope.where(filters.programId === undefined ? {} : { programId: filters.programId }),
      select: LEVEL_PROJECTION,
      orderBy: [{ programId: 'asc' }, { sequence: 'asc' }],
    });
  }

  async findLevel(scope: AccessScope, id: string): Promise<LevelRecord | null> {
    return this.db.level.findFirst({ where: scope.where({ id }), select: LEVEL_PROJECTION });
  }

  /** Level codes are unique per programme, so both are needed to resolve one. */
  async findLevelByCode(
    scope: AccessScope,
    args: { programId: string; code: string },
  ): Promise<LevelRecord | null> {
    return this.db.level.findFirst({
      where: scope.where({ programId: args.programId, code: args.code }),
      select: LEVEL_PROJECTION,
    });
  }

  async createLevel(
    scope: AccessScope,
    input: {
      programId: string;
      code: string;
      name: string;
      sequence: number;
      isTerminal: boolean;
    },
  ): Promise<LevelRecord> {
    return this.db.level.create({
      data: { schoolId: scope.requireSchoolId(), ...input },
      select: LEVEL_PROJECTION,
    });
  }

  /**
   * Point one level at the next in its programme.
   *
   * `nextLevelId` is unique, which is what stops two levels claiming the same successor
   * and turning promotion into a fork.
   */
  async setNextLevel(
    scope: AccessScope,
    args: { levelId: string; nextLevelId: string | null },
  ): Promise<void> {
    await this.db.level.updateMany({
      where: scope.where({ id: args.levelId }),
      data: { nextLevelId: args.nextLevelId },
    });
  }

  /* ------------------------------------------------------------ class sections */

  async listClassSections(
    scope: AccessScope,
    filters: { academicYearId?: string; levelId?: string } = {},
  ): Promise<ClassSectionRecord[]> {
    const where: Prisma.ClassSectionWhereInput = { ...scope.filter };
    if (filters.academicYearId !== undefined) where.academicYearId = filters.academicYearId;
    if (filters.levelId !== undefined) where.levelId = filters.levelId;

    return this.db.classSection.findMany({
      where,
      select: CLASS_SECTION_PROJECTION,
      orderBy: [{ levelId: 'asc' }, { code: 'asc' }],
    });
  }

  async findClassSection(scope: AccessScope, id: string): Promise<ClassSectionRecord | null> {
    return this.db.classSection.findFirst({
      where: scope.where({ id }),
      select: CLASS_SECTION_PROJECTION,
    });
  }

  async findClassSectionByCode(
    scope: AccessScope,
    args: { academicYearId: string; levelId: string; code: string },
  ): Promise<ClassSectionRecord | null> {
    return this.db.classSection.findFirst({
      where: scope.where({
        academicYearId: args.academicYearId,
        levelId: args.levelId,
        code: args.code,
      }),
      select: CLASS_SECTION_PROJECTION,
    });
  }

  async createClassSection(
    scope: AccessScope,
    input: {
      academicYearId: string;
      levelId: string;
      code: string;
      name: string;
      capacity?: number | null;
      classTeacherName?: string | null;
    },
  ): Promise<ClassSectionRecord> {
    return this.db.classSection.create({
      data: {
        schoolId: scope.requireSchoolId(),
        academicYearId: input.academicYearId,
        levelId: input.levelId,
        code: input.code,
        name: input.name,
        capacity: input.capacity ?? null,
        classTeacherName: input.classTeacherName ?? null,
      },
      select: CLASS_SECTION_PROJECTION,
    });
  }

  async updateClassSection(
    scope: AccessScope,
    args: {
      id: string;
      expectedVersion: number;
      changes: {
        name?: string;
        capacity?: number | null;
        classTeacherName?: string | null;
      };
    },
  ): Promise<ClassSectionRecord> {
    await requireVersionedUpdate(
      this.db.classSection.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'class',
    );
    const section = await this.findClassSection(scope, args.id);
    if (section === null) throw new Error(`Class ${args.id} vanished after a successful update`);
    return section;
  }

  /** Live enrolments in a class, for the capacity check. */
  async countEnrolledInClassSection(scope: AccessScope, classSectionId: string): Promise<number> {
    return this.db.enrollment.count({
      where: scope.where({ classSectionId, status: 'ENROLLED' as const }),
    });
  }

  private async requireAcademicYear(scope: AccessScope, id: string): Promise<AcademicYearRecord> {
    const year = await this.findAcademicYear(scope, id);
    if (year === null) throw new Error(`Academic year ${id} vanished after a successful write`);
    return year;
  }
}

export const academicRepository = new AcademicRepository();
