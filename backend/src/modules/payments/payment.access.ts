/**
 * Who may see, and who may pay for, which student.
 *
 * Every payment endpoint that names a student goes through here. The rule it enforces is
 * the one Section 26 turns into an authorisation check: a parent may act only for the
 * students they are explicitly linked to, with the rights that link carries — and the
 * link is read from the database, never inferred from anything the client sent.
 *
 * ## Why a student id is not evidence of anything
 *
 * `studentId` arrives in a URL. Holding `own.payment_initiate` says a caller may pay for
 * *their own* children; it says nothing about whose id they typed. Without the link
 * lookup below, Parent A could read Parent B's child's balance, or pay off — or, worse,
 * later reverse — a payment against a student they have no relationship with. The
 * permission gets them through the door; this decides which rooms exist for them.
 *
 * ## Why an unauthorised parent gets 404 and not 403
 *
 * Answering "forbidden" would confirm that the id names a real student, which is itself a
 * disclosure: an attacker walking ids could enumerate the school's roll without ever
 * being allowed to read one record. The same reasoning, and the same choice, as
 * `AccessScope.assertPermits`. The distinction is recorded in the log, where it is
 * useful, rather than in the response, where it is a gift.
 *
 * ## Students
 *
 * The `STUDENT` role holds `own.financials_read`, but nothing in the schema links a
 * `User` to the `Student` they are. There is no defensible rule to invent for it —
 * matching on email would be wrong the first time a school reuses a family address, and
 * silently guessing a linkage in the module that guards financial data is exactly the
 * kind of invented business rule that must not be written. So self-service access
 * resolves through the guardian link only, and a student account currently reaches no
 * records. It fails closed, which is the safe direction, and it is recorded as
 * docs/OPEN-QUESTIONS.md #10 — a question for the school — rather than left as a silent
 * gap.
 */
import { ErrorCode, PermissionKey, type GuardianRelation } from '@sfs/shared';

import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import type { Principal } from '../auth/principal.js';
import { feeRepository } from '../fees/fee.repository.js';
import { paymentRepository } from './payment.repository.js';

const log = createLogger('payments.access');

/** What the caller wants to do with a student's financial records. */
export type FinancialIntent = 'VIEW' | 'INITIATE';

export interface StudentFinancialAccess {
  /** `STAFF` acts for the school; `SELF_SERVICE` acts for their own family. */
  readonly kind: 'STAFF' | 'SELF_SERVICE';
  readonly studentId: string;
  readonly schoolId: string;
  readonly studentNumber: string;
  readonly studentName: string;
  /** For a guardian, the relationship on the link. Null for staff. */
  readonly relationship: GuardianRelation | null;
}

/**
 * Permissions that only somebody acting **for the school** holds.
 *
 * This is the test for school-wide capacity, and it is separate from the test for what the
 * caller may *do* for a reason worth spelling out: `payment.record_manual_claim` is held by
 * a Bursar **and by a Parent**, because a parent submitting a bank slip is recording a
 * claim too. Using that permission alone to mean "staff" would make every parent staff,
 * and a parent who is staff can act for any student in the school — the exact boundary
 * this module exists to hold.
 *
 * So school-wide capacity is decided by a permission no family role holds:
 * `payment.read` or `charge.read`, both of which are school-wide financial visibility.
 * A caller must clear this *and* hold the permission for the action itself.
 */
function actsForSchool(principal: Principal): boolean {
  return holdsAny(principal, [PermissionKey.PAYMENT_READ, PermissionKey.CHARGE_READ]);
}

/** The permission the action itself needs, for somebody acting for the school. */
function staffPermissionFor(intent: FinancialIntent): readonly PermissionKey[] {
  return intent === 'VIEW'
    ? [PermissionKey.PAYMENT_READ, PermissionKey.CHARGE_READ]
    : [PermissionKey.PAYMENT_INITIATE, PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM];
}

/** The self-service permission that admits a caller for each intent. */
function selfServicePermissionFor(intent: FinancialIntent): PermissionKey {
  return intent === 'VIEW' ? PermissionKey.OWN_FINANCIALS_READ : PermissionKey.OWN_PAYMENT_INITIATE;
}

function holdsAny(principal: Principal, permissions: readonly PermissionKey[]): boolean {
  return permissions.some((permission) => principal.permissions.has(permission));
}

/**
 * The same refusal for "no such student", "another school's student" and "not your
 * child". Deliberately indistinguishable from outside; distinguished in the log.
 */
function refuse(args: {
  principal: Principal;
  studentId: string;
  intent: FinancialIntent;
  violation: string;
}): never {
  log.warn(
    {
      userId: args.principal.userId,
      studentId: args.studentId,
      intent: args.intent,
      violation: args.violation,
    },
    'Refused access to a student’s payment records',
  );
  throw new NotFoundError('The requested student was not found.', {
    logContext: { violation: args.violation, intent: args.intent },
  });
}

/**
 * Decide whether the caller may act on this student, and in what capacity.
 *
 * Staff are checked against the tenant scope; a guardian is additionally checked against
 * their own link and the specific right that link grants. A guardian who may view but not
 * pay is a configured, supported state — `canInitiatePayments` is a separate flag from
 * `canViewFinancials` precisely so a school can let a relative watch a balance without
 * letting them move money.
 */
export async function resolveStudentFinancialAccess(
  principal: Principal,
  studentId: string,
  intent: FinancialIntent,
): Promise<StudentFinancialAccess> {
  if (actsForSchool(principal) && holdsAny(principal, staffPermissionFor(intent))) {
    // Staff: the tenant scope is the whole of the authorisation, and it is checked by
    // reading the student through the scoped query rather than by comparing ids after.
    const student = await feeRepository.findStudentIdentity(principal.scope, studentId);
    if (student === null) {
      refuse({ principal, studentId, intent, violation: 'missing_or_out_of_scope' });
    }

    return {
      kind: 'STAFF',
      studentId: student.id,
      schoolId: student.schoolId,
      studentNumber: student.studentId,
      studentName: `${student.firstName} ${student.lastName}`,
      relationship: null,
    };
  }

  if (!principal.permissions.has(selfServicePermissionFor(intent))) {
    // No route in at all. This one is a genuine 403: the caller is asking to do
    // something their role does not include, which discloses nothing about the student.
    throw new ForbiddenError(
      intent === 'VIEW'
        ? 'You do not have permission to view payment records.'
        : 'You do not have permission to start a payment.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      { logContext: { userId: principal.userId, intent } },
    );
  }

  const link = await paymentRepository.findGuardianFinancialLink({
    userId: principal.userId,
    studentId,
  });

  if (link === null) {
    refuse({ principal, studentId, intent, violation: 'no_guardian_link' });
  }

  // The link exists but the school withheld this right. Still a 404: confirming that the
  // student exists and is theirs, while refusing, is more information than the refusal
  // needs to carry.
  if (intent === 'VIEW' && !link.canViewFinancials) {
    refuse({ principal, studentId, intent, violation: 'link_cannot_view_financials' });
  }
  if (intent === 'INITIATE' && !link.canInitiatePayments) {
    refuse({ principal, studentId, intent, violation: 'link_cannot_initiate_payments' });
  }

  // A guardian link is school-scoped in its own right, but the scope is re-checked so a
  // link that somehow spans tenants cannot be the way across.
  if (!principal.scope.permits({ schoolId: link.schoolId })) {
    refuse({ principal, studentId, intent, violation: 'link_out_of_scope' });
  }

  return {
    kind: 'SELF_SERVICE',
    studentId: link.studentId,
    schoolId: link.schoolId,
    studentNumber: link.studentNumber,
    studentName: `${link.studentFirstName} ${link.studentLastName}`,
    relationship: link.relationship as GuardianRelation,
  };
}

/**
 * The students the caller may see payments for, or null when they may see all of them.
 *
 * Null means "do not filter": a bursar's payments list is the school's. A guardian gets
 * the explicit set of their linked students, which is what scopes a list endpoint without
 * relying on a client-supplied `studentId` the way a filter would.
 *
 * An empty array is a real answer and must not be confused with null — it is a signed-in
 * parent with no linked students, whose payments list is correctly empty.
 */
export async function resolveVisibleStudentIds(
  principal: Principal,
): Promise<readonly string[] | null> {
  if (actsForSchool(principal)) return null;

  if (!principal.permissions.has(PermissionKey.OWN_FINANCIALS_READ)) {
    throw new ForbiddenError(
      'You do not have permission to view payment records.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      { logContext: { userId: principal.userId } },
    );
  }

  const links = await paymentRepository.listGuardianFinancialLinks(
    principal.scope,
    principal.userId,
  );
  return links.filter((link) => link.canViewFinancials).map((link) => link.studentId);
}

/**
 * Whether the caller is acting as staff for reads.
 *
 * Used to decide how much of a payment to expose: a bursar sees the internal transaction
 * references and the provider metadata they need to reconcile; a parent sees their own
 * payment and its status, and nothing about the school's plumbing (Section 22).
 */
export function isStaffReader(principal: Principal): boolean {
  return actsForSchool(principal);
}
