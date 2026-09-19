/**
 * The API contract shared by the backend and the web client.
 *
 * Both sides import these types, so a response shape cannot drift between the server
 * that produces it and the screen that renders it without a compile error.
 */
import type { PermissionKey, RoleKey } from './authorization.js';

/** Machine-readable error codes. The frontend branches on these, never on message text. */
export const ErrorCode = {
  // Validation & request shape
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // Authentication & authorisation
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  SCHOOL_SCOPE_VIOLATION: 'SCHOOL_SCOPE_VIOLATION',

  // Resources & state
  NOT_FOUND: 'NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  /** Optimistic-locking failure: reload the record and retry (Section 13). */
  RECORD_MODIFIED: 'RECORD_MODIFIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',

  // Financial domain
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_EXCEEDS_BALANCE: 'AMOUNT_EXCEEDS_BALANCE',
  AMOUNT_BELOW_MINIMUM: 'AMOUNT_BELOW_MINIMUM',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  PAYMENT_NOT_VERIFIED: 'PAYMENT_NOT_VERIFIED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  AUTHORISATION_REQUIRED: 'AUTHORISATION_REQUIRED',
  PERIOD_CLOSED: 'PERIOD_CLOSED',

  // Infrastructure
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** One field-level validation problem, addressed by a dotted path into the request. */
export interface FieldError {
  /** e.g. `body.amount`, `query.page`, `params.studentId` */
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface ApiErrorBody {
  readonly code: ErrorCode;
  /** Safe for display. Never contains SQL, stack traces or secrets. */
  readonly message: string;
  readonly fieldErrors?: readonly FieldError[];
  /** Extra machine-readable context, e.g. `{ minimumAmount: "1000.00" }`. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Correlates the response with server logs and audit entries. */
  readonly requestId: string;
  /** ISO-8601 UTC. */
  readonly timestamp: string;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}

export interface ApiSuccessResponse<TData> {
  readonly data: TData;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorResponse).error === 'object'
  );
}

/* ------------------------------------------------------------------ pagination */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

export interface PaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface PaginatedResponse<TItem> {
  readonly data: readonly TItem[];
  readonly meta: PaginationMeta;
}

export function buildPaginationMeta(args: {
  page: number;
  pageSize: number;
  totalItems: number;
}): PaginationMeta {
  const { page, pageSize, totalItems } = args;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 1;
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export type SortDirection = 'asc' | 'desc';

/* --------------------------------------------------------------- authentication */

/**
 * The caller's identity and the grants in force for this request.
 *
 * `permissions` is sent so the web client can decide what to render. It is never an
 * authorisation input: the backend re-reads permissions from the database on every
 * request and decides there (Section 26).
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Null only for a Super Administrator, whose access is not scoped to one school. */
  readonly schoolId: string | null;
  readonly isSystemAdministrator: boolean;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  /** Whether the current session completed an MFA challenge. */
  readonly mfaSatisfied: boolean;
  readonly roleKeys: readonly RoleKey[];
  readonly permissions: readonly PermissionKey[];
}

/**
 * An established session.
 *
 * Carries the access token only. The refresh token is set as an httpOnly cookie scoped
 * to the auth routes, so it is never readable by JavaScript and is not attached to
 * ordinary API calls.
 */
export interface SessionPayload {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly user: AuthenticatedUser;
}

/**
 * What `POST /auth/login` returns. A correct password is not necessarily a session:
 * for a role that requires MFA it is the first of two steps, which is why this is a
 * discriminated union rather than an optional-field shape.
 */
export type LoginResult =
  | ({ readonly status: 'authenticated' } & SessionPayload)
  | {
      readonly status: 'mfa_required';
      /** Present this with a code at `POST /auth/mfa/verify`. Not an access token. */
      readonly challengeToken: string;
      readonly expiresInSeconds: number;
    }
  | {
      readonly status: 'mfa_enrolment_required';
      /** The role held requires MFA and the account has not enrolled yet. */
      readonly enrolmentToken: string;
      readonly expiresInSeconds: number;
    };

/** The details an authenticator app needs, returned once when enrolment starts. */
export interface MfaEnrolmentStartPayload {
  /** Base32, for manual entry when a QR code cannot be scanned. */
  readonly secret: string;
  /** `otpauth://` URI, usually rendered as a QR code. Contains the secret. */
  readonly otpauthUri: string;
}

/**
 * The result of confirming enrolment. Recovery codes are shown once and never
 * retrievable again -- only their hashes are stored.
 */
export interface MfaEnrolmentCompletedPayload {
  readonly recoveryCodes: readonly string[];
  /** Present when enrolment completed a sign-in, so a session now exists. */
  readonly session?: SessionPayload;
  /**
   * True when enrolling ended the caller's existing sessions, because a session that
   * never satisfied MFA cannot be upgraded in place.
   */
  readonly reauthenticationRequired: boolean;
}

export interface RecoveryCodesPayload {
  readonly recoveryCodes: readonly string[];
}

/* ------------------------------------------------------- user administration */

/**
 * Account lifecycle, mirroring the `user_status` enum in the database.
 *
 * Restated here rather than imported because `shared` must not depend on the generated
 * Prisma client. Drift is caught at compile time: the backend assigns the database enum
 * into this union when projecting a row, so adding a value on one side and not the other
 * fails the build.
 */
export type UserAccountStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED' | 'DISABLED';

export interface UserRoleAssignment {
  readonly roleKey: RoleKey;
  readonly roleName: string;
  readonly rank: number;
  readonly requiresMfa: boolean;
  /** ISO-8601 UTC. */
  readonly assignedAt: string;
}

/**
 * A user account as an administration screen sees it.
 *
 * Contains no credential material: no password hash, no MFA secret, no tokens. What it
 * does carry is the security state an administrator needs in order to act — whether the
 * account is locked, whether MFA is enrolled, when it was last used.
 */
export interface UserAccount {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  /** Null only for a Super Administrator. */
  readonly schoolId: string | null;
  readonly status: UserAccountStatus;
  readonly isSystemAdministrator: boolean;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  /** ISO-8601 UTC, or null when MFA has never been enrolled. */
  readonly mfaEnrolledAt: string | null;
  /** True while a brute-force lockout is in force. Derived from `lockedUntil`. */
  readonly locked: boolean;
  /** ISO-8601 UTC. */
  readonly lockedUntil: string | null;
  readonly failedLoginAttempts: number;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Pass back on an update; a stale value is rejected with `RECORD_MODIFIED`. */
  readonly version: number;
  readonly roles: readonly UserRoleAssignment[];
}

/**
 * The result of creating an account.
 *
 * `temporaryPassword` is present only when the server generated one, and only in this
 * one response — it is never stored in plaintext and never retrievable again. Until a
 * notification channel exists (Phase 6), handing it to the administrator who created the
 * account is how it reaches its owner.
 */
export interface CreatedUserAccount {
  readonly user: UserAccount;
  readonly temporaryPassword?: string;
}

/** A role and what it may do, for the administration screens. */
export interface RoleCatalogueEntry {
  readonly key: RoleKey;
  readonly name: string;
  readonly description: string | null;
  readonly rank: number;
  readonly requiresMfa: boolean;
  readonly permissions: readonly PermissionKey[];
}

/** One of the caller's live sessions, for a "where am I signed in?" screen. */
export interface SessionSummary {
  readonly id: string;
  /** True for the session making this request. */
  readonly current: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly mfaSatisfied: boolean;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

/* ----------------------------------------------------------------- health check */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface DependencyHealth {
  readonly name: string;
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  /** Diagnostic summary only -- never includes connection strings or credentials. */
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  /** ISO-8601 UTC. */
  readonly timestamp: string;
  readonly uptimeSeconds: number;
  readonly dependencies: readonly DependencyHealth[];
}
