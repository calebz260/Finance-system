/**
 * Typed calls to the authentication endpoints.
 *
 * A thin layer over `api-client`, and worth having for one reason: the request and
 * response shapes come from `@sfs/shared`, so a change to the contract on the server
 * fails this file's typecheck rather than surfacing as a blank screen.
 *
 * The three calls that establish or renew a session are marked `anonymous`. They carry
 * their own credential — a password, an intermediate token, or the refresh cookie — and
 * must never trigger the client's refresh-and-retry, which would recurse.
 */
import type {
  AuthenticatedUser,
  LoginResult,
  MfaEnrolmentCompletedPayload,
  MfaEnrolmentStartPayload,
  RecoveryCodesPayload,
  SessionPayload,
  SessionSummary,
} from '@sfs/shared';

import { api } from './api-client';

export function login(credentials: { email: string; password: string }): Promise<LoginResult> {
  return api.post<LoginResult>('/api/v1/auth/login', credentials, { anonymous: true });
}

export function verifyMfa(args: {
  challengeToken: string;
  code?: string;
  recoveryCode?: string;
}): Promise<SessionPayload> {
  return api.post<SessionPayload>('/api/v1/auth/mfa/verify', args, { anonymous: true });
}

export function startEnrolment(enrolmentToken: string): Promise<MfaEnrolmentStartPayload> {
  return api.post<MfaEnrolmentStartPayload>(
    '/api/v1/auth/mfa/enrolment/start',
    { enrolmentToken },
    { anonymous: true },
  );
}

export function confirmEnrolment(args: {
  enrolmentToken: string;
  code: string;
}): Promise<MfaEnrolmentCompletedPayload> {
  return api.post<MfaEnrolmentCompletedPayload>('/api/v1/auth/mfa/enrolment/confirm', args, {
    anonymous: true,
  });
}

/** Exchanges the refresh cookie. Anonymous for the same reason: it *is* the renewal. */
export function refreshSession(): Promise<SessionPayload> {
  return api.post<SessionPayload>('/api/v1/auth/refresh', undefined, { anonymous: true });
}

export function fetchCurrentUser(): Promise<AuthenticatedUser> {
  return api.get<AuthenticatedUser>('/api/v1/auth/me');
}

export function logout(): Promise<void> {
  return api.post<void>('/api/v1/auth/logout');
}

export function logoutEverywhere(): Promise<{ sessionsRevoked: number }> {
  return api.post<{ sessionsRevoked: number }>('/api/v1/auth/logout-all');
}

export function listSessions(): Promise<readonly SessionSummary[]> {
  return api.get<readonly SessionSummary[]>('/api/v1/auth/sessions');
}

export function revokeSession(sessionId: string): Promise<void> {
  return api.delete<void>(`/api/v1/auth/sessions/${sessionId}`);
}

/* ------------------------------------------------------------------- passwords */

export function changePassword(args: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  return api.post<void>('/api/v1/auth/password/change', args);
}

/**
 * Always resolves for any syntactically valid address. The server answers identically
 * whether or not an account exists, and the screen must not infer otherwise.
 */
export function requestPasswordReset(email: string): Promise<{ message: string }> {
  return api.post<{ message: string }>(
    '/api/v1/auth/password/reset-request',
    { email },
    { anonymous: true },
  );
}

export function resetPassword(args: { token: string; newPassword: string }): Promise<void> {
  return api.post<void>('/api/v1/auth/password/reset', args, { anonymous: true });
}

/* ---------------------------------------------------- voluntary MFA management */

export function startOwnEnrolment(): Promise<MfaEnrolmentStartPayload> {
  return api.post<MfaEnrolmentStartPayload>('/api/v1/auth/mfa/enable/start');
}

export function confirmOwnEnrolment(code: string): Promise<MfaEnrolmentCompletedPayload> {
  return api.post<MfaEnrolmentCompletedPayload>('/api/v1/auth/mfa/enable/confirm', { code });
}

export function disableMfa(args: { password: string; code: string }): Promise<void> {
  return api.post<void>('/api/v1/auth/mfa/disable', args);
}

export function regenerateRecoveryCodes(): Promise<RecoveryCodesPayload> {
  return api.post<RecoveryCodesPayload>('/api/v1/auth/mfa/recovery-codes');
}
