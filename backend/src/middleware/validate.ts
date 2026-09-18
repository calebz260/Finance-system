/**
 * Request validation.
 *
 * Every route that accepts input declares a Zod schema for its body, query and params.
 * Parsed output is attached to `req.valid` rather than overwriting `req.body`/`req.query`
 * -- Express 5 exposes `query` through a getter, and keeping the raw input intact means a
 * later middleware can still see exactly what the client sent.
 *
 * Handlers read the parsed data through `validated<T>(req)`, which is the single place
 * where the cast from `unknown` happens.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

import type { FieldError } from '@sfs/shared';

import { ValidationError } from '../lib/errors.js';

export interface ParsedRequestData {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface RequestSchemas {
  readonly body?: ZodType;
  readonly query?: ZodType;
  readonly params?: ZodType;
}

type RequestPart = 'body' | 'query' | 'params';

const PARTS: readonly RequestPart[] = ['params', 'query', 'body'];

function readPart(req: Request, part: RequestPart): unknown {
  switch (part) {
    case 'body':
      return req.body;
    case 'query':
      return req.query;
    case 'params':
      return req.params;
  }
}

/**
 * Build a validation middleware. All declared parts are validated before failing, so the
 * client receives every field problem at once instead of discovering them one reload at
 * a time.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const fieldErrors: FieldError[] = [];
    const parsed: ParsedRequestData = {};

    for (const part of PARTS) {
      const schema = schemas[part];
      if (schema === undefined) continue;

      const result = schema.safeParse(readPart(req, part));
      if (result.success) {
        parsed[part] = result.data;
        continue;
      }
      for (const issue of result.error.issues) {
        const path = [part, ...issue.path.map((segment) => String(segment))].join('.');
        fieldErrors.push({ path, message: issue.message, code: issue.code });
      }
    }

    if (fieldErrors.length > 0) {
      next(
        new ValidationError('The submitted data is not valid.', {
          fieldErrors,
          // Point the operator at the first problem in the log without dumping the body,
          // which may contain personal or financial data.
          logContext: { invalidPaths: fieldErrors.map((error) => error.path) },
        }),
      );
      return;
    }

    req.valid = parsed;
    next();
  };
}

/**
 * Read validated request data. Safe because a route only calls this when the matching
 * `validate(...)` middleware ran first; if that wiring is ever missed, the missing part
 * surfaces immediately as a thrown error rather than as `undefined` deep in a service.
 */
export function validated<TParsed extends ParsedRequestData>(req: Request): TParsed {
  if (req.valid === undefined) {
    throw new Error(
      'validated(req) was called on a route without validate(...) middleware. This is a wiring bug.',
    );
  }
  return req.valid as TParsed;
}
