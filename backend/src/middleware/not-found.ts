/**
 * Terminal 404 handler: an unmatched route returns the same error envelope as any other
 * failure, so the web client never has to special-case a bare Express HTML page.
 */
import type { Request, Response } from 'express';

import { ErrorCode } from '@sfs/shared';

import { buildErrorBody } from '../lib/http.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: buildErrorBody({
      code: ErrorCode.ROUTE_NOT_FOUND,
      message: `Cannot ${req.method} ${req.path}`,
      requestId: req.requestId ?? 'unknown',
    }),
  });
}
