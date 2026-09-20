/**
 * Student registration, profile and lifecycle.
 *
 * Three rules shape this file, and each is about a record that outlives the student's
 * time at the school:
 *
 *  - **The Student ID is allocated once and never changes.** It appears on receipts and
 *    in every financial record, so it is issued from a counter inside the same
 *    transaction as the insert (see `identifier-sequence.ts`) and is not editable
 *    afterwards. There is no endpoint to change it, deliberately.
 *
 *  - **Registration and first enrolment are one transaction.** A student row with no
 *    enrolment is a student nobody can charge, place or report on — the registrar
 *    would have to notice and fix it by hand. Either both exist or neither does.
 *
 *  - **Leaving is a status change plus an enrolment ending, never a deletion.** The
 *    financial history has to stay readable for clearance checks and audits long after
 *    the student has gone.
 */
import {
  ErrorCode,
  type EnrollmentSummary,
  type GenderValue,
  type ResidencyValue,
  type StudentDetail,
  type StudentGuardianLink,
  type StudentState,
  type StudentSummary,
} from '@sfs/shared';

import type {
  EnrollmentStatus,
  EnrollmentType,
  Gender,
  ResidencyType,
  StudentStatus,
} from '../../generated/prisma/enums.js';
import { DomainError, NotFoundError } from '../../lib/errors.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import { academicRepository, type AcademicRepository } from '../academic/academic.repository.js';
import {
  assertClassSectionHasRoom,
  requireCurrentAcademicYear,
} from '../academic/academic.service.js';
import type { Principal } from '../auth/principal.js';
import {
  enrollmentRepository,
  type EnrollmentRepository,
} from '../enrollments/enrollment.repository.js';
import {
  studentRepository,
  type EnrollmentWithRelations,
  type StudentDetailRecord,
  type StudentListFilters,
  type StudentRepository,
  type StudentWithEnrollment,
} from './student.repository.js';

/* ----------------------------------------------------------------- projections */

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function toEnrollmentSummary(enrollment: EnrollmentWithRelations): EnrollmentSummary {
  const status: EnrollmentSummary['status'] = enrollment.status;
  const enrollmentType: EnrollmentSummary['enrollmentType'] = enrollment.enrollmentType;
  const residency: ResidencyValue = enrollment.residency;

  return {
    id: enrollment.id,
    studentId: enrollment.studentId,
    academicYearId: enrollment.academicYearId,
    academicYearName: enrollment.academicYear.name,
    programId: enrollment.programId,
    programName: enrollment.program.name,
    levelId: enrollment.levelId,
    levelName: enrollment.level.name,
    classSectionId: enrollment.classSectionId,
    classSectionName: enrollment.classSection?.name ?? null,
    status,
    enrollmentType,
    residency,
    startDate: toDateString(enrollment.startDate),
    endDate: enrollment.endDate === null ? null : toDateString(enrollment.endDate),
    exitReason: enrollment.exitReason,
    version: enrollment.version,
  };
}

function toStudentSummary(student: StudentWithEnrollment): StudentSummary {
  const status: StudentState = student.status;
  const gender: GenderValue = student.gender;
  const current = student.enrollments[0];

  return {
    id: student.id,
    studentId: student.studentId,
    firstName: student.firstName,
    lastName: student.lastName,
    otherNames: student.otherNames,
    gender,
    status,
    admissionDate: toDateString(student.admissionDate),
    admissionYear: student.admissionYear,
    currentEnrollment: current === undefined ? null : toEnrollmentSummary(current),
    version: student.version,
  };
}

function toGuardianLink(link: StudentDetailRecord['guardians'][number]): StudentGuardianLink {
  const relationship: StudentGuardianLink['relationship'] = link.relationship;

  return {
    id: link.id,
    guardianId: link.guardianId,
    studentId: link.studentId,
    guardianFirstName: link.guardian.firstName,
    guardianLastName: link.guardian.lastName,
    guardianPhone: link.guardian.phone,
    relationship,
    isPrimaryContact: link.isPrimaryContact,
    isFinanciallyResponsible: link.isFinanciallyResponsible,
    canViewFinancials: link.canViewFinancials,
    canInitiatePayments: link.canInitiatePayments,
    version: link.version,
  };
}

export function toStudentDetail(student: StudentDetailRecord): StudentDetail {
  const status: StudentState = student.status;
  const gender: GenderValue = student.gender;
  // "Current" means the live enrolment, not merely the newest: a student who withdrew
  // in March has a most-recent enrolment, and it is not a current placement.
  const current = student.enrollments.find((enrollment) => enrollment.status === 'ENROLLED');

  return {
    id: student.id,
    studentId: student.studentId,
    firstName: student.firstName,
    lastName: student.lastName,
    otherNames: student.otherNames,
    gender,
    status,
    admissionDate: toDateString(student.admissionDate),
    admissionYear: student.admissionYear,
    currentEnrollment: current === undefined ? null : toEnrollmentSummary(current),
    version: student.version,
    dateOfBirth: student.dateOfBirth === null ? null : toDateString(student.dateOfBirth),
    nationalIdNumber: student.nationalIdNumber,
    district: student.district,
    sector: student.sector,
    address: student.address,
    phone: student.phone,
    email: student.email,
    guardians: student.guardians.map(toGuardianLink),
    enrollments: student.enrollments.map(toEnrollmentSummary),
    createdAt: student.createdAt.toISOString(),
    updatedAt: student.updatedAt.toISOString(),
  };
}

/* --------------------------------------------------------------------- reads */

export interface ListStudentsResult {
  readonly items: readonly StudentSummary[];
  readonly totalItems: number;
}

export async function listStudents(
  actor: Principal,
  filters: StudentListFilters,
  pagination: ResolvedPagination,
  deps: { students?: StudentRepository; academic?: AcademicRepository } = {},
): Promise<ListStudentsResult> {
  const students = deps.students ?? studentRepository;
  const academic = deps.academic ?? academicRepository;

  const currentYear = await academic.findCurrentAcademicYear(actor.scope);
  const page = await students.listWithCurrentEnrollment(
    actor.scope,
    filters,
    pagination,
    currentYear?.id ?? null,
  );

  return { items: page.items.map(toStudentSummary), totalItems: page.totalItems };
}

/**
 * One student, with guardians and the full enrolment history.
 *
 * Read unscoped and then checked, so a cross-school attempt is tagged in the logs
 * while still answering "not found" — the difference between that and a non-existent
 * id is only useful to someone enumerating.
 */
export async function getStudent(
  actor: Principal,
  studentId: string,
  repository: StudentRepository = studentRepository,
): Promise<StudentDetail> {
  const student = await repository.findDetailUnscoped(studentId);
  actor.scope.assertPermits(student, 'student');
  if (student === null) throw new NotFoundError('That student was not found.');

  return toStudentDetail(student);
}

/* ---------------------------------------------------------------- registration */

export interface RegisterStudentArgs {
  readonly firstName: string;
  readonly lastName: string;
  readonly otherNames?: string | null;
  readonly gender?: Gender;
  readonly dateOfBirth?: Date | null;
  readonly admissionDate: Date;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;

  /** The first enrolment. Registration without one would leave an unplaceable student. */
  readonly enrolment: {
    readonly levelId: string;
    readonly classSectionId?: string | null;
    readonly residency?: ResidencyType;
    readonly enrollmentType?: EnrollmentType;
    /** Defaults to the academic year's start date. */
    readonly startDate?: Date;
  };
}

export async function registerStudent(
  actor: Principal,
  args: RegisterStudentArgs,
  deps: {
    students?: StudentRepository;
    academic?: AcademicRepository;
    enrollments?: EnrollmentRepository;
  } = {},
): Promise<StudentDetail> {
  const students = deps.students ?? studentRepository;
  const academic = deps.academic ?? academicRepository;
  const enrollments = deps.enrollments ?? enrollmentRepository;

  const year = await requireCurrentAcademicYear(actor, academic);

  const level = await academic.findLevel(actor.scope, args.enrolment.levelId);
  if (level === null) throw new NotFoundError('That level was not found.');

  const classSection = await resolveClassSection(actor, academic, {
    classSectionId: args.enrolment.classSectionId ?? null,
    levelId: level.id,
    academicYearId: year.id,
  });

  const student = await students.create(actor.scope, {
    firstName: args.firstName,
    lastName: args.lastName,
    otherNames: args.otherNames ?? null,
    ...(args.gender !== undefined ? { gender: args.gender } : {}),
    dateOfBirth: args.dateOfBirth ?? null,
    admissionDate: args.admissionDate,
    district: args.district ?? null,
    sector: args.sector ?? null,
    address: args.address ?? null,
    phone: args.phone ?? null,
    email: args.email ?? null,
  });

  await enrollments.create(actor.scope, {
    studentId: student.id,
    academicYearId: year.id,
    programId: level.programId,
    levelId: level.id,
    classSectionId: classSection?.id ?? null,
    status: 'ENROLLED',
    enrollmentType: args.enrolment.enrollmentType ?? 'NEW',
    residency: args.enrolment.residency ?? 'DAY',
    startDate: args.enrolment.startDate ?? year.startDate,
  });

  await record({
    action: AuditAction.STUDENT_REGISTERED,
    entityType: AuditEntity.STUDENT,
    entityId: student.id,
    actorUserId: actor.userId,
    schoolId: student.schoolId,
    afterState: {
      studentId: student.studentId,
      firstName: student.firstName,
      lastName: student.lastName,
      admissionDate: toDateString(student.admissionDate),
    },
    metadata: { levelId: level.id, academicYearId: year.id },
  });

  return getStudent(actor, student.id, students);
}

/**
 * Resolve and validate the class a student is being placed in.
 *
 * Two checks, because a mismatch here misplaces a student in a way nobody notices until
 * a class list is printed: the class must belong to the level being enrolled into, and
 * to the academic year the enrolment is for.
 */
async function resolveClassSection(
  actor: Principal,
  academic: AcademicRepository,
  args: { classSectionId: string | null; levelId: string; academicYearId: string },
): Promise<{ id: string; name: string } | null> {
  if (args.classSectionId === null) return null;

  const section = await academic.findClassSection(actor.scope, args.classSectionId);
  if (section === null) throw new NotFoundError('That class was not found.');

  if (section.levelId !== args.levelId) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'That class belongs to a different level than the one being enrolled into.',
    );
  }
  if (section.academicYearId !== args.academicYearId) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'That class belongs to a different academic year.',
    );
  }

  await assertClassSectionHasRoom(actor, section, academic);
  return { id: section.id, name: section.name };
}

export { resolveClassSection };

/* --------------------------------------------------------------------- profile */

export interface UpdateStudentArgs {
  readonly studentId: string;
  readonly expectedVersion: number;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly otherNames?: string | null;
  readonly dateOfBirth?: Date | null;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
}

/**
 * Correct a student's details.
 *
 * Notably absent: `studentId` and `status`. The identifier is on receipts and must
 * never change, and a status change is a lifecycle decision with its own endpoint and
 * its own audit action.
 */
export async function updateStudent(
  actor: Principal,
  args: UpdateStudentArgs,
  repository: StudentRepository = studentRepository,
): Promise<StudentDetail> {
  const existing = await repository.findDetailUnscoped(args.studentId);
  actor.scope.assertPermits(existing, 'student');
  if (existing === null) throw new NotFoundError('That student was not found.');

  await repository.update(actor.scope, {
    id: args.studentId,
    expectedVersion: args.expectedVersion,
    changes: {
      ...(args.firstName !== undefined ? { firstName: args.firstName } : {}),
      ...(args.lastName !== undefined ? { lastName: args.lastName } : {}),
      ...(args.otherNames !== undefined ? { otherNames: args.otherNames } : {}),
      ...(args.dateOfBirth !== undefined ? { dateOfBirth: args.dateOfBirth } : {}),
      ...(args.district !== undefined ? { district: args.district } : {}),
      ...(args.sector !== undefined ? { sector: args.sector } : {}),
      ...(args.address !== undefined ? { address: args.address } : {}),
      ...(args.phone !== undefined ? { phone: args.phone } : {}),
      ...(args.email !== undefined ? { email: args.email } : {}),
    },
  });

  await record({
    action: AuditAction.STUDENT_UPDATED,
    entityType: AuditEntity.STUDENT,
    entityId: args.studentId,
    actorUserId: actor.userId,
    schoolId: existing.schoolId,
    beforeState: {
      firstName: existing.firstName,
      lastName: existing.lastName,
      phone: existing.phone,
      email: existing.email,
    },
  });

  return getStudent(actor, args.studentId, repository);
}

/* ------------------------------------------------------------------- lifecycle */

/**
 * Which status changes are permitted.
 *
 * `ARCHIVED` is the terminal state for a former student whose financial history is
 * retained, and nothing leaves it: un-archiving would mean a record that had been
 * closed for audit purposes is live again, which is a decision for an administrator
 * with a database, not a button.
 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<StudentStatus, readonly StudentStatus[]>> = {
  ACTIVE: ['COMPLETED', 'TRANSFERRED', 'WITHDRAWN', 'SUSPENDED', 'ARCHIVED'],
  SUSPENDED: ['ACTIVE', 'WITHDRAWN', 'TRANSFERRED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  TRANSFERRED: ['ARCHIVED'],
  WITHDRAWN: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

/** The enrolment outcome that goes with a student leaving, where there is one. */
const EXIT_ENROLLMENT_STATUS: Partial<Record<StudentStatus, EnrollmentStatus>> = {
  COMPLETED: 'COMPLETED',
  TRANSFERRED: 'TRANSFERRED_OUT',
  WITHDRAWN: 'WITHDRAWN',
};

export interface ChangeStudentStatusArgs {
  readonly studentId: string;
  readonly expectedVersion: number;
  readonly status: StudentStatus;
  readonly reason?: string | undefined;
  /** Defaults to today. The date the student actually left, for proration in Phase 9. */
  readonly effectiveDate?: Date | undefined;
}

/**
 * Move a student through their lifecycle.
 *
 * When the change means they have left, the live enrolment is ended in the same
 * operation. Leaving those two to be done separately is how a school ends up with a
 * withdrawn student still counted in a class list and still accruing term charges.
 */
export async function changeStudentStatus(
  actor: Principal,
  args: ChangeStudentStatusArgs,
  deps: { students?: StudentRepository; enrollments?: EnrollmentRepository } = {},
): Promise<StudentDetail> {
  const students = deps.students ?? studentRepository;
  const enrollments = deps.enrollments ?? enrollmentRepository;

  const existing = await students.findDetailUnscoped(args.studentId);
  actor.scope.assertPermits(existing, 'student');
  if (existing === null) throw new NotFoundError('That student was not found.');

  const from: StudentStatus = existing.status;
  if (from === args.status) {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      `This student is already ${args.status.toLowerCase()}.`,
    );
  }

  const permitted = ALLOWED_STATUS_TRANSITIONS[from];
  if (!permitted.includes(args.status)) {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      `A student who is ${from.toLowerCase()} cannot be marked ${args.status.toLowerCase()}.`,
      { details: { from, to: args.status, allowed: permitted } },
    );
  }

  await students.setStatus(actor.scope, {
    id: args.studentId,
    expectedVersion: args.expectedVersion,
    status: args.status,
  });

  const enrollmentOutcome = EXIT_ENROLLMENT_STATUS[args.status];
  if (enrollmentOutcome !== undefined) {
    const live = existing.enrollments.find((enrollment) => enrollment.status === 'ENROLLED');
    if (live !== undefined) {
      await enrollments.end(actor.scope, {
        id: live.id,
        status: enrollmentOutcome,
        endDate: args.effectiveDate ?? new Date(),
        exitReason: args.reason ?? null,
      });
    }
  }

  await record({
    action: AuditAction.STUDENT_STATUS_CHANGED,
    entityType: AuditEntity.STUDENT,
    entityId: args.studentId,
    actorUserId: actor.userId,
    schoolId: existing.schoolId,
    reason: args.reason ?? null,
    beforeState: { status: from },
    afterState: { status: args.status },
  });

  return getStudent(actor, args.studentId, students);
}
