/**
 * The route guard.
 *
 * What it does and does not do is worth being explicit about: it decides what to
 * *render*. It is not a security control. Every route it protects is also enforced on
 * the server, which re-reads the caller's permissions from the database on each
 * request — a user who edits their way past this guard reaches screens whose every
 * request returns 403.
 *
 * It exists because showing a parent a link to the bursar's reconciliation screen is a
 * poor experience, not because hiding it makes the data safe.
 */
import { Navigate, useLocation } from 'react-router';
import type { ReactNode } from 'react';

import type { PermissionKey } from '@sfs/shared';

import { Spinner } from '../ui/Spinner';
import { useAuth } from '../../auth/auth-context';

export interface RequireAuthProps {
  readonly children: ReactNode;
  /** Every listed permission is required, matching `requirePermission` on the server. */
  readonly permissions?: readonly PermissionKey[];
}

export function RequireAuth({ children, permissions = [] }: RequireAuthProps): React.JSX.Element {
  const { status, user, can } = useAuth();
  const location = useLocation();

  // The startup renewal has not settled. Rendering the sign-in screen here would flash
  // it at someone who turns out to be signed in.
  if (status === 'unknown') {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner label="Checking your session" />
      </div>
    );
  }

  if (status === 'signed_out' || user === null) {
    // `state.from` lets the sign-in screen return the user to where they were going,
    // which matters when a session expires mid-task.
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  /**
   * An account that must replace its initial password can reach exactly one screen.
   * The server enforces the same rule with `requireUsablePassword`; without the
   * redirect the user would simply meet a 403 on every page.
   */
  if (user.mustChangePassword && location.pathname !== '/account/password') {
    return <Navigate to="/account/password" replace />;
  }

  const missing = permissions.filter((permission) => !can(permission));
  if (missing.length > 0) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
