/**
 * Academic-structure rules.
 *
 * The invariants here exist because every later phase resolves through them. A fee
 * structure is scoped by academic year and term; a charge belongs to a term; promotion
 * walks the level chain. If any of those can be ambiguous or malformed, the financial
 * records built on top inherit the ambiguity.
 *
 *  - **Exactly one current year and one current term.** Enforced by partial unique
 *    indexes in the database and by a transaction here, so "the current term" is never
 *    a question with two answers.
 *  - **A term lies inside its year, and terms do not overlap.** Otherwise a payment
 *    dated in the gap belongs to no term, or to two.
 *  - **A closed period is closed.** Reopening one is not a field edit; it is refused
 *    here, because a closed term is the boundary a reconciliation was signed off
 *    against.
 *  - **The level chain is acyclic and single-successor.** Promotion follows it, so a
 *    cycle would loop a student forever and a shared successor would fork the year.
 */
import {
  ErrorCode,
  type AcademicYearSummary,
  type ClassSectionSummary,
  type DepartmentSummary,
  type LevelSummary,
  type PeriodState,
  type ProgramState,
  type ProgramSummary,
  type TermSummary,
} from '@sfs/shared';

import type { PeriodStatus, ProgramStatus } from '../../generated/prisma/enums.js';
import { ConflictError, DomainError, NotFoundError } from '../../lib/errors.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import {
  academicRepository,
  type AcademicRepository,
  type AcademicYearRecord,
  type ClassSectionRecord,
  type LevelRecord,
  type ProgramRecord,
  type TermRecord,
} from './academic.repository.js';

/* ----------------------------------------------------------------- projections */

/** Dates are stored as `date` columns; the wire form is the date alone, never a moment. */
function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toTermSummary(term: TermRecord): TermSummary {
  const status: PeriodState = term.status;
  return {
    id: term.id,
    academicYearId: term.academicYearId,
    name: term.name,
    sequence: term.sequence,
    startDate: toDateString(term.startDate),
    endDate: toDateString(term.endDate),
    status,
    isCurrent: term.isCurrent,
    version: term.version,
  };
}

function toAcademicYearSummary(year: AcademicYearRecord): AcademicYearSummary {
  const status: PeriodState = year.status;
  return {
    id: year.id,
    name: year.name,
    startDate: toDateString(year.startDate),
    endDate: toDateString(year.endDate),
    status,
    isCurrent: year.isCurrent,
    terms: year.terms.map(toTermSummary),
    version: year.version,
  };
}

function toProgramSummary(program: ProgramRecord): ProgramSummary {
  const status: ProgramState = program.status;
  return {
    id: program.id,
    code: program.code,
    name: program.name,
    description: program.description,
    departmentId: program.departmentId,
    departmentName: program.department?.name ?? null,
    durationYears: program.durationYears,
    status,
    sortOrder: program.sortOrder,
    levelCount: program._count.levels,
    version: program.version,
  };
}

function toLevelSummary(level: LevelRecord): LevelSummary {
  return {
    id: level.id,
    programId: level.programId,
    programName: level.program.name,
    code: level.code,
    name: level.name,
    sequence: level.sequence,
    isTerminal: level.isTerminal,
    nextLevelId: level.nextLevelId,
  };
}

function toClassSectionSummary(section: ClassSectionRecord): ClassSectionSummary {
  return {
    id: section.id,
    academicYearId: section.academicYearId,
    levelId: section.levelId,
    levelName: section.level.name,
    code: section.code,
    name: section.name,
    capacity: section.capacity,
    classTeacherName: section.classTeacherName,
    enrolledCount: section._count.enrollments,
    version: section.version,
  };
}

/* ----------------------------------------------------------------------- rules */

function assertDateOrder(startDate: Date, endDate: Date, subject: string): void {
  if (endDate <= startDate) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, `The ${subject} must end after it starts.`, {
      fieldErrors: [
        { path: 'body.endDate', message: 'The end date must be after the start date.' },
      ],
    });
  }
}

/**
 * A closed period is a boundary something was signed off against, so reopening it is
 * refused rather than treated as an ordinary status edit. Phase 14 can add a deliberate,
 * audited reopen if the school turns out to need one.
 */
function assertNotReopening(
  current: PeriodStatus,
  next: PeriodStatus | undefined,
  subject: string,
): void {
  if (next === undefined || current !== 'CLOSED' || next === 'CLOSED') return;

  throw new DomainError(
    ErrorCode.INVALID_STATE_TRANSITION,
    `This ${subject} is closed. A closed period cannot be reopened.`,
  );
}

/* ------------------------------------------------------------- academic years */

export async function listAcademicYears(
  actor: Principal,
  repository: AcademicRepository = academicRepository,
): Promise<readonly AcademicYearSummary[]> {
  const years = await repository.listAcademicYears(actor.scope);
  return years.map(toAcademicYearSummary);
}

export async function getCurrentAcademicYear(
  actor: Principal,
  repository: AcademicRepository = academicRepository,
): Promise<AcademicYearSummary | null> {
  const year = await repository.findCurrentAcademicYear(actor.scope);
  return year === null ? null : toAcademicYearSummary(year);
}

/**
 * The current year, or a refusal.
 *
 * Used wherever a caller cannot proceed without one — registering a student, enrolling,
 * importing. The refusal names the actual problem, because "no current academic year"
 * is a setup step an administrator can go and do, not a bug to report.
 */
export async function requireCurrentAcademicYear(
  actor: Principal,
  repository: AcademicRepository = academicRepository,
): Promise<AcademicYearRecord> {
  const year = await repository.findCurrentAcademicYear(actor.scope);
  if (year === null) {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      'No academic year is set as current. A school administrator must set one before students can be enrolled.',
    );
  }
  return year;
}

export async function createAcademicYear(
  actor: Principal,
  input: { name: string; startDate: Date; endDate: Date; status?: PeriodStatus },
  repository: AcademicRepository = academicRepository,
): Promise<AcademicYearSummary> {
  assertDateOrder(input.startDate, input.endDate, 'academic year');

  const created = await repository.createAcademicYear(actor.scope, {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    status: input.status ?? 'UPCOMING',
  });

  await record({
    action: AuditAction.ACADEMIC_YEAR_CREATED,
    entityType: AuditEntity.ACADEMIC_YEAR,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { name: created.name },
  });

  return toAcademicYearSummary(created);
}

export async function updateAcademicYear(
  actor: Principal,
  args: {
    id: string;
    expectedVersion: number;
    name?: string;
    startDate?: Date;
    endDate?: Date;
    status?: PeriodStatus;
  },
  repository: AcademicRepository = academicRepository,
): Promise<AcademicYearSummary> {
  const existing = await repository.findAcademicYear(actor.scope, args.id);
  if (existing === null) throw new NotFoundError('That academic year was not found.');

  assertNotReopening(existing.status, args.status, 'academic year');
  assertDateOrder(
    args.startDate ?? existing.startDate,
    args.endDate ?? existing.endDate,
    'academic year',
  );

  const updated = await repository.updateAcademicYear(actor.scope, {
    id: args.id,
    expectedVersion: args.expectedVersion,
    changes: {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.startDate !== undefined ? { startDate: args.startDate } : {}),
      ...(args.endDate !== undefined ? { endDate: args.endDate } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    },
  });

  await record({
    action: AuditAction.ACADEMIC_YEAR_UPDATED,
    entityType: AuditEntity.ACADEMIC_YEAR,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
  });

  return toAcademicYearSummary(updated);
}

/**
 * Switch which year the system treats as current.
 *
 * Refused for a closed year: making a closed period current would put every subsequent
 * registration and charge into a period that has already been reconciled.
 */
export async function setCurrentAcademicYear(
  actor: Principal,
  id: string,
  repository: AcademicRepository = academicRepository,
): Promise<AcademicYearSummary> {
  const year = await repository.findAcademicYear(actor.scope, id);
  if (year === null) throw new NotFoundError('That academic year was not found.');

  if (year.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      'A closed academic year cannot be made the current one.',
    );
  }

  await repository.setCurrentAcademicYear(actor.scope, id);

  await record({
    action: AuditAction.ACADEMIC_YEAR_SET_CURRENT,
    entityType: AuditEntity.ACADEMIC_YEAR,
    entityId: id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { name: year.name },
  });

  const refreshed = await repository.findAcademicYear(actor.scope, id);
  return toAcademicYearSummary(refreshed ?? year);
}

/* -------------------------------------------------------------------- terms */

/**
 * A term must lie inside its academic year and must not overlap a sibling.
 *
 * Both are financial correctness rules rather than tidiness: a charge is scoped by
 * term, so a date falling in a gap belongs to no term and a date in an overlap belongs
 * to two.
 */
function assertTermFitsYear(
  term: { startDate: Date; endDate: Date },
  year: { startDate: Date; endDate: Date; name: string },
): void {
  if (term.startDate < year.startDate || term.endDate > year.endDate) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `A term must fall within ${year.name}, which runs from ${toDateString(year.startDate)} to ${toDateString(year.endDate)}.`,
    );
  }
}

function assertNoTermOverlap(
  candidate: { startDate: Date; endDate: Date },
  siblings: readonly TermRecord[],
  excludeId?: string,
): void {
  for (const sibling of siblings) {
    if (sibling.id === excludeId) continue;
    const overlaps =
      candidate.startDate <= sibling.endDate && sibling.startDate <= candidate.endDate;
    if (overlaps) {
      throw new ConflictError(
        `These dates overlap ${sibling.name} (${toDateString(sibling.startDate)} to ${toDateString(sibling.endDate)}). Terms must not overlap, because a charge belongs to exactly one term.`,
        ErrorCode.CONFLICT,
      );
    }
  }
}

export async function createTerm(
  actor: Principal,
  input: {
    academicYearId: string;
    name: string;
    sequence: number;
    startDate: Date;
    endDate: Date;
    status?: PeriodStatus;
  },
  repository: AcademicRepository = academicRepository,
): Promise<TermSummary> {
  const year = await repository.findAcademicYear(actor.scope, input.academicYearId);
  if (year === null) throw new NotFoundError('That academic year was not found.');

  assertDateOrder(input.startDate, input.endDate, 'term');
  assertTermFitsYear(input, year);
  assertNoTermOverlap(input, year.terms);

  const created = await repository.createTerm(actor.scope, {
    academicYearId: input.academicYearId,
    name: input.name,
    sequence: input.sequence,
    startDate: input.startDate,
    endDate: input.endDate,
    status: input.status ?? 'UPCOMING',
  });

  await record({
    action: AuditAction.TERM_CREATED,
    entityType: AuditEntity.TERM,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { name: created.name, academicYearId: input.academicYearId },
  });

  return toTermSummary(created);
}

export async function updateTerm(
  actor: Principal,
  args: {
    id: string;
    expectedVersion: number;
    name?: string;
    sequence?: number;
    startDate?: Date;
    endDate?: Date;
    status?: PeriodStatus;
  },
  repository: AcademicRepository = academicRepository,
): Promise<TermSummary> {
  const existing = await repository.findTerm(actor.scope, args.id);
  if (existing === null) throw new NotFoundError('That term was not found.');

  assertNotReopening(existing.status, args.status, 'term');

  const startDate = args.startDate ?? existing.startDate;
  const endDate = args.endDate ?? existing.endDate;
  assertDateOrder(startDate, endDate, 'term');

  const year = await repository.findAcademicYear(actor.scope, existing.academicYearId);
  if (year !== null) {
    assertTermFitsYear({ startDate, endDate }, year);
    assertNoTermOverlap({ startDate, endDate }, year.terms, existing.id);
  }

  const updated = await repository.updateTerm(actor.scope, {
    id: args.id,
    expectedVersion: args.expectedVersion,
    changes: {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.sequence !== undefined ? { sequence: args.sequence } : {}),
      ...(args.startDate !== undefined ? { startDate: args.startDate } : {}),
      ...(args.endDate !== undefined ? { endDate: args.endDate } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    },
  });

  await record({
    action: AuditAction.TERM_UPDATED,
    entityType: AuditEntity.TERM,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
  });

  return toTermSummary(updated);
}

export async function setCurrentTerm(
  actor: Principal,
  id: string,
  repository: AcademicRepository = academicRepository,
): Promise<TermSummary> {
  const term = await repository.findTerm(actor.scope, id);
  if (term === null) throw new NotFoundError('That term was not found.');

  if (term.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      'A closed term cannot be made the current one.',
    );
  }

  await repository.setCurrentTerm(actor.scope, id);

  await record({
    action: AuditAction.TERM_SET_CURRENT,
    entityType: AuditEntity.TERM,
    entityId: id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { name: term.name },
  });

  const refreshed = await repository.findTerm(actor.scope, id);
  return toTermSummary(refreshed ?? term);
}

/* -------------------------------------------------------------- departments */

export async function listDepartments(
  actor: Principal,
  repository: AcademicRepository = academicRepository,
): Promise<readonly DepartmentSummary[]> {
  const departments = await repository.listDepartments(actor.scope);
  return departments.map((department) => ({
    id: department.id,
    code: department.code,
    name: department.name,
    description: department.description,
    programCount: department._count.programs,
  }));
}

export async function createDepartment(
  actor: Principal,
  input: { code: string; name: string; description?: string | null },
  repository: AcademicRepository = academicRepository,
): Promise<DepartmentSummary> {
  const created = await repository.createDepartment(actor.scope, input);

  await record({
    action: AuditAction.DEPARTMENT_CREATED,
    entityType: AuditEntity.DEPARTMENT,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { code: created.code },
  });

  return { ...created, programCount: 0 };
}

/* ---------------------------------------------------------------- programmes */

export async function listPrograms(
  actor: Principal,
  filters: { status?: ProgramStatus } = {},
  repository: AcademicRepository = academicRepository,
): Promise<readonly ProgramSummary[]> {
  const programs = await repository.listPrograms(actor.scope, filters);
  return programs.map(toProgramSummary);
}

export async function createProgram(
  actor: Principal,
  input: {
    code: string;
    name: string;
    description?: string | null;
    departmentId?: string | null;
    durationYears?: number | null;
    sortOrder?: number;
  },
  repository: AcademicRepository = academicRepository,
): Promise<ProgramSummary> {
  const created = await repository.createProgram(actor.scope, {
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    departmentId: input.departmentId ?? null,
    durationYears: input.durationYears ?? null,
    sortOrder: input.sortOrder ?? 0,
  });

  await record({
    action: AuditAction.PROGRAM_CREATED,
    entityType: AuditEntity.PROGRAM,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { code: created.code },
  });

  return toProgramSummary(created);
}

/**
 * Change a programme.
 *
 * Discontinuing one is allowed and does not touch existing enrolments: historical
 * records reference the programme, and rewriting them to hide that it was ever offered
 * would falsify the history the audit trail exists to preserve.
 */
export async function updateProgram(
  actor: Principal,
  args: {
    id: string;
    expectedVersion: number;
    name?: string;
    description?: string | null;
    departmentId?: string | null;
    durationYears?: number | null;
    status?: ProgramStatus;
    sortOrder?: number;
  },
  repository: AcademicRepository = academicRepository,
): Promise<ProgramSummary> {
  const existing = await repository.findProgram(actor.scope, args.id);
  if (existing === null) throw new NotFoundError('That programme was not found.');

  const updated = await repository.updateProgram(actor.scope, {
    id: args.id,
    expectedVersion: args.expectedVersion,
    changes: {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.departmentId !== undefined ? { departmentId: args.departmentId } : {}),
      ...(args.durationYears !== undefined ? { durationYears: args.durationYears } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.sortOrder !== undefined ? { sortOrder: args.sortOrder } : {}),
    },
  });

  await record({
    action: AuditAction.PROGRAM_UPDATED,
    entityType: AuditEntity.PROGRAM,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { statusChanged: args.status !== undefined && args.status !== existing.status },
  });

  return toProgramSummary(updated);
}

/* -------------------------------------------------------------------- levels */

export async function listLevels(
  actor: Principal,
  filters: { programId?: string } = {},
  repository: AcademicRepository = academicRepository,
): Promise<readonly LevelSummary[]> {
  const levels = await repository.listLevels(actor.scope, filters);
  return levels.map(toLevelSummary);
}

export async function createLevel(
  actor: Principal,
  input: {
    programId: string;
    code: string;
    name: string;
    sequence: number;
    isTerminal?: boolean;
  },
  repository: AcademicRepository = academicRepository,
): Promise<LevelSummary> {
  const program = await repository.findProgram(actor.scope, input.programId);
  if (program === null) throw new NotFoundError('That programme was not found.');

  const created = await repository.createLevel(actor.scope, {
    programId: input.programId,
    code: input.code,
    name: input.name,
    sequence: input.sequence,
    isTerminal: input.isTerminal ?? false,
  });

  await record({
    action: AuditAction.LEVEL_CREATED,
    entityType: AuditEntity.LEVEL,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { code: created.code, programId: input.programId },
  });

  return toLevelSummary(created);
}

/**
 * Chain one level to the next.
 *
 * Three refusals, all protecting end-of-year promotion, which is a data walk rather
 * than a rule in code:
 *
 *  - a level cannot follow itself;
 *  - both levels must belong to the same programme, or promotion would move a student
 *    between programmes silently;
 *  - the chain must not cycle, or promotion would loop forever.
 */
export async function setLevelProgression(
  actor: Principal,
  args: { levelId: string; nextLevelId: string | null },
  repository: AcademicRepository = academicRepository,
): Promise<LevelSummary> {
  const level = await repository.findLevel(actor.scope, args.levelId);
  if (level === null) throw new NotFoundError('That level was not found.');

  if (args.nextLevelId !== null) {
    if (args.nextLevelId === args.levelId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'A level cannot be its own next level: promotion would never end.',
      );
    }

    const next = await repository.findLevel(actor.scope, args.nextLevelId);
    if (next === null) throw new NotFoundError('The next level was not found.');

    if (next.programId !== level.programId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'A level can only lead to another level in the same programme.',
      );
    }

    await assertNoProgressionCycle(actor, repository, { from: args.nextLevelId, to: args.levelId });
  }

  await repository.setNextLevel(actor.scope, args);

  await record({
    action: AuditAction.LEVEL_UPDATED,
    entityType: AuditEntity.LEVEL,
    entityId: args.levelId,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { nextLevelId: args.nextLevelId },
  });

  const refreshed = await repository.findLevel(actor.scope, args.levelId);
  return toLevelSummary(refreshed ?? level);
}

/**
 * Walk forward from `from` and refuse if `to` is reachable.
 *
 * Bounded by the number of levels in the programme, so a chain that is already
 * corrupt cannot make this loop.
 */
async function assertNoProgressionCycle(
  actor: Principal,
  repository: AcademicRepository,
  args: { from: string; to: string },
): Promise<void> {
  const levels = await repository.listLevels(actor.scope);
  const byId = new Map(levels.map((level) => [level.id, level]));

  let cursor: string | null = args.from;
  for (let step = 0; step < levels.length && cursor !== null; step += 1) {
    if (cursor === args.to) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That would create a loop in the level progression, and promotion would never terminate.',
      );
    }
    cursor = byId.get(cursor)?.nextLevelId ?? null;
  }
}

/* ------------------------------------------------------------- class sections */

export async function listClassSections(
  actor: Principal,
  filters: { academicYearId?: string; levelId?: string } = {},
  repository: AcademicRepository = academicRepository,
): Promise<readonly ClassSectionSummary[]> {
  const sections = await repository.listClassSections(actor.scope, filters);
  return sections.map(toClassSectionSummary);
}

export async function createClassSection(
  actor: Principal,
  input: {
    academicYearId: string;
    levelId: string;
    code: string;
    name: string;
    capacity?: number | null;
    classTeacherName?: string | null;
  },
  repository: AcademicRepository = academicRepository,
): Promise<ClassSectionSummary> {
  const [year, level] = await Promise.all([
    repository.findAcademicYear(actor.scope, input.academicYearId),
    repository.findLevel(actor.scope, input.levelId),
  ]);
  if (year === null) throw new NotFoundError('That academic year was not found.');
  if (level === null) throw new NotFoundError('That level was not found.');

  const created = await repository.createClassSection(actor.scope, input);

  await record({
    action: AuditAction.CLASS_SECTION_CREATED,
    entityType: AuditEntity.CLASS_SECTION,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { code: created.code, academicYearId: input.academicYearId },
  });

  return toClassSectionSummary(created);
}

/**
 * Change a class.
 *
 * Capacity may be lowered below the current occupancy. That is deliberate: the number
 * is a planning guide, and refusing the edit would leave an administrator unable to
 * record a room that genuinely shrank. Enrolment is what enforces capacity, at the
 * point a new student would exceed it.
 */
export async function updateClassSection(
  actor: Principal,
  args: {
    id: string;
    expectedVersion: number;
    name?: string;
    capacity?: number | null;
    classTeacherName?: string | null;
  },
  repository: AcademicRepository = academicRepository,
): Promise<ClassSectionSummary> {
  const existing = await repository.findClassSection(actor.scope, args.id);
  if (existing === null) throw new NotFoundError('That class was not found.');

  const updated = await repository.updateClassSection(actor.scope, {
    id: args.id,
    expectedVersion: args.expectedVersion,
    changes: {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.capacity !== undefined ? { capacity: args.capacity } : {}),
      ...(args.classTeacherName !== undefined ? { classTeacherName: args.classTeacherName } : {}),
    },
  });

  await record({
    action: AuditAction.CLASS_SECTION_UPDATED,
    entityType: AuditEntity.CLASS_SECTION,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
  });

  return toClassSectionSummary(updated);
}

/**
 * Refuse to place a student in a class that is already at capacity.
 *
 * Exported because enrolment and the bulk import both need it, and a capacity rule
 * enforced in one path but not the other is not a rule.
 */
export async function assertClassSectionHasRoom(
  actor: Principal,
  classSection: ClassSectionRecord,
  repository: AcademicRepository = academicRepository,
): Promise<void> {
  if (classSection.capacity === null) return;

  const enrolled = await repository.countEnrolledInClassSection(actor.scope, classSection.id);
  if (enrolled >= classSection.capacity) {
    throw new ConflictError(
      `${classSection.name} is full (${String(enrolled)} of ${String(classSection.capacity)}). Choose another class or raise its capacity.`,
      ErrorCode.CONFLICT,
    );
  }
}
