import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@sfs/shared';

import { ApiError, api, request, requestPaginated } from './api-client';
import { stubFetchNetworkError, stubFetchResponse } from '../tests/fetch-mock';

describe('request', () => {
  it('unwraps the data envelope', async () => {
    stubFetchResponse({ status: 200, body: { data: { studentId: 'STU-2026-00125' } } });
    await expect(request<{ studentId: string }>('/api/v1/students/1')).resolves.toEqual({
      studentId: 'STU-2026-00125',
    });
  });

  it('sends the body as JSON with the right content type', async () => {
    const fetchMock = stubFetchResponse({ status: 200, body: { data: { ok: true } } });
    await api.post('/api/v1/payments/manual-claims', { amount: '50000.00' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amount":"50000.00"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('forwards an idempotency key so a retry cannot duplicate a payment', async () => {
    const fetchMock = stubFetchResponse({ status: 200, body: { data: { ok: true } } });
    await api.post('/api/v1/payments', { amount: '1000.00' }, { idempotencyKey: 'key-123' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('key-123');
  });

  it('appends query parameters and drops empty ones', async () => {
    const fetchMock = stubFetchResponse({ status: 200, body: { data: [] } });
    await api.get('/api/v1/payments', {
      query: { page: 2, status: 'PENDING', class: undefined, term: '' },
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('page=2');
    expect(url).toContain('status=PENDING');
    expect(url).not.toContain('class=');
    expect(url).not.toContain('term=');
  });

  it('returns pagination metadata for list endpoints', async () => {
    stubFetchResponse({
      status: 200,
      body: {
        data: [{ id: '1' }],
        meta: {
          page: 1,
          pageSize: 25,
          totalItems: 1040,
          totalPages: 42,
          hasNextPage: true,
          hasPreviousPage: false,
        },
      },
    });

    const result = await requestPaginated<{ id: string }>('/api/v1/payments');
    expect(result.data).toHaveLength(1);
    expect(result.meta.totalItems).toBe(1040);
    expect(result.meta.hasNextPage).toBe(true);
  });
});

describe('request error handling', () => {
  it('converts an error envelope into an ApiError with its code and request id', async () => {
    stubFetchResponse({
      status: 409,
      requestId: 'req-abc',
      body: {
        error: {
          code: ErrorCode.RECORD_MODIFIED,
          message: 'This record was changed by someone else.',
          requestId: 'req-abc',
          timestamp: '2026-09-18T08:00:00.000Z',
        },
      },
    });

    const error = await request('/api/v1/students/1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe(ErrorCode.RECORD_MODIFIED);
    expect(apiError.status).toBe(409);
    expect(apiError.requestId).toBe('req-abc');
    expect(apiError.isRetryable).toBe(true);
  });

  it('maps field errors to form field names', async () => {
    stubFetchResponse({
      status: 400,
      body: {
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The submitted data is not valid.',
          fieldErrors: [
            { path: 'body.amount', message: 'Amount must be greater than zero' },
            { path: 'body.studentId', message: 'Student ID is required' },
          ],
          requestId: 'req-def',
          timestamp: '2026-09-18T08:00:00.000Z',
        },
      },
    });

    const error = (await request('/api/v1/payments').catch(
      (caught: unknown) => caught,
    )) as ApiError;
    expect(error.fieldErrorsByPath).toEqual({
      amount: 'Amount must be greater than zero',
      studentId: 'Student ID is required',
    });
    expect(error.isRetryable).toBe(false);
  });

  it('reports an unreachable server as a retryable service error', async () => {
    stubFetchNetworkError();
    const error = (await request('/api/v1/health').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(error.message).toMatch(/Could not reach the server/);
    expect(error.isRetryable).toBe(true);
  });

  it('falls back to a safe message when the error body is not an envelope', async () => {
    stubFetchResponse({ status: 502, rawBody: '<html>Bad Gateway</html>' });
    const error = (await request('/api/v1/health').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.message).toMatch(/temporarily unavailable/);
  });

  it('rejects a 200 response that is not in the envelope shape', async () => {
    stubFetchResponse({ status: 200, body: { unexpected: true } });
    const error = (await request('/api/v1/health').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.message).toMatch(/unexpected response/);
  });

  it('treats 204 as an empty success', async () => {
    stubFetchResponse({ status: 204 });
    await expect(api.delete('/api/v1/sessions/current')).resolves.toBeUndefined();
  });
});
