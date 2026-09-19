/**
 * The authentication context and the hook that reads it.
 *
 * Separate from the provider component so that fast refresh keeps working: a module
 * exporting both a component and other values is re-evaluated in a way that loses
 * component state (the `react-refresh/only-export-components` rule).
 */
import { createContext, useContext } from 'react';

import type { AuthenticatedUser, PermissionKey, RoleKey, SessionPayload } from '@sfs/shared';

/**
 * What the sign-in form is waiting on.
 *
 * `mfa_required` and `mfa_enrolment_required` are steps, not errors: the password was
 * correct, and there is more to do before a session exists.
 */
export type SignInOutcome =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'mfa_required'; readonly challengeToken: string }
  | { readonly kind: 'mfa_enrolment_required'; readonly enrolmentToken: string };

/**
 * `unknown` while the provider is asking the server whether the refresh cookie still
 * names a live session. Distinguished from `signed_out` so a reload does not flash the
 * sign-in screen at someone who is signed in.
 */
export type AuthStatus = 'unknown' | 'signed_in' | 'signed_out';

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: AuthenticatedUser | null;

  readonly signIn: (credentials: { email: string; password: string }) => Promise<SignInOutcome>;
  readonly completeMfa: (args: {
    challengeToken: string;
    code?: string;
    recoveryCode?: string;
  }) => Promise<void>;
  /** Adopt a session established by another flow, such as enrolment mid-sign-in. */
  readonly adoptSession: (session: SessionPayload) => void;
  readonly signOut: () => Promise<void>;
  /** Re-read `/auth/me`, after a change that alters the caller's own grants. */
  readonly reload: () => Promise<void>;

  /**
   * Whether the signed-in user holds a permission.
   *
   * For deciding what to *render* only. The backend re-reads permissions from the
   * database and decides for itself on every request; hiding a button is a courtesy,
   * never a control.
   */
  readonly can: (permission: PermissionKey) => boolean;
  readonly hasRole: (role: RoleKey) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth() was called outside <AuthProvider>. This is a wiring bug.');
  }
  return value;
}
