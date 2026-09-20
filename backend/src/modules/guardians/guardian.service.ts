/**
 * Guardians, and their links to students.
 *
 * The rules here are mostly about who the school can actually reach and who is allowed
 * to act financially:
 *
 *  - **One primary contact per student.** Two is the same as none when somebody has to
 *    be rung about an unpaid balance, so setting a new one clears the old in the same
 *    transaction.
 *  - **A guardian belongs to a school.** Linking across schools is refused, not
 *    silently ignored — a parent with children at two schools gets a record at each,
 *    because the financial rights are per school.
 *  - **Unlinking removes access, not history.** The link row goes; the payments that
 *    guardian made do not, and Phase 5 reads them by payer identity rather than by
 *    the link.
 */
import { ErrorCode, type GuardianSummary, type StudentGuardianLink } from '@sfs/shared';

import type { GuardianRelationship } from '../../generated/prisma/enums.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { studentRepository, type StudentRepository } from '../students/student.repository.js';
import {
  guardianRepository,
  type GuardianLinkRecord,
  type GuardianRecord,
  type GuardianRepository,
} from './guardian.repository.js';

interface Dependencies {
  readonly guardians?: GuardianRepository;
  readonly students?: StudentRepository;
}

/* ----------------------------------------------------------------- projections */

function toGuardianSummary(guardian: GuardianRecord): GuardianSummary {
  return {
    id: guardian.id,
    firstName: guardian.firstName,
    lastName: guardian.lastName,
    phone: guardian.phone,
    altPhone: guardian.altPhone,
    email: guardian.email,
    nationalIdNumber: guardian.nationalIdNumber,
    occupation: guardian.occupation,
    district: guardian.district,
    sector: guardian.sector,
    address: guardian.address,
    userId: guardian.userId,
    linkedStudentCount: guardian._count.students,
    version: guardian.version,
  };
}

export function toLinkSummary(link: GuardianLinkRecord): StudentGuardianLink {
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

/* --------------------------------------------------------------------- reads */

export async function listGuardians(
  actor: Principal,
  filters: { search?: string | undefined },
  pagination: ResolvedPagination,
  deps: Dependencies = {},
): Promise<{ items: readonly GuardianSummary[]; totalItems: number }> {
  const guardians = deps.guardians ?? guardianRepository;
  const page = await guardians.list(actor.scope, filters, pagination);
  return { items: page.items.map(toGuardianSummary), totalItems: page.totalItems };
}

export async function getGuardian(
  actor: Principal,
  guardianId: string,
  deps: Dependencies = {},
): Promise<GuardianSummary> {
  const guardians = deps.guardians ?? guardianRepository;
  const guardian = await guardians.findById(actor.scope, guardianId);
  if (guardian === null) throw new NotFoundError('That guardian was not found.');
  return toGuardianSummary(guardian);
}

/* ------------------------------------------------------------------- writes */

export interface CreateGuardianArgs {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly altPhone?: string | null;
  readonly email?: string | null;
  readonly nationalIdNumber?: string | null;
  readonly occupation?: string | null;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
}

export async function createGuardian(
  actor: Principal,
  args: CreateGuardianArgs,
  deps: Dependencies = {},
): Promise<GuardianSummary> {
  const guardians = deps.guardians ?? guardianRepository;
  const created = await guardians.create(actor.scope, args);

  await record({
    action: AuditAction.GUARDIAN_CREATED,
    entityType: AuditEntity.GUARDIAN,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { phone: created.phone },
  });

  return toGuardianSummary(created);
}

export async function updateGuardian(
  actor: Principal,
  args: { guardianId: string; expectedVersion: number } & Partial<CreateGuardianArgs>,
  deps: Dependencies = {},
): Promise<GuardianSummary> {
  const guardians = deps.guardians ?? guardianRepository;

  const existing = await guardians.findById(actor.scope, args.guardianId);
  if (existing === null) throw new NotFoundError('That guardian was not found.');

  const { guardianId, expectedVersion, ...changes } = args;

  const updated = await guardians.update(actor.scope, {
    id: guardianId,
    expectedVersion,
    changes,
  });

  await record({
    action: AuditAction.GUARDIAN_UPDATED,
    entityType: AuditEntity.GUARDIAN,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
  });

  return toGuardianSummary(updated);
}

/* ------------------------------------------------------------------- linking */

export interface LinkGuardianArgs {
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationship?: GuardianRelationship;
  readonly isPrimaryContact?: boolean;
  readonly isFinanciallyResponsible?: boolean;
  readonly canViewFinancials?: boolean;
  readonly canInitiatePayments?: boolean;
}

export async function linkGuardianToStudent(
  actor: Principal,
  args: LinkGuardianArgs,
  deps: Dependencies = {},
): Promise<StudentGuardianLink> {
  const guardians = deps.guardians ?? guardianRepository;
  const students = deps.students ?? studentRepository;

  const [student, guardian] = await Promise.all([
    students.findById(actor.scope, args.studentId),
    guardians.findById(actor.scope, args.guardianId),
  ]);
  if (student === null) throw new NotFoundError('That student was not found.');
  if (guardian === null) throw new NotFoundError('That guardian was not found.');

  const existing = await guardians.findLink(actor.scope, {
    studentId: args.studentId,
    guardianId: args.guardianId,
  });
  if (existing !== null) {
    throw new ConflictError(
      'That guardian is already linked to this student.',
      ErrorCode.DUPLICATE_RESOURCE,
    );
  }

  const isPrimaryContact = args.isPrimaryContact ?? false;
  if (isPrimaryContact) {
    // Cleared first: a student with two primary contacts has, in practice, none.
    await guardians.clearPrimaryContact(actor.scope, { studentId: args.studentId });
  }

  const link = await guardians.link(actor.scope, {
    studentId: args.studentId,
    guardianId: args.guardianId,
    relationship: args.relationship ?? 'GUARDIAN',
    isPrimaryContact,
    isFinanciallyResponsible: args.isFinanciallyResponsible ?? false,
    canViewFinancials: args.canViewFinancials ?? true,
    canInitiatePayments: args.canInitiatePayments ?? true,
  });

  await record({
    action: AuditAction.GUARDIAN_LINKED,
    entityType: AuditEntity.STUDENT_GUARDIAN,
    entityId: link.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: {
      studentId: args.studentId,
      guardianId: args.guardianId,
      // Recorded because these decide who may see a balance and who may pay.
      canViewFinancials: link.canViewFinancials,
      canInitiatePayments: link.canInitiatePayments,
      isFinanciallyResponsible: link.isFinanciallyResponsible,
    },
  });

  return toLinkSummary(link);
}

export interface UpdateLinkArgs {
  readonly linkId: string;
  readonly expectedVersion: number;
  readonly relationship?: GuardianRelationship;
  readonly isPrimaryContact?: boolean;
  readonly isFinanciallyResponsible?: boolean;
  readonly canViewFinancials?: boolean;
  readonly canInitiatePayments?: boolean;
}

/**
 * Change a link.
 *
 * Every field here is an authorisation input for the parent portal, so the change is
 * audited with its before and after rather than merely noted.
 */
export async function updateGuardianLink(
  actor: Principal,
  args: UpdateLinkArgs,
  deps: Dependencies = {},
): Promise<StudentGuardianLink> {
  const guardians = deps.guardians ?? guardianRepository;

  const existing = await guardians.findLinkById(actor.scope, args.linkId);
  if (existing === null) throw new NotFoundError('That guardian link was not found.');

  if (args.isPrimaryContact === true) {
    await guardians.clearPrimaryContact(actor.scope, {
      studentId: existing.studentId,
      exceptLinkId: existing.id,
    });
  }

  const updated = await guardians.updateLink(actor.scope, {
    id: args.linkId,
    expectedVersion: args.expectedVersion,
    changes: {
      ...(args.relationship !== undefined ? { relationship: args.relationship } : {}),
      ...(args.isPrimaryContact !== undefined ? { isPrimaryContact: args.isPrimaryContact } : {}),
      ...(args.isFinanciallyResponsible !== undefined
        ? { isFinanciallyResponsible: args.isFinanciallyResponsible }
        : {}),
      ...(args.canViewFinancials !== undefined
        ? { canViewFinancials: args.canViewFinancials }
        : {}),
      ...(args.canInitiatePayments !== undefined
        ? { canInitiatePayments: args.canInitiatePayments }
        : {}),
    },
  });

  await record({
    action: AuditAction.GUARDIAN_LINK_UPDATED,
    entityType: AuditEntity.STUDENT_GUARDIAN,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    beforeState: {
      canViewFinancials: existing.canViewFinancials,
      canInitiatePayments: existing.canInitiatePayments,
      isFinanciallyResponsible: existing.isFinanciallyResponsible,
      isPrimaryContact: existing.isPrimaryContact,
    },
    afterState: {
      canViewFinancials: updated.canViewFinancials,
      canInitiatePayments: updated.canInitiatePayments,
      isFinanciallyResponsible: updated.isFinanciallyResponsible,
      isPrimaryContact: updated.isPrimaryContact,
    },
  });

  return toLinkSummary(updated);
}

export async function unlinkGuardian(
  actor: Principal,
  linkId: string,
  deps: Dependencies = {},
): Promise<void> {
  const guardians = deps.guardians ?? guardianRepository;

  const existing = await guardians.findLinkById(actor.scope, linkId);
  if (existing === null) throw new NotFoundError('That guardian link was not found.');

  const removed = await guardians.unlink(actor.scope, linkId);
  if (!removed) throw new NotFoundError('That guardian link was not found.');

  await record({
    action: AuditAction.GUARDIAN_UNLINKED,
    entityType: AuditEntity.STUDENT_GUARDIAN,
    entityId: linkId,
    actorUserId: actor.userId,
    schoolId: actor.scope.schoolId,
    metadata: { studentId: existing.studentId, guardianId: existing.guardianId },
  });
}

export async function listGuardiansForStudent(
  actor: Principal,
  studentId: string,
  deps: Dependencies = {},
): Promise<readonly StudentGuardianLink[]> {
  const guardians = deps.guardians ?? guardianRepository;
  const students = deps.students ?? studentRepository;

  const student = await students.findById(actor.scope, studentId);
  if (student === null) throw new NotFoundError('That student was not found.');

  const links = await guardians.listLinksForStudent(actor.scope, studentId);
  return links.map(toLinkSummary);
}
