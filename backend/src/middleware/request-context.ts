/**
 * Assigns every request a correlation id and opens the ambient request context.
 *
 * A client-supplied `X-Request-Id` is honoured only when it looks like a safe opaque
 * token; otherwise a fresh UUID is generated. That prevents a caller from injecting
 * newlines or control characters into log lines (log forging).
 */
import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { REQUEST_ID_HEADER } from '@sfs/shared';

import { runWithRequestContext } from '../lib/request-context.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header(REQUEST_ID_HEADER);
  const requestId =
    provided !== undefined && SAFE_REQUEST_ID.test(provided) ? provided : randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext(
    {
      requestId,
      startedAt: new Date(),
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
      ...(req.header('user-agent') !== undefined ? { userAgent: req.header('user-agent') } : {}),
    },
    () => {
      next();
    },
  );
}
