/**
 * The route guard.
 *
 * Worth stating again in a test file: this decides what to render, not what is
 * allowed. These cases are about the user's experience of the boundary — not being
 * shown a sign-in screen when they are signed in, not being dropped onto a page whose
 * every request would return 403 — rather than about keeping anyone out.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { PermissionKey, type AuthenticatedUser } from '@sfs/shared';

import { AuthContext, type AuthContextValue, type AuthStatus } from '../../auth/auth-context';
import { RequireAuth } from './RequireAuth';

const parent: AuthenticatedUser = {
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
  permissions: [PermissionKey.OWN_FINANCIALS_READ],
};

function contextWith(status: AuthStatus, user: AuthenticatedUser | null): AuthContextValue {
  return {
    status,
    user,
    signIn: () => Promise.resolve({ kind: 'authenticated' }),
    completeMfa: () => Promise.resolve(),
    adoptSession: () => undefined,
    signOut: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    can: (permission) => user?.permissions.includes(permission) ?? false,
    hasRole: (role) => user?.roleKeys.includes(role) ?? false,
  };
}

function renderGuard(args: {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  permissions?: readonly PermissionKey[];
  initialPath?: string;
}): void {
  render(
    <MemoryRouter initialEntries={[args.initialPath ?? '/protected']}>
      <AuthContext.Provider value={contextWith(args.status, args.user)}>
        <Routes>
          <Route
            path="/protected"
            element={
              <RequireAuth
                {...(args.permissions !== undefined ? { permissions: args.permissions } : {})}
              >
                <p>Protected content</p>
              </RequireAuth>
            }
          />
          <Route
            path="/users"
            element={
              <RequireAuth permissions={[PermissionKey.USER_READ]}>
                <p>User accounts</p>
              </RequireAuth>
            }
          />
          <Route
            path="/account/password"
            element={
              <RequireAuth>
                <p>Change your password</p>
              </RequireAuth>
            }
          />
          <Route path="/sign-in" element={<p>Sign in</p>} />
          <Route path="/" element={<p>Home</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('renders the page for a signed-in user', () => {
    renderGuard({ status: 'signed_in', user: parent });
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to the sign-in screen', () => {
    renderGuard({ status: 'signed_out', user: null });
    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('waits while the session is still being established, rather than flashing sign-in', () => {
    // On a reload the provider tries one silent renewal. Showing the sign-in screen
    // during it would be wrong for the majority case: a user who is signed in.
    renderGuard({ status: 'unknown', user: null });

    expect(screen.getByText('Checking your session')).toBeInTheDocument();
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('redirects an account that must replace its initial password', () => {
    renderGuard({
      status: 'signed_in',
      user: { ...parent, mustChangePassword: true },
    });

    expect(screen.getByText('Change your password')).toBeInTheDocument();
  });

  it('lets that account reach the password screen itself', () => {
    // Otherwise the redirect is a loop and the account can never be recovered.
    renderGuard({
      status: 'signed_in',
      user: { ...parent, mustChangePassword: true },
      initialPath: '/account/password',
    });

    expect(screen.getByText('Change your password')).toBeInTheDocument();
  });

  it('turns a missing permission away from the page', () => {
    renderGuard({ status: 'signed_in', user: parent, initialPath: '/users' });

    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.queryByText('User accounts')).not.toBeInTheDocument();
  });

  it('admits a user who holds the required permission', () => {
    renderGuard({
      status: 'signed_in',
      user: { ...parent, permissions: [PermissionKey.USER_READ] },
      initialPath: '/users',
    });

    expect(screen.getByText('User accounts')).toBeInTheDocument();
  });
});
