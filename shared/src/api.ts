/**
 * The API contract shared by the backend and the web client.
 *
 * Both sides import these types, so a response shape cannot drift between the server
 * that produces it and the screen that renders it without a compile error.
 */

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
