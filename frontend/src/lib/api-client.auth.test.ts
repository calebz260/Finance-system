/**
 * How the client carries the session, and what it does when a token expires.
 *
 * The renewal behaviour is worth testing carefully because both failure modes are
 * expensive: renewing too eagerly presents an already-consumed refresh token, which the
 * server treats as theft and answers by destroying the session; not renewing at all
 * bounces a bursar to the sign-in screen every fifteen minutes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@sfs/shared';

import { ApiError, api } from './api-client';
import {
  clearAccessToken,
  refreshAccessToken,
  setAccessToken,
  setRefreshHandler,
} from './auth-token';
import { stubFetchResponse, stubFetchSequence } from '../tests/fetch-mock';

function headersOf(mock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const [, init] = mock.mock.calls[call] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

function expiredTokenBody(): unknown {
  return {
    error: {
      code: ErrorCode.TOKEN_EXPIRED,
      message: 'Your session has expired. Please sign in again.',
      requestId: 'req-1',
      timestamp: '2026-09-19T10:00:00.000Z',
    },
  };
}

afterEach(() => {
  clearAccessToken();
  setRefreshHandler(null);
});

describe('bearer token', () => {
  it('attaches the access token when one is held', async () => {
    setAccessToken('token-abc');
    const fetchMock = stubFetchResponse({ status: 200, body: { data: { ok: true } } });

    await api.get('/api/v1/users');

    expect(headersOf(fetchMock).Authorization).toBe('Bearer token-abc');
  });

  it('sends no authorization header when there is no session', async () => {
    const fetchMock = stubFetchResponse({ status: 200, body: { data: { ok: true } } });

    await api.get('/api/v1/health');

    expect(headersOf(fetchMock).Authorization).toBeUndefined();
  });

  it('omits the token on an anonymous request', async () => {
    // Sign-in and refresh carry their own credential; attaching a stale bearer token
    // to them would be meaningless at best.
    setAccessToken('token-abc');
    const fetchMock = stubFetchResponse({ status: 200, body: { data: { ok: true } } });

    await api.post('/api/v1/auth/login', { email: 'a@b.invalid' }, { anonymous: true });

    expect(headersOf(fetchMock).Authorization).toBeUndefined();
  });

  it('always sends credentials, so the httpOnly refresh cookie travels', async () => {
    const fetchMock = stubFetchResponse({ status: 200, body: { data: { ok: true } } });

    await api.get('/api/v1/health');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });
});

describe('renewing an expired token', () => {
  it('refreshes once and retries the original request', async () => {
    setAccessToken('expired-token');
    const refresh = vi.fn(() => {
      setAccessToken('fresh-token');
      return Promise.resolve('fresh-token');
    });
    setRefreshHandler(refresh);

    const fetchMock = stubFetchSequence([
      { status: 401, body: expiredTokenBody() },
      { status: 200, body: { data: { ok: true } } },
    ]);

    await expect(api.get('/api/v1/users')).resolves.toEqual({ ok: true });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry carries the new token, not the one that just expired.
    expect(headersOf(fetchMock, 1).Authorization).toBe('Bearer fresh-token');
  });

  it('gives up after one retry rather than looping', async () => {
    setAccessToken('expired-token');
    setRefreshHandler(() => Promise.resolve('fresh-token'));

    const fetchMock = stubFetchSequence([
      { status: 401, body: expiredTokenBody() },
      { status: 401, body: expiredTokenBody() },
    ]);

    await expect(api.get('/api/v1/users')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when the session was revoked rather than expired', async () => {
    // TOKEN_INVALID means a deliberate revocation -- a sign-out elsewhere, a password
    // change, or reuse detection. Retrying would turn that into a loop.
    setAccessToken('revoked-token');
    const refresh = vi.fn(() => Promise.resolve('fresh-token'));
    setRefreshHandler(refresh);

    stubFetchResponse({
      status: 401,
      body: {
        error: {
          code: ErrorCode.TOKEN_INVALID,
          message: 'Your session has ended. Please sign in again.',
          requestId: 'req-2',
          timestamp: '2026-09-19T10:00:00.000Z',
        },
      },
    });

    await expect(api.get('/api/v1/users')).rejects.toMatchObject({
      code: ErrorCode.TOKEN_INVALID,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh on a 403, which is a permission answer and not a session one', async () => {
    setAccessToken('token-abc');
    const refresh = vi.fn(() => Promise.resolve('fresh-token'));
    setRefreshHandler(refresh);

    stubFetchResponse({
      status: 403,
      body: {
        error: {
          code: ErrorCode.INSUFFICIENT_PERMISSION,
          message: 'You do not have permission to perform this action.',
          requestId: 'req-3',
          timestamp: '2026-09-19T10:00:00.000Z',
        },
      },
    });

    await expect(api.get('/api/v1/users')).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_PERMISSION,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports the original error when no renewal is available', async () => {
    setAccessToken('expired-token');
    setRefreshHandler(() => Promise.resolve(null));

    stubFetchResponse({ status: 401, body: expiredTokenBody() });

    await expect(api.get('/api/v1/users')).rejects.toMatchObject({
      code: ErrorCode.TOKEN_EXPIRED,
    });
  });

  it('never refreshes an anonymous request, which would recurse', async () => {
    const refresh = vi.fn(() => Promise.resolve('fresh-token'));
    setRefreshHandler(refresh);

    stubFetchResponse({ status: 401, body: expiredTokenBody() });

    await expect(
      api.post('/api/v1/auth/refresh', undefined, { anonymous: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('concurrent renewals', () => {
  it('collapses simultaneous refreshes onto one request', async () => {
    // Four requests expiring together must not present the refresh token four times:
    // three of those would be reuse, and reuse destroys the session.
    let resolveRefresh: ((token: string | null) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    setRefreshHandler(refresh);

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    const third = refreshAccessToken();

    resolveRefresh?.('fresh-token');

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'fresh-token',
      'fresh-token',
      'fresh-token',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('allows a later renewal once the first has settled', async () => {
    const refresh = vi.fn(() => Promise.resolve('fresh-token'));
    setRefreshHandler(refresh);

    await refreshAccessToken();
    await refreshAccessToken();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('resolves to null when nothing has registered a renewal', async () => {
    setRefreshHandler(null);
    await expect(refreshAccessToken()).resolves.toBeNull();
  });
});
