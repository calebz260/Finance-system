/**
 * Authentication endpoints.
 *
 * Thin, like every controller in the system: it translates between HTTP and the auth
 * service and holds no policy of its own. What it *does* own is the one thing that is
 * genuinely HTTP-shaped -- where each credential lives on the wire:
 *
 *  - **The access token goes in the response body.** The web client holds it in memory
 *    and sends it as a bearer token. Not a cookie, so it is not attached automatically to
 *    every request and cannot be ridden by a cross-site form post.
 *
 *  - **The refresh token goes in an httpOnly cookie** scoped to `/api/v1/auth`. It is the
 *    long-lived credential, so JavaScript must not be able to read it (an XSS bug then
 *    cannot exfiltrate a month-long session), and the narrow path means the browser does
 *    not attach it to ordinary API calls where it would serve no purpose.
 *
 *  - **Intermediate tokens go in the body**, both directions. They are short-lived, they
 *    are not sessions, and keeping them out of cookies means they cannot be replayed by a
 *    browser that happens to still hold one.
 *
 * Errors are not caught here. The service throws typed `AppError`s and the error handler
 * turns them into the shared envelope, which is what keeps "invalid credentials" and
 * "unknown email" indistinguishable all the way out to the client.
 */
import type { CookieOptions, Request, Response } from 'express';

import type {
  AuthenticatedUser,
  LoginResult,
  MfaEnrolmentCompletedPayload,
  MfaEnrolmentStartPayload,
  PermissionKey,
  RecoveryCodesPayload,
  SessionPayload,
  SessionSummary,
} from '@sfs/shared';

import { config } from '../../config/env.js';
import { NotFoundError, UnauthenticatedError } from '../../lib/errors.js';
import { HttpStatus, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { recordSafely } from '../audit/audit.service.js';
import type {
  ConfirmEnrolmentBody,
  ConfirmOwnEnrolmentBody,
  DisableMfaBody,
  LoginBody,
  SessionIdParams,
  StartEnrolmentBody,
  VerifyMfaBody,
} from './auth.schema.js';
import {
  confirmMfaEnrolment,
  disableMfa,
  issueAccessTokenForSession,
  login,
  regenerateRecoveryCodes,
  resolveEnrolmentToken,
  startMfaEnrolment,
  verifyMfa,
  type SessionCredentials,
} from './auth.service.js';
import { loadUserWithGrants, type LoadedUser, type Principal } from './principal.js';
import {
  SessionRevocationReason,
  listActiveSessions,
  revokeAllSessionsForUser,
  revokeOwnSession,
  rotateRefreshToken,
} from './session.service.js';

/* ------------------------------------------------------------ the refresh cookie */

function refreshCookieOptions(expiresAt?: Date): CookieOptions {
  const { refreshCookie } = config.auth;
  return {
    // Not readable by JavaScript: an XSS bug must not be able to walk off with a session
    // that outlives the page.
    httpOnly: true,
    secure: refreshCookie.secure,
    sameSite: refreshCookie.sameSite,
    path: refreshCookie.path,
    ...(refreshCookie.domain !== undefined ? { domain: refreshCookie.domain } : {}),
    ...(expiresAt !== undefined ? { expires: expiresAt } : {}),
  };
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(config.auth.refreshCookie.name, token, refreshCookieOptions(expiresAt));
}

/**
 * Clear the cookie using the same attributes it was set with. A browser matches on name,
 * domain and path, so a mismatch here would leave a stale cookie in place and the user
 * would appear to still be signed in.
 */
function clearRefreshCookie(res: Response): void {
  res.clearCookie(config.auth.refreshCookie.name, refreshCookieOptions());
}

function readRefreshCookie(req: Request): string {
  const raw: unknown = req.cookies?.[config.auth.refreshCookie.name];
  if (typeof raw !== 'string' || raw === '') {
    throw new UnauthenticatedError('Your session has ended. Please sign in again.');
  }
  return raw;
}

/* ------------------------------------------------------------------ projections */

/** Shared by `/auth/me` and every response that establishes or renews a session. */
function projectUser(user: LoadedUser, mfaSatisfied: boolean): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    mfaSatisfied,
    roleKeys: user.roleKeys,
    // A Set of keys on the way in, a plain array on the wire.
    permissions: [...user.permissions] as PermissionKey[],
  };
}

/**
 * The same projection from the request principal, which names the user slightly
 * differently because it also carries the session and the tenant scope.
 */
function projectPrincipal(principal: Principal): AuthenticatedUser {
  return {
    id: principal.userId,
    email: principal.email,
    firstName: principal.firstName,
    lastName: principal.lastName,
    schoolId: principal.schoolId,
    isSystemAdministrator: principal.isSystemAdministrator,
    mustChangePassword: principal.mustChangePassword,
    mfaEnabled: principal.mfaEnabled,
    mfaSatisfied: principal.mfaSatisfied,
    roleKeys: principal.roleKeys,
    permissions: [...principal.permissions] as PermissionKey[],
  };
}

/**
 * Build the body for a newly established session.
 *
 * The user is re-read here rather than carried out of the sign-in path, so the client is
 * handed exactly the grants the next authenticated request will enforce. If a role was
 * removed between the password check and this line, the client learns the truth now
 * instead of rendering a bursar's menu that every subsequent call refuses.
 */
async function buildSessionPayload(
  credentials: SessionCredentials,
  mfaSatisfied: boolean,
): Promise<SessionPayload> {
  const user = await loadUserWithGrants(credentials.userId);
  if (user === null) {
    throw new UnauthenticatedError('Your session is no longer valid.');
  }

  return {
    accessToken: credentials.accessToken,
    expiresInSeconds: credentials.accessTokenExpiresInSeconds,
    user: projectUser(user, mfaSatisfied),
  };
}

function toSessionSummary(
  session: {
    id: string;
    ipAddress: string | null;
    userAgent: string | null;
    mfaSatisfied: boolean;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  },
  currentSessionId: string,
): SessionSummary {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    mfaSatisfied: session.mfaSatisfied,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** Where the request came from, for lockout bookkeeping and the audit trail. */
function requestOrigin(req: Request): { ipAddress?: string; userAgent?: string } {
  const userAgent = req.header('user-agent');
  return {
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

/* ------------------------------------------------------------------- sign-in */

/**
 * `POST /auth/login`
 *
 * Answers with one of three outcomes. A correct password is not necessarily a session:
 * for a role that requires MFA it is step one of two, and the intermediate token returned
 * has an audience the authentication middleware rejects.
 */
export const loginHandler = async (req: Request, res: Response): Promise<void> => {
  const { body } = validated<{ body: LoginBody }>(req);

  const outcome = await login({
    email: body.email,
    password: body.password,
    ...requestOrigin(req),
  });

  if (outcome.kind === 'mfa_required') {
    const result: LoginResult = {
      status: 'mfa_required',
      challengeToken: outcome.challengeToken,
      expiresInSeconds: outcome.expiresInSeconds,
    };
    sendSuccess(res, result);
    return;
  }

  if (outcome.kind === 'mfa_enrolment_required') {
    const result: LoginResult = {
      status: 'mfa_enrolment_required',
      enrolmentToken: outcome.enrolmentToken,
      expiresInSeconds: outcome.expiresInSeconds,
    };
    sendSuccess(res, result);
    return;
  }

  setRefreshCookie(
    res,
    outcome.credentials.refreshToken,
    outcome.credentials.refreshTokenExpiresAt,
  );
  const session = await buildSessionPayload(outcome.credentials, false);
  sendSuccess(res, { status: 'authenticated', ...session } satisfies LoginResult);
};

/**
 * `POST /auth/mfa/verify`
 *
 * Completes the second factor with either an authenticator code or a recovery code, and
 * establishes the session.
 */
export const verifyMfaHandler = async (req: Request, res: Response): Promise<void> => {
  const { body } = validated<{ body: VerifyMfaBody }>(req);

  const credentials = await verifyMfa({
    challengeToken: body.challengeToken,
    code: body.code,
    recoveryCode: body.recoveryCode,
    ...requestOrigin(req),
  });

  setRefreshCookie(res, credentials.refreshToken, credentials.refreshTokenExpiresAt);
  const session = await buildSessionPayload(credentials, true);
  sendSuccess(res, session);
};

/* ---------------------------------------------------------------- MFA enrolment */

/**
 * `POST /auth/mfa/enrolment/start`
 *
 * Enrolment during a sign-in, for an account whose role requires MFA but has not enrolled
 * yet. Authorised by the enrolment token from `login`, because no session exists.
 */
export const startEnrolmentHandler = async (req: Request, res: Response): Promise<void> => {
  const { body } = validated<{ body: StartEnrolmentBody }>(req);

  const userId = await resolveEnrolmentToken(body.enrolmentToken);
  const offer = await startMfaEnrolment(userId);

  sendSuccess(res, offer satisfies MfaEnrolmentStartPayload);
};

/**
 * `POST /auth/mfa/enrolment/confirm`
 *
 * Confirms enrolment mid-sign-in and establishes the session, so the user is not made to
 * enter their password a second time immediately after enrolling.
 */
export const confirmEnrolmentHandler = async (req: Request, res: Response): Promise<void> => {
  const { body } = validated<{ body: ConfirmEnrolmentBody }>(req);

  const userId = await resolveEnrolmentToken(body.enrolmentToken);
  const result = await confirmMfaEnrolment({
    userId,
    code: body.code,
    establishSessionOnSuccess: true,
    ...requestOrigin(req),
  });

  // `confirmMfaEnrolment` guarantees credentials when asked to establish a session; this
  // guards the type rather than a reachable state.
  if (result.credentials === undefined) {
    throw new UnauthenticatedError('Enrolment completed but no session was created.');
  }

  setRefreshCookie(res, result.credentials.refreshToken, result.credentials.refreshTokenExpiresAt);
  const session = await buildSessionPayload(result.credentials, true);

  sendSuccess(res, {
    recoveryCodes: result.recoveryCodes,
    session,
    reauthenticationRequired: false,
  } satisfies MfaEnrolmentCompletedPayload);
};

/**
 * `POST /auth/mfa/enable/start`
 *
 * Voluntary enrolment by someone who already has a session -- a role that does not
 * mandate MFA choosing to use it anyway.
 */
export const startOwnEnrolmentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const offer = await startMfaEnrolment(principal.userId);
  sendSuccess(res, offer satisfies MfaEnrolmentStartPayload);
};

/**
 * `POST /auth/mfa/enable/confirm`
 *
 * Completes voluntary enrolment. This signs the caller out: their current session never
 * satisfied an MFA challenge, and the design does not allow one to be upgraded in place
 * (see the `Session.mfaSatisfied` note in the schema). Rather than hand back a session
 * that claims a second factor it never proved, every session is revoked and the client is
 * told to sign in again -- which it can now do with the factor just enrolled.
 */
export const confirmOwnEnrolmentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: ConfirmOwnEnrolmentBody }>(req);

  const result = await confirmMfaEnrolment({
    userId: principal.userId,
    code: body.code,
    establishSessionOnSuccess: false,
    ...requestOrigin(req),
  });

  clearRefreshCookie(res);
  sendSuccess(res, {
    recoveryCodes: result.recoveryCodes,
    reauthenticationRequired: true,
  } satisfies MfaEnrolmentCompletedPayload);
};

/**
 * `POST /auth/mfa/disable`
 *
 * Refused outright when a held role mandates MFA, and otherwise requires the password and
 * a current code. Ends every session, since the account's security properties changed.
 */
export const disableMfaHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: DisableMfaBody }>(req);

  await disableMfa({ userId: principal.userId, password: body.password, code: body.code });

  clearRefreshCookie(res);
  res.status(HttpStatus.NO_CONTENT).send();
};

/**
 * `POST /auth/mfa/recovery-codes`
 *
 * Issues a fresh set and invalidates the previous one. Behind `requireMfaSatisfied`, so a
 * session that never proved a second factor cannot mint codes that bypass it.
 */
export const regenerateRecoveryCodesHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const principal = requirePrincipal(req);
  const recoveryCodes = await regenerateRecoveryCodes(principal.userId);
  sendSuccess(res, { recoveryCodes } satisfies RecoveryCodesPayload);
};

/* --------------------------------------------------------------------- sessions */

/**
 * `POST /auth/refresh`
 *
 * Exchanges the refresh cookie for the next token in the chain and a new access token.
 *
 * The cookie is replaced before anything can fail afterwards, because the presented token
 * is consumed the moment rotation succeeds: leaving the old value in the browser would
 * guarantee a reuse-detection revocation on the client's next attempt.
 */
export const refreshHandler = async (req: Request, res: Response): Promise<void> => {
  const presented = readRefreshCookie(req);

  let rotated;
  try {
    rotated = await rotateRefreshToken(presented);
  } catch (error) {
    // Whatever went wrong -- expired, revoked, reused -- the cookie is no longer useful,
    // and leaving it behind would make every later request fail the same way.
    clearRefreshCookie(res);
    throw error;
  }

  setRefreshCookie(res, rotated.refreshToken, rotated.refreshTokenExpiresAt);

  // A deleted or suspended account must not be able to keep renewing: the refresh chain
  // is the one path that does not pass through `authenticate`, so the status check that
  // middleware performs has to be repeated here.
  const user = await loadUserWithGrants(rotated.session.userId);
  if (user?.status !== 'ACTIVE') {
    clearRefreshCookie(res);
    throw new UnauthenticatedError('Your session is no longer valid. Please sign in again.');
  }

  const { accessToken, accessTokenExpiresInSeconds } = await issueAccessTokenForSession({
    userId: user.id,
    sessionId: rotated.session.id,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    mfaSatisfied: rotated.session.mfaSatisfied,
  });

  await recordSafely({
    action: AuditAction.TOKEN_REFRESHED,
    entityType: AuditEntity.SESSION,
    entityId: rotated.session.id,
    actorUserId: user.id,
    schoolId: user.schoolId,
  });

  sendSuccess(res, {
    accessToken,
    expiresInSeconds: accessTokenExpiresInSeconds,
    user: projectUser(user, rotated.session.mfaSatisfied),
  } satisfies SessionPayload);
};

/** `GET /auth/me` -- the caller's identity and the grants in force right now. */
export const meHandler = (req: Request, res: Response): void => {
  const principal = requirePrincipal(req);
  sendSuccess(res, projectPrincipal(principal));
};

/**
 * `POST /auth/logout`
 *
 * Ends the current session only, leaving other devices signed in. Idempotent: calling it
 * on an already-revoked session still clears the cookie and returns success, because
 * "sign me out" failing is never the helpful answer.
 */
export const logoutHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);

  await revokeOwnSession(principal.userId, principal.sessionId, SessionRevocationReason.LOGOUT);
  await recordSafely({
    action: AuditAction.LOGOUT,
    entityType: AuditEntity.SESSION,
    entityId: principal.sessionId,
    actorUserId: principal.userId,
    schoolId: principal.schoolId,
  });

  clearRefreshCookie(res);
  res.status(HttpStatus.NO_CONTENT).send();
};

/**
 * `POST /auth/logout-all`
 *
 * Ends every session including this one -- the "I think someone else is using my account"
 * action, so it deliberately does not spare the caller.
 */
export const logoutAllHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);

  const revoked = await revokeAllSessionsForUser(
    principal.userId,
    SessionRevocationReason.LOGOUT_ALL,
  );
  await recordSafely({
    action: AuditAction.LOGOUT_ALL,
    entityType: AuditEntity.USER,
    entityId: principal.userId,
    actorUserId: principal.userId,
    schoolId: principal.schoolId,
    metadata: { sessionsRevoked: revoked },
  });

  clearRefreshCookie(res);
  sendSuccess(res, { sessionsRevoked: revoked });
};

/** `GET /auth/sessions` -- where this account is currently signed in. */
export const listSessionsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const sessions = await listActiveSessions(principal.userId);
  sendSuccess(
    res,
    sessions.map((session) => toSessionSummary(session, principal.sessionId)),
  );
};

/**
 * `DELETE /auth/sessions/:sessionId`
 *
 * Signs one other device out. A session belonging to another user reads as "not found":
 * the difference between that and a non-existent id is only useful to an attacker.
 */
export const revokeSessionHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: SessionIdParams }>(req);

  const revoked = await revokeOwnSession(
    principal.userId,
    params.sessionId,
    SessionRevocationReason.LOGOUT,
  );
  if (!revoked) {
    throw new NotFoundError('That session was not found.');
  }

  await recordSafely({
    action: AuditAction.LOGOUT,
    entityType: AuditEntity.SESSION,
    entityId: params.sessionId,
    actorUserId: principal.userId,
    schoolId: principal.schoolId,
    metadata: { revokedBySessionId: principal.sessionId },
  });

  // Revoking the session making the request is allowed, and then the cookie must go too.
  if (params.sessionId === principal.sessionId) clearRefreshCookie(res);

  res.status(HttpStatus.NO_CONTENT).send();
};
