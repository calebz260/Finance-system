/**
 * The sign-in flow, rendered against a stubbed API.
 *
 * These exercise the provider as well as the page, because the interesting behaviour
 * lives between them: a correct password that yields a challenge rather than a session,
 * and a failure message that must not say more than the server did.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@sfs/shared';

import { AuthProvider } from '../auth/AuthProvider';
import { clearAccessToken, setRefreshHandler } from '../lib/auth-token';
import { SignInPage } from './SignInPage';
import type { StubbedResponse } from '../tests/fetch-mock';

const parent = {
  id: 'user-1',
  email: 'parent@gskicukiro.invalid',
  firstName: 'Claudine',
  lastName: 'Uwase',
  schoolId: 'school-1',
  isSystemAdministrator: false,
  mustChangePassword: false,
  mfaEnabled: false,
  mfaSatisfied: false,
  roleKeys: ['PARENT'],
  permissions: ['own.financials_read'],
};

/**
 * Route the stub by URL rather than by call order.
 *
 * The provider fires a silent refresh on mount, so an order-based stub would hand the
 * sign-in response to the bootstrap call and make every test misleading.
 */
function stubApi(routes: Record<string, StubbedResponse>): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string) => {
    const match = Object.keys(routes).find((path) => url.includes(path));
    // An unstubbed call is a bug in the test rather than a scenario. Answering 404 makes
    // it visible instead of letting `undefined` travel somewhere further along.
    const stub: StubbedResponse = (match === undefined ? undefined : routes[match]) ?? {
      status: 404,
      body: { error: notFound() },
    };

    const text = stub.rawBody ?? (stub.body === undefined ? '' : JSON.stringify(stub.body));
    return Promise.resolve({
      ok: stub.status >= 200 && stub.status < 300,
      status: stub.status,
      headers: { get: (): string | null => null },
      text: (): Promise<string> => Promise.resolve(text),
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function notFound(): unknown {
  return {
    code: ErrorCode.ROUTE_NOT_FOUND,
    message: 'Not found',
    requestId: 'req-0',
    timestamp: '2026-09-19T10:00:00.000Z',
  };
}

/** No live session: the bootstrap refresh fails, as it does for any visitor. */
const NO_SESSION: StubbedResponse = {
  status: 401,
  body: {
    error: {
      code: ErrorCode.TOKEN_INVALID,
      message: 'Your session is no longer valid. Please sign in again.',
      requestId: 'req-0',
      timestamp: '2026-09-19T10:00:00.000Z',
    },
  },
};

function renderSignIn(): void {
  render(
    <MemoryRouter initialEntries={['/sign-in']}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/" element={<p>Signed in landing page</p>} />
          <Route path="/forgot-password" element={<p>Reset request</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function submitCredentials(password = 'Turquoise-Lantern-88'): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email address/i), 'parent@gskicukiro.invalid');
  await user.type(screen.getByLabelText(/^password/i), password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

afterEach(() => {
  clearAccessToken();
  setRefreshHandler(null);
});

describe('SignInPage', () => {
  it('signs in and lands the user on the page they asked for', async () => {
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 200,
        body: {
          data: {
            status: 'authenticated',
            accessToken: 'access-token',
            expiresInSeconds: 900,
            user: parent,
          },
        },
      },
    });

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByText('Signed in landing page')).toBeInTheDocument();
  });

  it('asks for a second factor instead of signing in, when the role requires one', async () => {
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 200,
        body: {
          data: { status: 'mfa_required', challengeToken: 'challenge-1', expiresInSeconds: 300 },
        },
      },
    });

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByLabelText(/authenticator code/i)).toBeInTheDocument();
    // No session yet: the landing page must not appear behind the challenge.
    expect(screen.queryByText('Signed in landing page')).not.toBeInTheDocument();
  });

  it('completes the second factor and signs in', async () => {
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 200,
        body: {
          data: { status: 'mfa_required', challengeToken: 'challenge-1', expiresInSeconds: 300 },
        },
      },
      '/auth/mfa/verify': {
        status: 200,
        body: {
          data: {
            accessToken: 'access-token',
            expiresInSeconds: 900,
            user: { ...parent, mfaEnabled: true, mfaSatisfied: true, roleKeys: ['BURSAR'] },
          },
        },
      },
    });

    renderSignIn();
    await submitCredentials();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByText('Signed in landing page')).toBeInTheDocument();
  });

  it('offers a recovery code as an alternative to the authenticator', async () => {
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 200,
        body: {
          data: { status: 'mfa_required', challengeToken: 'challenge-1', expiresInSeconds: 300 },
        },
      },
    });

    renderSignIn();
    await submitCredentials();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /use a recovery code/i }));

    expect(screen.getByLabelText(/recovery code/i)).toBeInTheDocument();
  });

  it('enrols a second factor mid-sign-in and lands the user signed in', async () => {
    // Completing enrolment establishes the session outright. Dropping it here would
    // send someone who just enrolled back to the password form they filled in a minute
    // ago — and the server has already set the refresh cookie.
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 200,
        body: {
          data: {
            status: 'mfa_enrolment_required',
            enrolmentToken: 'enrolment-1',
            expiresInSeconds: 300,
          },
        },
      },
      '/auth/mfa/enrolment/start': {
        status: 200,
        body: {
          data: {
            secret: 'JBSWY3DPEHPK3PXP',
            otpauthUri: 'otpauth://totp/School%20Finance%20System:bursar?secret=JBSWY3DPEHPK3PXP',
          },
        },
      },
      '/auth/mfa/enrolment/confirm': {
        status: 200,
        body: {
          data: {
            recoveryCodes: ['AC3EF-HJK4M-NPQ6R-TUVWX'],
            reauthenticationRequired: false,
            session: {
              accessToken: 'access-token',
              expiresInSeconds: 900,
              user: { ...parent, mfaEnabled: true, mfaSatisfied: true, roleKeys: ['BURSAR'] },
            },
          },
        },
      },
    });

    renderSignIn();
    await submitCredentials();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/six-digit code/i), '123456');
    await user.click(screen.getByRole('button', { name: /turn on two-factor/i }));

    // Recovery codes are shown once, and the user has to acknowledge them.
    expect(await screen.findByText('AC3EF-HJK4M-NPQ6R-TUVWX')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /i have saved my recovery codes/i }));

    expect(await screen.findByText('Signed in landing page')).toBeInTheDocument();
  });

  it('shows the server`s message verbatim, revealing nothing about the account', async () => {
    // The server answers identically for an unknown address and a wrong password. A
    // friendlier, more specific message here would undo that.
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 401,
        body: {
          error: {
            code: ErrorCode.INVALID_CREDENTIALS,
            message: 'The email address or password is incorrect.',
            requestId: 'req-9',
            timestamp: '2026-09-19T10:00:00.000Z',
          },
        },
      },
    });

    renderSignIn();
    await submitCredentials('WrongPassword-2026');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The email address or password is incorrect.');
    expect(alert).not.toHaveTextContent(/no account/i);
    expect(alert).not.toHaveTextContent(/unknown/i);
  });

  it('clears the password box after a failure', async () => {
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 401,
        body: {
          error: {
            code: ErrorCode.INVALID_CREDENTIALS,
            message: 'The email address or password is incorrect.',
            requestId: 'req-9',
            timestamp: '2026-09-19T10:00:00.000Z',
          },
        },
      },
    });

    renderSignIn();
    await submitCredentials('WrongPassword-2026');

    await screen.findByRole('alert');
    await waitFor(() => {
      expect(screen.getByLabelText(/^password/i)).toHaveValue('');
    });
  });

  it('reports a locked account with the reason, which its owner is entitled to know', async () => {
    stubApi({
      '/auth/refresh': NO_SESSION,
      '/auth/login': {
        status: 401,
        body: {
          error: {
            code: ErrorCode.ACCOUNT_LOCKED,
            message:
              'This account is temporarily locked after too many failed attempts. Try again later or contact the school administrator.',
            requestId: 'req-9',
            timestamp: '2026-09-19T10:00:00.000Z',
          },
        },
      },
    });

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily locked/i);
  });

  it('sends the user straight through when a session already exists', async () => {
    stubApi({
      '/auth/refresh': {
        status: 200,
        body: {
          data: { accessToken: 'access-token', expiresInSeconds: 900, user: parent },
        },
      },
    });

    renderSignIn();

    expect(await screen.findByText('Signed in landing page')).toBeInTheDocument();
  });
});
