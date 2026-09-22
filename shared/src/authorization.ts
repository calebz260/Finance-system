/**
 * The role and permission catalogue.
 *
 * This is the single source of truth for who may do what (Section 6). The seed derives
 * the database rows from it, the backend checks permissions by these keys, and the web
 * client uses them only to decide what to render — never to decide what is allowed.
 *
 * Adding a permission here does not grant it. It has to be added to a role's list as
 * well, which keeps the grant explicit and reviewable in a diff.
 */

/* ---------------------------------------------------------------------- permissions */

export const PermissionKey = {
  // School configuration
  SCHOOL_READ: 'school.read',
  SCHOOL_UPDATE: 'school.update',
  SCHOOL_MANAGE_SETTINGS: 'school.manage_settings',

  // User and access administration
  USER_READ: 'user.read',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DEACTIVATE: 'user.deactivate',
  USER_ASSIGN_ROLE: 'user.assign_role',
  ROLE_READ: 'role.read',
  ROLE_MANAGE: 'role.manage',

  // Academic structure
  ACADEMIC_READ: 'academic.read',
  ACADEMIC_MANAGE: 'academic.manage',

  // Students and guardians
  STUDENT_READ: 'student.read',
  STUDENT_CREATE: 'student.create',
  STUDENT_UPDATE: 'student.update',
  STUDENT_ARCHIVE: 'student.archive',
  STUDENT_IMPORT: 'student.import',
  GUARDIAN_READ: 'guardian.read',
  GUARDIAN_CREATE: 'guardian.create',
  GUARDIAN_UPDATE: 'guardian.update',
  GUARDIAN_LINK: 'guardian.link',

  // Fees and charges
  FEE_STRUCTURE_READ: 'fee_structure.read',
  FEE_STRUCTURE_MANAGE: 'fee_structure.manage',
  CHARGE_READ: 'charge.read',
  CHARGE_CREATE: 'charge.create',
  CHARGE_VOID: 'charge.void',

  // Adjustments: discounts, scholarships, waivers
  ADJUSTMENT_READ: 'adjustment.read',
  ADJUSTMENT_REQUEST: 'adjustment.request',
  ADJUSTMENT_APPROVE: 'adjustment.approve',

  // Payments
  PAYMENT_READ: 'payment.read',
  PAYMENT_INITIATE: 'payment.initiate',
  PAYMENT_RECORD_MANUAL_CLAIM: 'payment.record_manual_claim',
  PAYMENT_VERIFY_MANUAL: 'payment.verify_manual',
  PAYMENT_REVERSE: 'payment.reverse',
  PAYMENT_REFUND: 'payment.refund',

  // Reconciliation
  RECONCILIATION_READ: 'reconciliation.read',
  RECONCILIATION_PERFORM: 'reconciliation.perform',
  RECONCILIATION_IMPORT_STATEMENT: 'reconciliation.import_statement',

  // Receipts
  RECEIPT_READ: 'receipt.read',
  RECEIPT_REGENERATE: 'receipt.regenerate',

  // Reporting
  REPORT_READ_FINANCIAL: 'report.read_financial',
  REPORT_READ_OPERATIONAL: 'report.read_operational',
  REPORT_EXPORT: 'report.export',

  // Clearance and lifecycle
  CLEARANCE_READ: 'clearance.read',
  CLEARANCE_GRANT: 'clearance.grant',
  CLEARANCE_REVOKE: 'clearance.revoke',
  PROMOTION_EXECUTE: 'promotion.execute',

  // Audit
  AUDIT_LOG_READ: 'audit_log.read',

  // Self-service, scoped to the caller's own records. Holding one of these is not enough
  // on its own: the backend still checks the student is linked to the caller.
  OWN_FINANCIALS_READ: 'own.financials_read',
  OWN_PAYMENT_INITIATE: 'own.payment_initiate',
  OWN_RECEIPT_READ: 'own.receipt_read',
  OWN_CLEARANCE_READ: 'own.clearance_read',
} as const;

export type PermissionKey = (typeof PermissionKey)[keyof typeof PermissionKey];

export interface PermissionDefinition {
  readonly key: PermissionKey;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  /**
   * Sensitive permissions move money or alter financial history. They are highlighted in
   * audit reports and may require a second authorisation.
   */
  readonly isSensitive: boolean;
}

function definePermission(
  key: PermissionKey,
  description: string,
  isSensitive = false,
): PermissionDefinition {
  const [resource, action] = key.split('.') as [string, string];
  return { key, resource, action, description, isSensitive };
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  definePermission(PermissionKey.SCHOOL_READ, 'View school details'),
  definePermission(PermissionKey.SCHOOL_UPDATE, 'Change school details'),
  definePermission(
    PermissionKey.SCHOOL_MANAGE_SETTINGS,
    'Change school policy: payment rules, proration, retention',
    true,
  ),

  definePermission(PermissionKey.USER_READ, 'View user accounts'),
  definePermission(PermissionKey.USER_CREATE, 'Create user accounts'),
  definePermission(PermissionKey.USER_UPDATE, 'Change user accounts'),
  definePermission(PermissionKey.USER_DEACTIVATE, 'Deactivate a user account', true),
  definePermission(PermissionKey.USER_ASSIGN_ROLE, 'Grant or remove roles', true),
  definePermission(PermissionKey.ROLE_READ, 'View roles and their permissions'),
  definePermission(PermissionKey.ROLE_MANAGE, 'Change what a role may do', true),

  definePermission(PermissionKey.ACADEMIC_READ, 'View academic years, terms, levels, classes'),
  definePermission(
    PermissionKey.ACADEMIC_MANAGE,
    'Configure academic years, terms, levels, classes, programmes',
  ),

  definePermission(PermissionKey.STUDENT_READ, 'View student records'),
  definePermission(PermissionKey.STUDENT_CREATE, 'Register a student'),
  definePermission(PermissionKey.STUDENT_UPDATE, 'Change a student record'),
  definePermission(PermissionKey.STUDENT_ARCHIVE, 'Archive a former student'),
  definePermission(PermissionKey.STUDENT_IMPORT, 'Bulk import students and guardians', true),
  definePermission(PermissionKey.GUARDIAN_READ, 'View guardian records'),
  definePermission(PermissionKey.GUARDIAN_CREATE, 'Add a guardian'),
  definePermission(PermissionKey.GUARDIAN_UPDATE, 'Change a guardian record'),
  definePermission(PermissionKey.GUARDIAN_LINK, 'Link a guardian to a student'),

  definePermission(PermissionKey.FEE_STRUCTURE_READ, 'View fee structures'),
  definePermission(
    PermissionKey.FEE_STRUCTURE_MANAGE,
    'Create and change fee structures for a term',
    true,
  ),
  definePermission(PermissionKey.CHARGE_READ, 'View student charges'),
  definePermission(PermissionKey.CHARGE_CREATE, 'Raise a charge against a student', true),
  definePermission(PermissionKey.CHARGE_VOID, 'Void a charge raised in error', true),

  definePermission(PermissionKey.ADJUSTMENT_READ, 'View discounts, scholarships and waivers'),
  definePermission(PermissionKey.ADJUSTMENT_REQUEST, 'Request a discount, scholarship or waiver'),
  definePermission(
    PermissionKey.ADJUSTMENT_APPROVE,
    'Approve a discount, scholarship or waiver',
    true,
  ),

  definePermission(PermissionKey.PAYMENT_READ, 'View payments'),
  definePermission(PermissionKey.PAYMENT_INITIATE, 'Start a payment on behalf of a student'),
  definePermission(
    PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
    'Record a bank slip, cash or transfer payment claim',
  ),
  definePermission(
    PermissionKey.PAYMENT_VERIFY_MANUAL,
    'Verify a manual payment claim against a statement, crediting the ledger',
    true,
  ),
  definePermission(PermissionKey.PAYMENT_REVERSE, 'Reverse a verified payment', true),
  definePermission(PermissionKey.PAYMENT_REFUND, 'Refund a payment', true),

  definePermission(PermissionKey.RECONCILIATION_READ, 'View reconciliation status'),
  definePermission(PermissionKey.RECONCILIATION_PERFORM, 'Match and resolve payments', true),
  definePermission(
    PermissionKey.RECONCILIATION_IMPORT_STATEMENT,
    'Import a bank or remittance statement',
    true,
  ),

  definePermission(PermissionKey.RECEIPT_READ, 'View and download receipts'),
  definePermission(PermissionKey.RECEIPT_REGENERATE, 'Reissue a receipt', true),

  definePermission(PermissionKey.REPORT_READ_FINANCIAL, 'View financial reports'),
  definePermission(PermissionKey.REPORT_READ_OPERATIONAL, 'View enrolment and operational reports'),
  definePermission(PermissionKey.REPORT_EXPORT, 'Export report data', true),

  definePermission(PermissionKey.CLEARANCE_READ, 'View financial clearance status'),
  definePermission(PermissionKey.CLEARANCE_GRANT, 'Grant financial clearance', true),
  definePermission(PermissionKey.CLEARANCE_REVOKE, 'Revoke financial clearance', true),
  definePermission(PermissionKey.PROMOTION_EXECUTE, 'Run end-of-year promotion', true),

  definePermission(PermissionKey.AUDIT_LOG_READ, 'Read the audit log'),

  definePermission(PermissionKey.OWN_FINANCIALS_READ, 'View own or linked student financials'),
  definePermission(PermissionKey.OWN_PAYMENT_INITIATE, 'Pay for own or linked student'),
  definePermission(PermissionKey.OWN_RECEIPT_READ, 'View own or linked student receipts'),
  definePermission(PermissionKey.OWN_CLEARANCE_READ, 'View own or linked clearance status'),
];

/* --------------------------------------------------------------------------- roles */

export const RoleKey = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  SCHOOL_ADMIN: 'SCHOOL_ADMIN',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  BURSAR: 'BURSAR',
  DOS: 'DOS',
  PARENT: 'PARENT',
  STUDENT: 'STUDENT',
} as const;

export type RoleKey = (typeof RoleKey)[keyof typeof RoleKey];

export interface RoleDefinition {
  readonly key: RoleKey;
  readonly name: string;
  readonly description: string;
  /** Higher is more privileged. Stops a user granting a role above their own. */
  readonly rank: number;
  /** Financially sensitive roles must complete a TOTP challenge (Section 6). */
  readonly requiresMfa: boolean;
  readonly permissions: readonly PermissionKey[];
}

const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.map((permission) => permission.key);

/**
 * The role matrix.
 *
 * Two deliberate separations, both from Section 6:
 *
 *  - A Bursar records and verifies payments but cannot **approve** adjustments, reverse a
 *    payment or issue a refund. Those need a Finance Manager, so the person handling daily
 *    cash is not the same person who can write off what is owed.
 *  - A DOS sees student and clearance information but no payment or adjustment operations.
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: RoleKey.SUPER_ADMIN,
    name: 'Super Administrator',
    description: 'System-wide technical administration across schools. Not scoped to one school.',
    rank: 100,
    requiresMfa: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: RoleKey.SCHOOL_ADMIN,
    name: 'School Administrator',
    description: 'Configures the school, its academic structure, users and fee configuration.',
    rank: 80,
    requiresMfa: true,
    permissions: [
      PermissionKey.SCHOOL_READ,
      PermissionKey.SCHOOL_UPDATE,
      PermissionKey.SCHOOL_MANAGE_SETTINGS,
      PermissionKey.USER_READ,
      PermissionKey.USER_CREATE,
      PermissionKey.USER_UPDATE,
      PermissionKey.USER_DEACTIVATE,
      PermissionKey.USER_ASSIGN_ROLE,
      PermissionKey.ROLE_READ,
      PermissionKey.ACADEMIC_READ,
      PermissionKey.ACADEMIC_MANAGE,
      PermissionKey.STUDENT_READ,
      PermissionKey.STUDENT_CREATE,
      PermissionKey.STUDENT_UPDATE,
      PermissionKey.STUDENT_ARCHIVE,
      PermissionKey.STUDENT_IMPORT,
      PermissionKey.GUARDIAN_READ,
      PermissionKey.GUARDIAN_CREATE,
      PermissionKey.GUARDIAN_UPDATE,
      PermissionKey.GUARDIAN_LINK,
      PermissionKey.FEE_STRUCTURE_READ,
      PermissionKey.FEE_STRUCTURE_MANAGE,
      PermissionKey.CHARGE_READ,
      PermissionKey.ADJUSTMENT_READ,
      PermissionKey.PAYMENT_READ,
      PermissionKey.RECEIPT_READ,
      PermissionKey.RECONCILIATION_READ,
      PermissionKey.REPORT_READ_FINANCIAL,
      PermissionKey.REPORT_READ_OPERATIONAL,
      PermissionKey.REPORT_EXPORT,
      PermissionKey.CLEARANCE_READ,
      PermissionKey.PROMOTION_EXECUTE,
      PermissionKey.AUDIT_LOG_READ,
    ],
  },
  {
    key: RoleKey.FINANCE_MANAGER,
    name: 'Finance Manager',
    description:
      'Financial oversight and the approvals a bursar may not self-authorise: adjustments, reversals and refunds.',
    rank: 70,
    requiresMfa: true,
    permissions: [
      PermissionKey.SCHOOL_READ,
      PermissionKey.ACADEMIC_READ,
      PermissionKey.STUDENT_READ,
      PermissionKey.GUARDIAN_READ,
      PermissionKey.FEE_STRUCTURE_READ,
      PermissionKey.FEE_STRUCTURE_MANAGE,
      PermissionKey.CHARGE_READ,
      PermissionKey.CHARGE_CREATE,
      PermissionKey.CHARGE_VOID,
      PermissionKey.ADJUSTMENT_READ,
      PermissionKey.ADJUSTMENT_REQUEST,
      PermissionKey.ADJUSTMENT_APPROVE,
      PermissionKey.PAYMENT_READ,
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
      PermissionKey.PAYMENT_VERIFY_MANUAL,
      PermissionKey.PAYMENT_REVERSE,
      PermissionKey.PAYMENT_REFUND,
      PermissionKey.RECONCILIATION_READ,
      PermissionKey.RECONCILIATION_PERFORM,
      PermissionKey.RECONCILIATION_IMPORT_STATEMENT,
      PermissionKey.RECEIPT_READ,
      PermissionKey.RECEIPT_REGENERATE,
      PermissionKey.REPORT_READ_FINANCIAL,
      PermissionKey.REPORT_READ_OPERATIONAL,
      PermissionKey.REPORT_EXPORT,
      PermissionKey.CLEARANCE_READ,
      PermissionKey.CLEARANCE_GRANT,
      PermissionKey.CLEARANCE_REVOKE,
      PermissionKey.AUDIT_LOG_READ,
    ],
  },
  {
    key: RoleKey.BURSAR,
    name: 'Bursar / Finance Officer',
    description:
      'Day-to-day fee collection: records payments, verifies manual claims against statements, issues receipts and reconciles.',
    rank: 60,
    requiresMfa: true,
    permissions: [
      PermissionKey.SCHOOL_READ,
      PermissionKey.ACADEMIC_READ,
      PermissionKey.STUDENT_READ,
      PermissionKey.GUARDIAN_READ,
      PermissionKey.FEE_STRUCTURE_READ,
      PermissionKey.CHARGE_READ,
      PermissionKey.CHARGE_CREATE,
      PermissionKey.ADJUSTMENT_READ,
      PermissionKey.ADJUSTMENT_REQUEST,
      PermissionKey.PAYMENT_READ,
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
      PermissionKey.PAYMENT_VERIFY_MANUAL,
      PermissionKey.RECONCILIATION_READ,
      PermissionKey.RECONCILIATION_PERFORM,
      PermissionKey.RECONCILIATION_IMPORT_STATEMENT,
      PermissionKey.RECEIPT_READ,
      PermissionKey.REPORT_READ_FINANCIAL,
      PermissionKey.REPORT_READ_OPERATIONAL,
      PermissionKey.REPORT_EXPORT,
      PermissionKey.CLEARANCE_READ,
    ],
  },
  {
    key: RoleKey.DOS,
    name: 'Director of Studies',
    description:
      'Academic staff access to student records and clearance status. No payment or adjustment operations.',
    rank: 50,
    requiresMfa: false,
    permissions: [
      PermissionKey.SCHOOL_READ,
      PermissionKey.ACADEMIC_READ,
      PermissionKey.ACADEMIC_MANAGE,
      PermissionKey.STUDENT_READ,
      PermissionKey.STUDENT_CREATE,
      PermissionKey.STUDENT_UPDATE,
      PermissionKey.GUARDIAN_READ,
      PermissionKey.GUARDIAN_LINK,
      PermissionKey.CLEARANCE_READ,
      PermissionKey.REPORT_READ_OPERATIONAL,
      PermissionKey.PROMOTION_EXECUTE,
    ],
  },
  {
    key: RoleKey.PARENT,
    name: 'Parent / Guardian',
    description:
      'Views fees, balances, payment history and receipts for linked students, and initiates payments.',
    rank: 10,
    requiresMfa: false,
    permissions: [
      PermissionKey.OWN_FINANCIALS_READ,
      PermissionKey.OWN_PAYMENT_INITIATE,
      PermissionKey.OWN_RECEIPT_READ,
      PermissionKey.OWN_CLEARANCE_READ,
      // A parent submitting a bank slip is recording a claim, so they hold the same
      // permission a bursar does for it.
      //
      // **This permission is therefore not a test for staff.** Anything deciding whether a
      // caller acts for the school rather than for their own family must key on a
      // permission no family role holds — `payment.read` or `charge.read` — as
      // `payment.access.ts` does. Treating `payment.record_manual_claim` as a staff marker
      // would make every parent staff, and a parent who is staff can act for any student in
      // the school.
      PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
    ],
  },
  {
    key: RoleKey.STUDENT,
    name: 'Student',
    description: 'Views their own fee information, balance, payment history and clearance status.',
    rank: 5,
    requiresMfa: false,
    permissions: [
      PermissionKey.OWN_FINANCIALS_READ,
      PermissionKey.OWN_RECEIPT_READ,
      PermissionKey.OWN_CLEARANCE_READ,
    ],
  },
];

const ROLES_BY_KEY: Readonly<Record<RoleKey, RoleDefinition>> = Object.freeze(
  Object.fromEntries(ROLE_DEFINITIONS.map((role) => [role.key, role])) as Record<
    RoleKey,
    RoleDefinition
  >,
);

export function getRoleDefinition(key: RoleKey): RoleDefinition {
  const role = ROLES_BY_KEY[key];
  if (role === undefined) throw new Error(`Unknown role key: ${key}`);
  return role;
}

/** Roles that must complete a TOTP challenge to sign in. */
export const MFA_REQUIRED_ROLE_KEYS: readonly RoleKey[] = ROLE_DEFINITIONS.filter(
  (role) => role.requiresMfa,
).map((role) => role.key);

/** True when any of the caller's roles requires MFA. */
export function rolesRequireMfa(roleKeys: readonly RoleKey[]): boolean {
  return roleKeys.some((key) => ROLES_BY_KEY[key]?.requiresMfa === true);
}

/** The union of permissions granted by the given roles. */
export function permissionsForRoles(roleKeys: readonly RoleKey[]): Set<PermissionKey> {
  const granted = new Set<PermissionKey>();
  for (const key of roleKeys) {
    for (const permission of ROLES_BY_KEY[key]?.permissions ?? []) {
      granted.add(permission);
    }
  }
  return granted;
}
