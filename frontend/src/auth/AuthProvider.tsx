/**
 * Holds the session for the whole application.
 *
 * Three decisions shape this component:
 *
 *  - **The access token lives in memory, never in web storage.** A token in
 *    `localStorage` is readable by any injected script and outlives the tab that earned
 *    it. The durable half of the session is the httpOnly refresh cookie, which
 *    JavaScript cannot read at all.
 *
 *  - **A reload is not a sign-out.** On mount the provider tries one silent refresh.
 *    Until that settles the status is `unknown`, so the router holds rather than
 *    flashing the sign-in screen at someone who is signed in.
 *
 *  - **A renewal that fails signs the user out locally.** If the refresh cookie is gone
 *    or the session was revoked, continuing to render an authenticated shell would show
 *    a menu where every action returns 401.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AuthenticatedUser, PermissionKey, RoleKey, SessionPayload } from '@sfs/shared';

import * as authApi from '../lib/auth-api';
import { clearAccessToken, setAccessToken, setRefreshHandler } from '../lib/auth-token';
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
  type SignInOutcome,
} from './auth-context';

export interface AuthProviderProps {
  readonly children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);

  // Read inside the refresh handler, which is registered once and must not close over
  // a stale setter chain.
  const mounted = useRef(true);

  const applySession = useCallback((session: SessionPayload): void => {
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus('signed_in');
  }, []);

  const clearSession = useCallback((): void => {
    clearAccessToken();
    setUser(null);
    setStatus('signed_out');
  }, []);

  /**
   * The renewal `api-client` calls when a request comes back with an expired token.
   *
   * Registered once, for the provider's lifetime. Returning null tells the client that
   * no live session remains, and the local state is cleared so the UI agrees.
   */
  useEffect(() => {
    mounted.current = true;

    setRefreshHandler(async () => {
      try {
        const session = await authApi.refreshSession();
        if (mounted.current) applySession(session);
        else setAccessToken(session.accessToken);
        return session.accessToken;
      } catch {
        if (mounted.current) clearSession();
        else clearAccessToken();
        return null;
      }
    });

    return () => {
      mounted.current = false;
      setRefreshHandler(null);
    };
  }, [applySession, clearSession]);

  /**
   * One silent renewal at startup.
   *
   * A 401 here is the ordinary case for a visitor who is not signed in, so it is not
   * reported as an error — it simply resolves the status to `signed_out`.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await authApi.refreshSession();
        if (!cancelled) applySession(session);
      } catch {
        if (!cancelled) clearSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession]);

  const signIn = useCallback(
    async (credentials: { email: string; password: string }): Promise<SignInOutcome> => {
      const result = await authApi.login(credentials);

      if (result.status === 'mfa_required') {
        return { kind: 'mfa_required', challengeToken: result.challengeToken };
      }
      if (result.status === 'mfa_enrolment_required') {
        return { kind: 'mfa_enrolment_required', enrolmentToken: result.enrolmentToken };
      }

      applySession(result);
      return { kind: 'authenticated' };
    },
    [applySession],
  );

  const completeMfa = useCallback(
    async (args: {
      challengeToken: string;
      code?: string;
      recoveryCode?: string;
    }): Promise<void> => {
      applySession(await authApi.verifyMfa(args));
    },
    [applySession],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // "Sign me out" failing is never the helpful answer. The server call is
      // best-effort; the local session is cleared either way, and the access token is
      // short-lived even if the request never landed.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setUser(await authApi.fetchCurrentUser());
    } catch {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signIn,
      completeMfa,
      adoptSession: applySession,
      signOut,
      reload,
      can: (permission: PermissionKey): boolean => user?.permissions.includes(permission) ?? false,
      hasRole: (role: RoleKey): boolean => user?.roleKeys.includes(role) ?? false,
    }),
    [status, user, signIn, completeMfa, applySession, signOut, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
