/**
 * HTTP access logging.
 *
 * One line per completed request, correlated by request id. Health checks are logged at
 * trace level so a load balancer polling `/healthz` every second does not bury the
 * interesting entries.
 *
 * Note on URLs: Express rewrites `req.url` when a request passes through a mounted
 * router, so `originalUrl` is what actually identifies the endpoint. Query strings are
 * stripped, because for this system they carry student ids and filter values.
 */
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';

import { config } from '../config/env.js';
import { logger, serialiseError } from '../lib/logger.js';

const QUIET_PATHS = new Set(['/healthz', '/readyz', '/api/v1/health']);

interface UrlBearingRequest {
  url?: string | undefined;
  originalUrl?: string | undefined;
}

function pathOf(req: UrlBearingRequest): string {
  const raw = req.originalUrl ?? req.url ?? '';
  const queryStart = raw.indexOf('?');
  return queryStart === -1 ? raw : raw.slice(0, queryStart);
}

export const requestLogger: RequestHandler = pinoHttp({
  logger,
  // Reuse the id assigned by requestContextMiddleware so logs and responses agree.
  genReqId: (req) => req.id ?? (req as { requestId?: string }).requestId ?? 'unknown',
  quietReqLogger: true,
  autoLogging: {
    ignore: (req) => config.isTest && QUIET_PATHS.has(pathOf(req)),
  },
  customLogLevel: (req, res, error) => {
    if (error !== undefined && error !== null) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (QUIET_PATHS.has(pathOf(req))) return 'trace';
    return 'info';
  },
  customSuccessMessage: (req, res) =>
    `${req.method ?? '?'} ${pathOf(req)} ${String(res.statusCode)}`,
  customErrorMessage: (req, res) => `${req.method ?? '?'} ${pathOf(req)} ${String(res.statusCode)}`,
  serializers: {
    // Only the fields worth keeping. Full headers could contain tokens, and an error's
    // own properties could contain the request payload -- hence the whitelisting
    // serialiser shared with the application logger.
    req: (req: UrlBearingRequest & { id?: unknown; method?: string; remoteAddress?: string }) => ({
      id: req.id,
      method: req.method,
      path: pathOf(req),
      ip: req.remoteAddress,
    }),
    res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    err: (value: unknown) => serialiseError(value),
  },
});
