import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  ErrorCode,
  MAX_PAGE_SIZE,
  buildPaginationMeta,
  isApiErrorResponse,
} from '../src/api.js';

describe('buildPaginationMeta', () => {
  it('derives page counts and navigation flags', () => {
    expect(buildPaginationMeta({ page: 1, pageSize: 25, totalItems: 1040 })).toEqual({
      page: 1,
      pageSize: 25,
      totalItems: 1040,
      totalPages: 42,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('reports a single empty page rather than zero pages', () => {
    const meta = buildPaginationMeta({ page: 1, pageSize: 25, totalItems: 0 });
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(false);
  });

  it('flags the last page correctly', () => {
    const meta = buildPaginationMeta({ page: 42, pageSize: 25, totalItems: 1040 });
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(true);
  });

  it('keeps page-size bounds sane', () => {
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });
});

describe('isApiErrorResponse', () => {
  it('detects the error envelope', () => {
    expect(
      isApiErrorResponse({
        error: {
          code: ErrorCode.NOT_FOUND,
          message: 'Student not found',
          requestId: 'req-1',
          timestamp: '2026-09-18T08:00:00.000Z',
        },
      }),
    ).toBe(true);
  });

  it('does not mistake a success envelope for an error', () => {
    expect(isApiErrorResponse({ data: { id: 1 } })).toBe(false);
    expect(isApiErrorResponse(null)).toBe(false);
    expect(isApiErrorResponse('error')).toBe(false);
  });
});
