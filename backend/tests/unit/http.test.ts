import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE, ErrorCode, MAX_PAGE_SIZE } from '@sfs/shared';

import { buildErrorBody, resolvePagination } from '../../src/lib/http.js';

describe('resolvePagination', () => {
  it('defaults to the first page at the default size', () => {
    expect(resolvePagination({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });

  it('computes skip from the page and size', () => {
    expect(resolvePagination({ page: 3, pageSize: 50 })).toEqual({
      page: 3,
      pageSize: 50,
      skip: 100,
      take: 50,
    });
  });

  it('caps the page size so a client cannot pull the whole table', () => {
    const resolved = resolvePagination({ page: 1, pageSize: 100_000 });
    expect(resolved.pageSize).toBe(MAX_PAGE_SIZE);
    expect(resolved.take).toBe(MAX_PAGE_SIZE);
  });

  it('clamps nonsense input to the first page and at least one row', () => {
    expect(resolvePagination({ page: 0, pageSize: 0 }).page).toBe(1);
    expect(resolvePagination({ page: -5, pageSize: -10 })).toEqual({
      page: 1,
      pageSize: 1,
      skip: 0,
      take: 1,
    });
  });

  it('truncates fractional input rather than producing a fractional offset', () => {
    expect(resolvePagination({ page: 2.7, pageSize: 10.9 })).toEqual({
      page: 2,
      pageSize: 10,
      skip: 10,
      take: 10,
    });
  });
});

describe('buildErrorBody', () => {
  it('always carries the code, request id and an ISO-8601 UTC timestamp', () => {
    const body = buildErrorBody({
      code: ErrorCode.NOT_FOUND,
      message: 'Student not found',
      requestId: 'req-1',
    });

    expect(body.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.message).toBe('Student not found');
    expect(body.requestId).toBe('req-1');
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('omits empty field errors and details rather than sending null keys', () => {
    const body = buildErrorBody({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
      requestId: 'req-2',
      fieldErrors: [],
    });

    expect(body).not.toHaveProperty('fieldErrors');
    expect(body).not.toHaveProperty('details');
  });

  it('includes field errors and details when present', () => {
    const body = buildErrorBody({
      code: ErrorCode.AMOUNT_BELOW_MINIMUM,
      message: 'The amount is below the minimum accepted payment.',
      requestId: 'req-3',
      fieldErrors: [{ path: 'body.amount', message: 'Must be at least RWF 1,000' }],
      details: { minimumAmount: '1000.00' },
    });

    expect(body.fieldErrors).toHaveLength(1);
    expect(body.details).toEqual({ minimumAmount: '1000.00' });
  });
});
