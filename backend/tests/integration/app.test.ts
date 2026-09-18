/**
 * Application wiring, exercised through real HTTP against the real Express app.
 *
 * The database is replaced with an injected probe so these tests assert the HTTP
 * contract -- envelopes, status codes, headers, limits -- without depending on
 * PostgreSQL. Actual database connectivity is covered by `database.test.ts`.
 */
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ErrorCode, REQUEST_ID_HEADER } from '@sfs/shared';

import { createApp } from '../../src/app.js';
import type { DatabaseProbe } from '../../src/modules/health/health.service.js';

const healthyProbe: DatabaseProbe = { ping: () => Promise.resolve() };
const failingProbe: DatabaseProbe = {
  ping: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5432')),
};

function appWith(probe: DatabaseProbe): Express {
  return createApp({ databaseProbe: probe });
}

describe('GET /healthz', () => {
  it('reports liveness without touching the database', async () => {
    const response = await request(appWith(failingProbe)).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.service).toBe('school-finance-system-api');
    expect(response.body.data.version).toBe('0.1.0-test');
  });
});

describe('GET /readyz', () => {
  it('returns 200 when the database is reachable', async () => {
    const response = await request(appWith(healthyProbe)).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.dependencies[0].name).toBe('postgres');
  });

  it('returns 503 when the database is down, so traffic is routed elsewhere', async () => {
    const response = await request(appWith(failingProbe)).get('/readyz');

    expect(response.status).toBe(503);
    expect(response.body.data.status).toBe('down');
    expect(response.body.data.dependencies[0].detail).toBe('Database connection failed');
  });
});

describe('GET /api/v1/health', () => {
  it('serves the versioned health report', async () => {
    const response = await request(appWith(healthyProbe)).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body.data.environment).toBe('test');
    expect(Array.isArray(response.body.data.dependencies)).toBe(true);
  });
});

describe('request correlation', () => {
  it('assigns a request id and echoes it in the response header', async () => {
    const response = await request(appWith(healthyProbe)).get('/healthz');

    const requestId = response.headers[REQUEST_ID_HEADER];
    expect(requestId).toBeTypeOf('string');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a safe client-supplied request id', async () => {
    const response = await request(appWith(healthyProbe))
      .get('/healthz')
      .set(REQUEST_ID_HEADER, 'trace-abc-123456');

    expect(response.headers[REQUEST_ID_HEADER]).toBe('trace-abc-123456');
  });

  it('replaces an unsafe request id rather than writing it into the logs', async () => {
    const response = await request(appWith(healthyProbe))
      .get('/healthz')
      .set(REQUEST_ID_HEADER, 'bad id with spaces');

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe('bad id with spaces');
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('unmatched routes', () => {
  it('returns the standard error envelope, not an HTML page', async () => {
    const response = await request(appWith(healthyProbe)).get('/api/v1/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.ROUTE_NOT_FOUND);
    expect(response.body.error.message).toContain('/api/v1/does-not-exist');
    expect(response.body.error.requestId).toBeTypeOf('string');
    expect(response.body.error.timestamp).toMatch(/Z$/);
  });
});

describe('request body handling', () => {
  it('rejects malformed JSON with a clear client error', async () => {
    const response = await request(appWith(healthyProbe))
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"amount": ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.MALFORMED_REQUEST);
  });

  it('still attaches a real request id when the body fails to parse', async () => {
    // Regression guard: body parsing must stay behind the request-context middleware,
    // or the errors a user most needs a reference for are the ones without one.
    const response = await request(appWith(healthyProbe))
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"amount": ');

    expect(response.body.error.requestId).not.toBe('unknown');
    expect(response.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(response.body.error.requestId);
  });

  it('rejects a body larger than the configured limit', async () => {
    // Default JSON_BODY_LIMIT is 256kb.
    const oversized = { note: 'x'.repeat(400 * 1024) };
    const response = await request(appWith(healthyProbe))
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(oversized));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });
});

describe('security headers', () => {
  it('sets protective headers and hides the framework', async () => {
    const response = await request(appWith(healthyProbe)).get('/healthz');

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeTypeOf('string');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('CORS policy', () => {
  it('allows a configured origin', async () => {
    const response = await request(appWith(healthyProbe))
      .get('/healthz')
      .set('Origin', 'http://localhost:5173');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow an unconfigured origin', async () => {
    const response = await request(appWith(healthyProbe))
      .get('/healthz')
      .set('Origin', 'https://attacker.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes the request id header to the browser', async () => {
    const response = await request(appWith(healthyProbe))
      .get('/healthz')
      .set('Origin', 'http://localhost:5173');

    expect(response.headers['access-control-expose-headers']).toContain(REQUEST_ID_HEADER);
  });
});
