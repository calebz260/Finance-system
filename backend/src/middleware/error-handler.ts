/**
 * The single place where an error becomes an HTTP response (Section 36).
 *
 * Contract:
 *  - Operational `AppError`s return their own status, code and message.
 *  - Everything else returns a generic 500. The real error is logged in full; the client
 *    gets a request id to quote, never a stack trace, SQL fragment or secret.
 *  - Known infrastructure failures (Zod, Prisma, body-parser) are translated into the
 *    right domain code instead of leaking as 500s.
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { ErrorCode, type FieldError } from '@sfs/shared';

import { config } from '../config/env.js';
import { type AppError, isAppError } from '../lib/errors.js';
import { buildErrorBody } from '../lib/http.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('http.error');

/** Body-parser / raw-body errors carry a `type` and an HTTP `status`. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Prisma's known-request errors are duck-typed rather than imported, so this middleware
 * does not depend on generated client code and keeps working if the ORM is swapped.
 */
interface PrismaKnownError extends Error {
  code: string;
  clientVersion: string;
  meta?: Record<string, unknown>;
}

function isPrismaKnownError(error: unknown): error is PrismaKnownError {
  return (
    error instanceof Error &&
    typeof (error as PrismaKnownError).code === 'string' &&
    /^P\d{4}$/.test((error as PrismaKnownError).code) &&
    typeof (error as PrismaKnownError).clientVersion === 'string'
  );
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return error instanceof Error && typeof (error as BodyParserError).type === 'string';
}

function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

interface TranslatedError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly fieldErrors?: readonly FieldError[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly isOperational: boolean;
}

function translate(error: unknown): TranslatedError {
  if (isAppError(error)) {
    const appError: AppError = error;
    return {
      status: appError.httpStatus,
      code: appError.code,
      message: appError.message,
      ...(appError.fieldErrors !== undefined ? { fieldErrors: appError.fieldErrors } : {}),
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      isOperational: appError.isOperational,
    };
  }

  // A Zod error that escaped the validation middleware -- e.g. a schema applied inside a
  // service. Treated as a client validation problem, which is what it always is.
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'The submitted data is not valid.',
      fieldErrors: zodToFieldErrors(error),
      isOperational: true,
    };
  }

  if (isBodyParserError(error)) {
    if (error.type === 'entity.too.large') {
      return {
        status: 413,
        code: ErrorCode.PAYLOAD_TOO_LARGE,
        message: 'The submitted data is too large.',
        isOperational: true,
      };
    }
    if (error.type === 'entity.parse.failed') {
      return {
        status: 400,
        code: ErrorCode.MALFORMED_REQUEST,
        message: 'The request body is not valid JSON.',
        isOperational: true,
      };
    }
    if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
      return {
        status: 415,
        code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        message: 'The request encoding is not supported.',
        isOperational: true,
      };
    }
  }

  if (isPrismaKnownError(error)) {
    switch (error.code) {
      case 'P2002':
        return {
          status: 409,
          code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'A record with these details already exists.',
          isOperational: true,
        };
      case 'P2003':
        return {
          status: 409,
          code: ErrorCode.CONFLICT,
          message: 'This record is referenced by other records and cannot be changed that way.',
          isOperational: true,
        };
      case 'P2025':
        return {
          status: 404,
          code: ErrorCode.NOT_FOUND,
          message: 'The requested resource was not found.',
          isOperational: true,
        };
      case 'P2034':
        // Write conflict / deadlock -- safe for the client to retry.
        return {
          status: 409,
          code: ErrorCode.RECORD_MODIFIED,
          message:
            'This record was changed by someone else while you were editing it. Reload and try again.',
          isOperational: true,
        };
      default:
        break;
    }
  }

  return {
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: 'An unexpected error occurred.',
    isOperational: false,
  };
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Headers already sent: the response is committed, so hand back to Express to close it.
  if (res.headersSent) {
    next(error);
    return;
  }

  const translated = translate(error);
  const requestId = req.requestId ?? 'unknown';

  // The matched route pattern (`/students/:id`) rather than `originalUrl`: it keeps
  // identifiers and query strings -- which may be personal data -- out of the logs, and
  // keeps log cardinality bounded. Express types `route` loosely, hence the narrow cast.
  const route = (req as { route?: { path?: string } }).route;

  const logPayload = {
    requestId,
    method: req.method,
    route: route?.path ?? req.path,
    status: translated.status,
    errorCode: translated.code,
    ...(isAppError(error) && error.logContext !== undefined ? error.logContext : {}),
  };

  if (translated.isOperational) {
    log.warn({ ...logPayload, err: error }, 'Request failed');
  } else {
    log.error({ ...logPayload, err: error }, 'Unhandled error while processing request');
  }

  const body = buildErrorBody({
    code: translated.code,
    message: translated.message,
    requestId,
    ...(translated.fieldErrors !== undefined ? { fieldErrors: translated.fieldErrors } : {}),
    ...(translated.details !== undefined ? { details: translated.details } : {}),
  });

  // Outside production, non-operational errors carry the original message to speed up
  // debugging. Production never sees it.
  const debugBody =
    !config.isProduction && !translated.isOperational && error instanceof Error
      ? { error: { ...body, debug: { name: error.name, message: error.message } } }
      : { error: body };

  res.status(translated.status).json(debugBody);
};
