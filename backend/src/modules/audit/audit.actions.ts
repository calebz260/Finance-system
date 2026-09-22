/**
 * The catalogue of audited actions (Section 27).
 *
 * Kept as constants rather than free-form strings so that an action name cannot drift
 * between the code that writes it and the report that queries it, and so the full set of
 * auditable events is reviewable in one place.
 *
 * Naming: `<entity>.<event>`, past tense, dotted. Reports group on the prefix.
 */
export const AuditAction = {
  // --- authentication
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_BLOCKED_LOCKED: 'auth.login.blocked_locked',
  LOGIN_BLOCKED_INACTIVE: 'auth.login.blocked_inactive',
  ACCOUNT_LOCKED: 'auth.account.locked',
  LOGOUT: 'auth.logout',
  LOGOUT_ALL: 'auth.logout_all',
  TOKEN_REFRESHED: 'auth.token.refreshed',
  /** A refresh token was presented twice: either replay or theft. Always investigated. */
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',

  // --- multi-factor authentication
  /** A password was accepted and a second factor was demanded. */
  MFA_CHALLENGE_ISSUED: 'auth.mfa.challenge_issued',
  MFA_ENROLMENT_STARTED: 'auth.mfa.enrolment_started',
  MFA_ENROLLED: 'auth.mfa.enrolled',
  MFA_VERIFIED: 'auth.mfa.verified',
  MFA_FAILED: 'auth.mfa.failed',
  MFA_DISABLED: 'auth.mfa.disabled',
  MFA_RECOVERY_CODE_USED: 'auth.mfa.recovery_code_used',
  MFA_RECOVERY_CODES_REGENERATED: 'auth.mfa.recovery_codes_regenerated',

  // --- passwords
  PASSWORD_CHANGED: 'auth.password.changed',
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  PASSWORD_RESET_FAILED: 'auth.password.reset_failed',

  // --- authorisation
  ACCESS_DENIED: 'auth.access_denied',

  // --- academic structure (Phase 3)
  ACADEMIC_YEAR_CREATED: 'academic.year.created',
  ACADEMIC_YEAR_UPDATED: 'academic.year.updated',
  ACADEMIC_YEAR_SET_CURRENT: 'academic.year.set_current',
  TERM_CREATED: 'academic.term.created',
  TERM_UPDATED: 'academic.term.updated',
  TERM_SET_CURRENT: 'academic.term.set_current',
  DEPARTMENT_CREATED: 'academic.department.created',
  PROGRAM_CREATED: 'academic.program.created',
  PROGRAM_UPDATED: 'academic.program.updated',
  LEVEL_CREATED: 'academic.level.created',
  LEVEL_UPDATED: 'academic.level.updated',
  CLASS_SECTION_CREATED: 'academic.class_section.created',
  CLASS_SECTION_UPDATED: 'academic.class_section.updated',

  // --- students and guardians (Phase 3)
  STUDENT_REGISTERED: 'student.registered',
  STUDENT_UPDATED: 'student.updated',
  STUDENT_STATUS_CHANGED: 'student.status_changed',
  STUDENT_IMPORTED: 'student.imported',
  GUARDIAN_CREATED: 'guardian.created',
  GUARDIAN_UPDATED: 'guardian.updated',
  GUARDIAN_LINKED: 'guardian.linked',
  GUARDIAN_UNLINKED: 'guardian.unlinked',
  GUARDIAN_LINK_UPDATED: 'guardian.link_updated',

  // --- enrolment (Phase 3)
  ENROLLMENT_CREATED: 'enrollment.created',
  ENROLLMENT_UPDATED: 'enrollment.updated',
  ENROLLMENT_ENDED: 'enrollment.ended',

  // --- account administration
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  USER_UNLOCKED: 'user.unlocked',
  USER_ROLE_GRANTED: 'user.role.granted',
  USER_ROLE_REVOKED: 'user.role.revoked',

  // --- fee configuration (Phase 4)
  FEE_CATEGORY_CREATED: 'fee.category.created',
  FEE_CATEGORY_UPDATED: 'fee.category.updated',
  FEE_STRUCTURE_CREATED: 'fee.structure.created',
  FEE_STRUCTURE_UPDATED: 'fee.structure.updated',
  FEE_STRUCTURE_ACTIVATED: 'fee.structure.activated',
  FEE_STRUCTURE_ARCHIVED: 'fee.structure.archived',
  FEE_STRUCTURE_ITEM_ADDED: 'fee.structure.item_added',
  FEE_STRUCTURE_ITEM_UPDATED: 'fee.structure.item_updated',
  FEE_STRUCTURE_ITEM_REMOVED: 'fee.structure.item_removed',

  // --- charges (Phase 4)
  CHARGE_RAISED: 'charge.raised',
  CHARGE_VOIDED: 'charge.voided',
  CHARGE_RUN_APPLIED: 'charge.run.applied',

  // --- relief: discounts, scholarship awards, waivers, adjustments (Phase 4)
  //
  // One set of actions across the four record types. The entity type says which table
  // it was, and the `kind` in the state payload says it again in words, so a reviewer
  // reading the log alone can tell a waiver from a discount.
  RELIEF_REQUESTED: 'relief.requested',
  RELIEF_APPROVED: 'relief.approved',
  RELIEF_REJECTED: 'relief.rejected',
  RELIEF_CANCELLED: 'relief.cancelled',
  RELIEF_REVERSED: 'relief.reversed',

  SCHOLARSHIP_CREATED: 'scholarship.created',
  SCHOLARSHIP_UPDATED: 'scholarship.updated',

  // --- payments (Phase 5)
  //
  // Every event that changes what the school believes about money arriving. The
  // verification and reversal entries are the ones an auditor reads first, so they carry
  // the before/after amount and the ledger entry id in their state payload.
  PAYMENT_INITIATED: 'payment.initiated',
  /** A retried initiation answered from the existing payment. Recorded, not silent. */
  PAYMENT_INITIATION_REPLAYED: 'payment.initiation.replayed',
  /** The same idempotency key presented for a materially different request. */
  PAYMENT_IDEMPOTENCY_CONFLICT: 'payment.idempotency.conflict',
  PAYMENT_TRANSACTION_CREATED: 'payment.transaction.created',
  PAYMENT_PROVIDER_RESPONDED: 'payment.provider.responded',
  PAYMENT_STATUS_CHANGED: 'payment.status.changed',
  PAYMENT_VERIFIED: 'payment.verified',
  PAYMENT_VERIFICATION_FAILED: 'payment.verification.failed',
  PAYMENT_HELD_FOR_REVIEW: 'payment.held_for_review',
  PAYMENT_CANCELLED: 'payment.cancelled',
  PAYMENT_REVERSED: 'payment.reversed',
  PAYMENT_REFUNDED: 'payment.refunded',

  // --- manual payment claims (Phase 5)
  MANUAL_CLAIM_RECORDED: 'payment.manual_claim.recorded',
  MANUAL_CLAIM_VERIFIED: 'payment.manual_claim.verified',
  MANUAL_CLAIM_REJECTED: 'payment.manual_claim.rejected',
  /** A verification refused because the verifier was the submitter (Section 13B). */
  MANUAL_CLAIM_SELF_VERIFICATION_BLOCKED: 'payment.manual_claim.self_verification_blocked',
  EVIDENCE_UPLOADED: 'payment.evidence.uploaded',
  EVIDENCE_SUPERSEDED: 'payment.evidence.superseded',
  EVIDENCE_DOWNLOADED: 'payment.evidence.downloaded',
  EVIDENCE_REJECTED: 'payment.evidence.rejected',

  // --- provider callbacks (Phase 5)
  //
  // Both outcomes are audited. One bad signature is a misconfiguration; a stream of them
  // is someone forging confirmations, and only the recorded failures make that visible.
  WEBHOOK_RECEIVED: 'payment.webhook.received',
  WEBHOOK_REJECTED: 'payment.webhook.rejected',
  WEBHOOK_DUPLICATE_IGNORED: 'payment.webhook.duplicate_ignored',

  // --- reconciliation (Phase 5)
  //
  // Attribution is audited separately from verification, because they are separate
  // claims: "this line is that payment" and "and therefore credit the account". A
  // reconciliation that credited would show both entries, and one that only matched shows
  // the first — which is what tells a reviewer what a bursar actually decided.
  STATEMENT_IMPORTED: 'reconciliation.statement.imported',
  STATEMENT_LINE_MATCHED: 'reconciliation.line.matched',
  STATEMENT_LINE_UNMATCHED: 'reconciliation.line.unmatched',
  STATEMENT_LINE_IGNORED: 'reconciliation.line.ignored',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Entity names used in the `entityType` column. */
export const AuditEntity = {
  USER: 'User',
  SESSION: 'Session',
  ROLE: 'Role',
  STUDENT: 'Student',
  GUARDIAN: 'Guardian',
  ENROLLMENT: 'Enrollment',
  SCHOOL: 'School',
  ACADEMIC_YEAR: 'AcademicYear',
  TERM: 'Term',
  PROGRAM: 'Program',
  LEVEL: 'Level',
  CLASS_SECTION: 'ClassSection',
  DEPARTMENT: 'Department',
  STUDENT_GUARDIAN: 'StudentGuardian',
  FEE_CATEGORY: 'FeeCategory',
  FEE_STRUCTURE: 'FeeStructure',
  FEE_STRUCTURE_ITEM: 'FeeStructureItem',
  STUDENT_CHARGE: 'StudentCharge',
  CHARGE_RUN: 'ChargeRun',
  DISCOUNT: 'Discount',
  SCHOLARSHIP: 'Scholarship',
  STUDENT_SCHOLARSHIP: 'StudentScholarship',
  FEE_WAIVER: 'FeeWaiver',
  FINANCIAL_ADJUSTMENT: 'FinancialAdjustment',
  FINANCIAL_ENTRY: 'FinancialEntry',
  PAYMENT: 'Payment',
  PAYMENT_TRANSACTION: 'PaymentTransaction',
  PAYMENT_EVIDENCE: 'PaymentEvidence',
  PAYMENT_WEBHOOK_EVENT: 'PaymentWebhookEvent',
  BANK_STATEMENT_IMPORT: 'BankStatementImport',
  BANK_STATEMENT_LINE: 'BankStatementLine',
} as const;

export type AuditEntity = (typeof AuditEntity)[keyof typeof AuditEntity];

/**
 * The entity name for a relief record of a given kind.
 *
 * A function rather than four call sites choosing a constant, so the mapping from the
 * kind a service is holding to the name written into the audit log exists once.
 */
export function reliefEntity(
  kind: 'DISCOUNT' | 'SCHOLARSHIP' | 'WAIVER' | 'ADJUSTMENT',
): AuditEntity {
  switch (kind) {
    case 'DISCOUNT':
      return AuditEntity.DISCOUNT;
    case 'SCHOLARSHIP':
      return AuditEntity.STUDENT_SCHOLARSHIP;
    case 'WAIVER':
      return AuditEntity.FEE_WAIVER;
    case 'ADJUSTMENT':
      return AuditEntity.FINANCIAL_ADJUSTMENT;
  }
}
