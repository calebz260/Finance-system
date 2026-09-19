import { Route, Routes } from 'react-router';

import { PermissionKey } from '@sfs/shared';

import { RequireAuth } from './components/auth/RequireAuth';
import { AppLayout } from './components/layout/AppLayout';
import { AccountPage } from './pages/AccountPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { SignInPage } from './pages/SignInPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { UsersPage } from './pages/UsersPage';

/**
 * Route table.
 *
 * Grows one module at a time; each new screen is added here only once its backend
 * workflow exists.
 *
 * The split that matters is between the public routes — the three a person reaches
 * precisely because they cannot sign in — and everything behind `RequireAuth`. The
 * guard decides what to render; the server decides what is allowed, and re-reads the
 * caller's permissions from the database on every request to do it.
 */
export function App(): React.JSX.Element {
  return (
    <AppLayout>
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        <Route
          path="/"
          element={
            <RequireAuth>
              <SystemStatusPage />
            </RequireAuth>
          }
        />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <AccountPage />
            </RequireAuth>
          }
        />
        {/* Reachable by an account that must change its password, and by no other route. */}
        <Route
          path="/account/password"
          element={
            <RequireAuth>
              <ChangePasswordPage />
            </RequireAuth>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAuth permissions={[PermissionKey.USER_READ]}>
              <UsersPage />
            </RequireAuth>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppLayout>
  );
}
