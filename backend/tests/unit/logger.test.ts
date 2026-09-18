import { describe, expect, it } from 'vitest';

import { serialiseError } from '../../src/lib/logger.js';

describe('serialiseError', () => {
  it('keeps the fields an operator needs to diagnose a failure', () => {
    const error = new Error('Balance could not be recalculated');
    const serialised = serialiseError(error);

    expect(serialised).toMatchObject({
      type: 'Error',
      message: 'Balance could not be recalculated',
    });
    expect((serialised as { stack?: string }).stack).toBeTypeOf('string');
  });

  it('drops a payload attached to the error, such as a body-parser request body', () => {
    // The real leak this serialiser exists to prevent: body-parser attaches the raw
    // request body to a JSON parse error, and for this system that body can be a
    // payment request containing personal and financial data.
    const error = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed',
      status: 400,
      body: '{"studentId":"STU-2026-00125","amount":"250000.00","payerPhone":"+250788',
    });

    const serialised = JSON.stringify(serialiseError(error));
    expect(serialised).not.toContain('STU-2026-00125');
    expect(serialised).not.toContain('250000.00');
    expect(serialised).not.toContain('+250788');
    expect(serialised).toContain('Unexpected end of JSON input');
  });

  it('keeps a string error code and numeric status when present', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      code: 'P2002',
      statusCode: 409,
    });
    expect(serialiseError(error)).toMatchObject({ code: 'P2002', statusCode: 409 });
  });

  it('follows a cause chain, applying the same whitelist to each link', () => {
    const root = Object.assign(new Error('connection refused'), { secret: 'do-not-log' });
    const wrapper = new Error('Database connection failed', { cause: root });

    const serialised = serialiseError(wrapper) as { cause?: { message?: string } };
    expect(serialised.cause?.message).toBe('connection refused');
    expect(JSON.stringify(serialised)).not.toContain('do-not-log');
  });

  it('stops following a self-referencing cause chain', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as Error & { cause?: unknown }).cause = second;

    expect(() => JSON.stringify(serialiseError(first))).not.toThrow();
  });

  it('handles values that are not errors at all', () => {
    expect(serialiseError('plain string')).toBe('plain string');
    expect(serialiseError(undefined)).toBe('undefined');
    expect(serialiseError(42)).toBe('42');
  });
});
