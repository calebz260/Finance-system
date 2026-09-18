/**
 * Application error hierarchy.
 *
 * Services throw these; a single error-handling middleware translates them into the
 * shared API error envelope. Two properties matter for safety:
 *
 *  - `code` is a machine-readable `ErrorCode` the web client can branch on.
 *  - `isOperational` distinguishes an expected domain refusal ("balance too low") from
 *    an unexpected fault. Only operational messages are shown to users; everything else
 *    is logged in full and reported as a generic internal error (Section 36).
 */
import { ErrorCode, type FieldError } from '@sfs/shared';

export interface AppErrorOptions {
  readonly fieldErrors?: readonly FieldError[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Extra context for logs only. Never serialised to the client. */
  readonly logContext?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  readonly httpStatus: number;
  readonly code: ErrorCode;
  readonly isOperational: boolean;
  readonly fieldErrors?: readonly FieldError[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly logContext?: Readonly<Record<string, unknown>>;

  constructor(
    httpStatus: number,
    code: ErrorCode,
    message: string,
    options: AppErrorOptions & { isOperational?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.httpStatus = httpStatus;
    this.code = code;
    this.isOperational = options.isOperational ?? true;
    if (options.fieldErrors !== undefined) this.fieldErrors = options.fieldErrors;
    if (options.details !== undefined) this.details = options.details;
    if (options.logContext !== undefined) this.logContext = options.logContext;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 -- the request itself is malformed or fails field validation. */
export class ValidationError extends AppError {
  constructor(message = 'The submitted data is not valid.', options: AppErrorOptions = {}) {
    super(400, ErrorCode.VALIDATION_FAILED, message, options);
  }
}

/** 400 -- a well-formed request that breaks a domain rule. */
export class DomainError extends AppError {
  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(400, code, message, options);
  }
}

/** 401 -- no valid credentials were presented. */
export class UnauthenticatedError extends AppError {
  constructor(
    message = 'Authentication is required to access this resource.',
    code: ErrorCode = ErrorCode.UNAUTHENTICATED,
    options: AppErrorOptions = {},
  ) {
    super(401, code, message, options);
  }
}

/** 403 -- authenticated, but not permitted. Covers cross-school access attempts. */
export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code: ErrorCode = ErrorCode.FORBIDDEN,
    options: AppErrorOptions = {},
  ) {
    super(403, code, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.', options: AppErrorOptions = {}) {
    super(404, ErrorCode.NOT_FOUND, message, options);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state of the resource.',
    code: ErrorCode = ErrorCode.CONFLICT,
    options: AppErrorOptions = {},
  ) {
    super(409, code, message, options);
  }
}

/**
 * 409 -- optimistic locking failure (Section 13). The client should reload and retry;
 * it must never be resolved by blindly re-sending the same write.
 */
export class RecordModifiedError extends ConflictError {
  constructor(
    message = 'This record was changed by someone else while you were editing it. Reload and try again.',
    options: AppErrorOptions = {},
  ) {
    super(message, ErrorCode.RECORD_MODIFIED, options);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'The submitted data is too large.', options: AppErrorOptions = {}) {
    super(413, ErrorCode.PAYLOAD_TOO_LARGE, message, options);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message = 'Too many requests. Please wait and try again.',
    options: AppErrorOptions = {},
  ) {
    super(429, ErrorCode.RATE_LIMITED, message, options);
  }
}

/** 503 -- a dependency (database, payment provider) is unavailable. */
export class ServiceUnavailableError extends AppError {
  constructor(
    message = 'The service is temporarily unavailable. Please try again shortly.',
    code: ErrorCode = ErrorCode.SERVICE_UNAVAILABLE,
    options: AppErrorOptions = {},
  ) {
    super(503, code, message, options);
  }
}

/** 500 -- an unexpected fault. Details are logged, never returned. */
export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred.', options: AppErrorOptions = {}) {
    super(500, ErrorCode.INTERNAL_ERROR, message, { ...options, isOperational: false });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
