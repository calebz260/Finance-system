/**
 * Rate limiting (Sections 14, 22, 32).
 *
 * A global ceiling protects the whole API; tighter limiters guard the routes that are
 * actually worth attacking -- login, password reset, payment initiation and manual claims,
 * and the provider webhook endpoint -- and are applied by those routers.
 *
 * Note on correctness: limits are keyed on `req.ip`, which is only trustworthy because
 * `trust proxy` is configured from an explicit hop count (see `createApp`). A wrong hop
 * count would let a client forge `X-Forwarded-For` and evade the limit entirely.
 */
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';

import { ErrorCode } from '@sfs/shared';

import { config } from '../config/env.js';
import { buildErrorBody } from '../lib/http.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('http.rate-limit');

function buildLimiter(name: string, options: Partial<Options>): RateLimitRequestHandler {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Tests would otherwise fail unpredictably once a suite exceeds the window budget.
    skip: () => config.isTest,
    handler: (req, res) => {
      log.warn({ requestId: req.requestId, limiter: name, path: req.path }, 'Rate limit exceeded');
      res.status(429).json({
        error: buildErrorBody({
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many requests. Please wait and try again.',
          requestId: req.requestId ?? 'unknown',
        }),
      });
    },
    ...options,
  });
}

/** Applied to the whole API. Generous: it stops floods, not normal use. */
export const globalRateLimiter = buildLimiter('global', {
  windowMs: config.security.rateLimit.windowMs,
  limit: config.security.rateLimit.max,
});

/** Login, password reset, MFA challenge: deliberately strict (Section 25). */
export const authRateLimiter = buildLimiter('auth', {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
});

/** Payment initiation: bounded per IP so a script cannot spray transactions. */
export const paymentRateLimiter = buildLimiter('payment', {
  windowMs: 60 * 1000,
  limit: 20,
});

/**
 * Webhooks: a high but finite ceiling. Malformed or replayed callbacks are rejected by
 * signature verification; this only stops a flood from reaching that check.
 */
export const webhookRateLimiter = buildLimiter('webhook', {
  windowMs: 60 * 1000,
  limit: 300,
});
