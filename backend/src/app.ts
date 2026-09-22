/**
 * Express application factory.
 *
 * Exported as a factory (rather than a module-level `app`) so integration tests can
 * build a fresh, fully-wired application per suite and drive it with Supertest without
 * binding a port.
 *
 * Middleware order is deliberate and load-bearing:
 *   1. security headers      -- applied before anything can respond
 *   2. CORS                  -- rejects disallowed origins early
 *   3. request context       -- assigns the request id everything else logs
 *   4. access logging        -- needs the request id from step 3
 *   5. global rate limiting  -- before any body is parsed, so an abusive client cannot
 *                               make the server do work; needs a trustworthy req.ip
 *   6. body parsing          -- after step 3, so a malformed-JSON rejection still
 *                               carries a request id the user can quote
 *   7. routes
 *   8. 404 handler
 *   9. error handler         -- must be last
 */
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { API_BASE_PATH, REQUEST_ID_HEADER } from '@sfs/shared';

import { config } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { globalRateLimiter } from './middleware/rate-limit.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { requestLogger } from './middleware/request-logger.js';
import { createProbeRouter } from './modules/health/health.routes.js';
import { createPaymentWebhookRouter } from './modules/payments/payment.routes.js';
import { createApiV1Router } from './routes/v1.js';
import type { DatabaseProbe } from './modules/health/health.service.js';

export interface CreateAppOptions {
  /** Overridden in unit-style integration tests that must not touch a real database. */
  readonly databaseProbe?: DatabaseProbe;
}

function buildCorsOptions(): CorsOptions {
  const allowed = new Set(config.security.corsOrigins);
  return {
    origin: (origin, callback) => {
      // No Origin header: same-origin navigation, curl, or a provider webhook. CORS is a
      // browser protection, so there is nothing to enforce here.
      if (origin === undefined || origin === '') {
        callback(null, true);
        return;
      }
      if (allowed.has(origin)) {
        callback(null, true);
        return;
      }
      // Reported as a CORS rejection, not an exception, so the browser gets a clean
      // failure and the server does not log a stack trace per blocked request.
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
    maxAge: 600,
  };
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  // Never advertise the framework.
  app.disable('x-powered-by');

  // `req.ip` must be the real client for rate limiting and audit logs to mean anything.
  // An explicit hop count is used instead of `true`, which would trust any forged
  // X-Forwarded-For header.
  app.set('trust proxy', config.server.trustProxyHops);

  // Reject unknown query-string array/object syntax rather than silently coercing it.
  app.set('query parser', 'simple');

  app.use(
    helmet({
      // The API returns JSON only; HSTS and the rest of the defaults still apply.
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cors(buildCorsOptions()));

  app.use(requestContextMiddleware);
  app.use(requestLogger);
  app.use(globalRateLimiter);

  app.use(compression());

  // Provider callbacks, mounted **before** the JSON parser and given the raw bytes.
  //
  // A webhook signature covers the exact body the provider sent. Once `express.json` has
  // parsed it, those bytes are gone: `JSON.stringify(req.body)` reproduces a body with
  // the same meaning and, quite possibly, different bytes — different key order, no
  // insignificant whitespace, a number re-rendered — and a signature checked against a
  // re-serialisation is not checked against anything. Mounting the route here, with
  // `express.raw`, is what makes verification real rather than decorative (Section 16).
  //
  // It still sits after the request context, the access log and the global rate limiter,
  // so a callback is logged, correlated and throttled like every other request.
  app.use(
    `${API_BASE_PATH}/payment-webhooks`,
    express.raw({ type: '*/*', limit: config.server.jsonBodyLimit }),
    createPaymentWebhookRouter(),
  );

  app.use(express.json({ limit: config.server.jsonBodyLimit }));
  // Auth refresh tokens are delivered as httpOnly cookies from Phase 2 onwards.
  app.use(cookieParser());

  // Unversioned infrastructure probes: `/healthz`, `/readyz`.
  app.use(createProbeRouter(options.databaseProbe));

  // Versioned application API: `/api/v1/...`
  app.use(API_BASE_PATH, createApiV1Router(options));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
