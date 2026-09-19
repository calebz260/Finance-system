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

  // --- account administration
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  USER_UNLOCKED: 'user.unlocked',
  USER_ROLE_GRANTED: 'user.role.granted',
  USER_ROLE_REVOKED: 'user.role.revoked',
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
} as const;

export type AuditEntity = (typeof AuditEntity)[keyof typeof AuditEntity];
