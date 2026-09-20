/**
 * Enrolment rules.
 *
 * An enrolment is where a student, a year, a programme, a level and a class meet, and
 * it is what every later charge is computed against. The rules are therefore about
 * keeping that meeting point unambiguous:
 *
 *  - **One live enrolment per student per year.** Two would mean two sets of term
 *    charges for one student, which is the kind of error that surfaces as an
 *    unexplainable balance months later. A partial unique index enforces it; this
 *    layer turns the violation into a clear refusal rather than a 500.
 *  - **A class belongs to the level and the year being enrolled into**, or a student
 *    ends up on a class list they are not in.
 *  - **Ending an enrolment is not deleting it.** The row stays, with its outcome, its
 *    date and its reason.
 */
import { ErrorCode, type EnrollmentSummary } from '@sfs/shared';

import type {
  EnrollmentStatus,
  EnrollmentType,
  ResidencyType,
} from '../../generated/prisma/enums.js';
import { ConflictError, DomainError, NotFoundError } from '../../lib/errors.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import { academicRepository, type AcademicRepository } from '../academic/academic.repository.js';
import { requireCurrentAcademicYear } from '../academic/academic.service.js';
import type { Principal } from '../auth/principal.js';
import { studentRepository, type StudentRepository } from '../students/student.repository.js';
import { resolveClassSection, toEnrollmentSummary } from '../students/student.service.js';
import { enrollmentRepository, type EnrollmentRepository } from './enrollment.repository.js';

interface Dependencies {
  readonly enrollments?: EnrollmentRepository;
  readonly students?: StudentRepository;
  readonly academic?: AcademicRepository;
}

export async function listEnrollmentsForStudent(
  actor: Principal,
  studentId: string,
  deps: Dependencies = {},
): Promise<readonly EnrollmentSummary[]> {
  const students = deps.students ?? studentRepository;
  const enrollments = deps.enrollments ?? enrollmentRepository;

  const student = await students.findById(actor.scope, studentId);
  if (student === null) throw new NotFoundError('That student was not found.');

  const history = await enrollments.listForStudent(actor.scope, studentId);
  return history.map(toEnrollmentSummary);
}

export interface EnrolStudentArgs {
  readonly studentId: string;
  /** Defaults to the current academic year. */
  readonly academicYearId?: string | undefined;
  readonly levelId: string;
  readonly classSectionId?: string | null;
  readonly residency?: ResidencyType;
  readonly enrollmentType?: EnrollmentType;
  readonly startDate?: Date;
}

/**
 * Enrol a student for a year.
 *
 * Used for a re-admission, a transfer in, or a placement a registration did not make.
 * A student already live in that year is refused — that is a class move or a new year,
 * not a second enrolment.
 */
export async function enrolStudent(
  actor: Principal,
  args: EnrolStudentArgs,
  deps: Dependencies = {},
): Promise<EnrollmentSummary> {
  const students = deps.students ?? studentRepository;
  const enrollments = deps.enrollments ?? enrollmentRepository;
  const academic = deps.academic ?? academicRepository;

  const student = await students.findById(actor.scope, args.studentId);
  if (student === null) throw new NotFoundError('That student was not found.');

  if (student.status === 'ARCHIVED') {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      'This student is archived and cannot be enrolled. Reinstate the record first.',
    );
  }

  const year =
    args.academicYearId === undefined
      ? await requireCurrentAcademicYear(actor, academic)
      : await academic.findAcademicYear(actor.scope, args.academicYearId);
  if (year === null) throw new NotFoundError('That academic year was not found.');

  if (year.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.PERIOD_CLOSED,
      'That academic year is closed. A student cannot be enrolled into a closed year.',
    );
  }

  const existing = await enrollments.findLiveForStudent(actor.scope, {
    studentId: args.studentId,
    academicYearId: year.id,
  });
  if (existing !== null) {
    throw new ConflictError(
      `This student is already enrolled for ${year.name}. Move them to a different class instead of enrolling them twice.`,
      ErrorCode.CONFLICT,
    );
  }

  const level = await academic.findLevel(actor.scope, args.levelId);
  if (level === null) throw new NotFoundError('That level was not found.');

  const classSection = await resolveClassSection(actor, academic, {
    classSectionId: args.classSectionId ?? null,
    levelId: level.id,
    academicYearId: year.id,
  });

  const created = await enrollments.create(actor.scope, {
    studentId: args.studentId,
    academicYearId: year.id,
    programId: level.programId,
    levelId: level.id,
    classSectionId: classSection?.id ?? null,
    status: 'ENROLLED',
    enrollmentType: args.enrollmentType ?? 'CONTINUING',
    residency: args.residency ?? 'DAY',
    startDate: args.startDate ?? year.startDate,
  });

  await record({
    action: AuditAction.ENROLLMENT_CREATED,
    entityType: AuditEntity.ENROLLMENT,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: {
      studentId: args.studentId,
      academicYearId: year.id,
      levelId: level.id,
      classSectionId: classSection?.id ?? null,
    },
  });

  return toEnrollmentSummary(created);
}

export interface MoveClassArgs {
  readonly enrollmentId: string;
  readonly expectedVersion: number;
  readonly classSectionId: string | null;
}

/**
 * Move a live enrolment to another class in the same level and year.
 *
 * The only edit an ongoing enrolment accepts. A change of level is a promotion or a
 * correction that creates a new row, because rewriting the level in place would erase
 * where the student actually was.
 */
export async function moveToClass(
  actor: Principal,
  args: MoveClassArgs,
  deps: Dependencies = {},
): Promise<EnrollmentSummary> {
  const enrollments = deps.enrollments ?? enrollmentRepository;
  const academic = deps.academic ?? academicRepository;

  const existing = await enrollments.findById(actor.scope, args.enrollmentId);
  if (existing === null) throw new NotFoundError('That enrolment was not found.');

  if (existing.status !== 'ENROLLED') {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      'That enrolment has ended and cannot be changed. Enrol the student again instead.',
    );
  }

  const classSection = await resolveClassSection(actor, academic, {
    classSectionId: args.classSectionId,
    levelId: existing.levelId,
    academicYearId: existing.academicYearId,
  });

  const updated = await enrollments.moveToClassSection(actor.scope, {
    id: args.enrollmentId,
    expectedVersion: args.expectedVersion,
    classSectionId: classSection?.id ?? null,
  });

  await record({
    action: AuditAction.ENROLLMENT_UPDATED,
    entityType: AuditEntity.ENROLLMENT,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    beforeState: { classSectionId: existing.classSectionId },
    afterState: { classSectionId: updated.classSectionId },
  });

  return toEnrollmentSummary(updated);
}

export interface EndEnrollmentArgs {
  readonly enrollmentId: string;
  readonly status: Extract<
    EnrollmentStatus,
    'PROMOTED' | 'REPEATED' | 'COMPLETED' | 'TRANSFERRED_OUT' | 'WITHDRAWN'
  >;
  readonly endDate?: Date;
  readonly exitReason?: string | undefined;
}

/**
 * Close an enrolment with an outcome.
 *
 * The row is kept: a withdrawal in March is part of the record a clearance check and a
 * proration both read, and deleting it would make the term's charges unexplainable.
 */
export async function endEnrollment(
  actor: Principal,
  args: EndEnrollmentArgs,
  deps: Dependencies = {},
): Promise<EnrollmentSummary> {
  const enrollments = deps.enrollments ?? enrollmentRepository;

  const existing = await enrollments.findById(actor.scope, args.enrollmentId);
  if (existing === null) throw new NotFoundError('That enrolment was not found.');

  if (existing.status !== 'ENROLLED') {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      `That enrolment already ended as ${existing.status.toLowerCase().replace(/_/g, ' ')}.`,
    );
  }

  const endDate = args.endDate ?? new Date();
  if (endDate < existing.startDate) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'An enrolment cannot end before it started.',
    );
  }

  const updated = await enrollments.end(actor.scope, {
    id: args.enrollmentId,
    status: args.status,
    endDate,
    exitReason: args.exitReason ?? null,
  });

  await record({
    action: AuditAction.ENROLLMENT_ENDED,
    entityType: AuditEntity.ENROLLMENT,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    reason: args.exitReason ?? null,
    afterState: { status: args.status, endDate: endDate.toISOString().slice(0, 10) },
  });

  return toEnrollmentSummary(updated);
}
