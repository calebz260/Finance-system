/**
 * Sign-in and multi-factor authentication.
 *
 * Three properties this code is built around:
 *
 *  - **An unknown email and a wrong password are indistinguishable.** Same error code,
 *    same message, and comparable work done — the unknown-user path verifies against a
 *    throwaway hash so the response time does not reveal whether the account exists.
 *    Without that, the sign-in form becomes a way to enumerate every parent and staff
 *    member at the school.
 *
 *  - **MFA is not advisory.** A correct password for a Bursar, Finance Manager, School
 *    Administrator or Super Administrator yields an intermediate token with a different
 *    audience, which the authentication middleware rejects. There is no session until the
 *    second factor is proved, and an account whose role requires MFA but has not enrolled
 *    is routed into enrolment rather than let through.
 *
 *  - **Failed second factors count towards lockout.** Otherwise MFA would be the one
 *    credential an attacker could brute-force without limit, and six digits is only a
 *    million guesses.
 */
import { ErrorCode, type RoleKey, rolesRequireMfa } from '@sfs/shared';

import { config } from '../../config/env.js';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  hashRecoveryCode,
} from '../../lib/crypto.js';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  UnauthenticatedError,
} from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { buildTotpUri, generateTotpSecret, verifyTotp } from '../../lib/totp.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record, recordSafely } from '../audit/audit.service.js';
import { loadUserWithGrants } from './principal.js';
import {
  SessionRevocationReason,
  createSession,
  revokeAllSessionsForUser,
} from './session.service.js';
import {
  TokenAudience,
  issueAccessToken,
  issueChallengeToken,
  verifyChallengeToken,
} from './token.service.js';

const log = createLogger('auth.service');

/** How many single-use recovery codes are issued when MFA is enabled. */
const RECOVERY_CODE_COUNT = 10;

/**
 * A throwaway hash used to equalise the work done when the email is unknown.
 *
 * Computed once, lazily, from a random password nobody holds. The unknown-user path
 * verifies the submitted password against it, so an attacker cannot tell existing from
 * non-existing accounts by timing the response.
 */
let decoyHashPromise: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword(
    `decoy-${Date.now().toString(36)}-${Math.random().toString(36)}`,
  );
  return decoyHashPromise;
}

export interface SessionCredentials {
  readonly accessToken: string;
  readonly accessTokenExpiresInSeconds: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
  /**
   * Who the credentials were minted for. Carried explicitly so a caller building the
   * response does not have to re-verify the access token to find out, and cannot
   * accidentally describe one user while handing out a token for another.
   */
  readonly userId: string;
}

export type LoginOutcome =
  | { readonly kind: 'authenticated'; readonly credentials: SessionCredentials }
  | {
      readonly kind: 'mfa_required';
      readonly challengeToken: string;
      readonly expiresInSeconds: number;
    }
  | {
      readonly kind: 'mfa_enrolment_required';
      readonly enrolmentToken: string;
      readonly expiresInSeconds: number;
    };

export interface LoginArgs {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** Identical for an unknown email and a wrong password. */
function invalidCredentials(): UnauthenticatedError {
  return new UnauthenticatedError(
    'The email address or password is incorrect.',
    ErrorCode.INVALID_CREDENTIALS,
  );
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Record a failed attempt and lock the account once the threshold is reached.
 *
 * The counter is incremented in the database rather than in memory so it survives a
 * restart and is shared across instances — an attacker must not be able to reset it by
 * waiting for a deploy.
 */
async function registerFailedAttempt(user: {
  id: string;
  failedLoginAttempts: number;
}): Promise<void> {
  const attempts = user.failedLoginAttempts + 1;
  const shouldLock = attempts >= config.auth.maxFailedLoginAttempts;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: attempts,
      ...(shouldLock ? { lockedUntil: new Date(Date.now() + config.auth.accountLockMs) } : {}),
    },
  });

  if (shouldLock) {
    await recordSafely({
      action: AuditAction.ACCOUNT_LOCKED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: `Locked after ${String(attempts)} consecutive failed attempts.`,
      actorUserId: user.id,
      metadata: { lockMinutes: config.auth.accountLockMs / 60_000 },
    });
  }
}

async function clearFailedAttempts(userId: string, ipAddress?: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress ?? null,
    },
  });
}

/**
 * Verify an email and password, then decide what the caller must do next.
 *
 * Returns one of three outcomes rather than throwing for the MFA cases, because "correct
 * password, second factor needed" is a successful step, not an error.
 */
export async function login(args: LoginArgs): Promise<LoginOutcome> {
  const email = normaliseEmail(args.email);

  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      status: true,
      schoolId: true,
      isSystemAdministrator: true,
      mfaEnabled: true,
      failedLoginAttempts: true,
      lockedUntil: true,
    },
  });

  if (user === null) {
    // Same shape and comparable cost as a wrong password.
    await verifyPassword(args.password, await decoyHash());
    await recordSafely({
      action: AuditAction.LOGIN_FAILED,
      entityType: AuditEntity.USER,
      result: 'FAILURE',
      reason: 'No account exists for the submitted email address.',
      metadata: { attemptedEmail: email },
    });
    throw invalidCredentials();
  }

  // Checked before verifying the password: a locked account should not cost the server an
  // Argon2id hash per attempt. It does mean a locked account is identifiable, which is
  // the accepted trade -- lockout is already observable by its effect on the real user.
  if (user.lockedUntil !== null && user.lockedUntil > new Date()) {
    await recordSafely({
      action: AuditAction.LOGIN_BLOCKED_LOCKED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: 'Sign-in attempted while the account was locked.',
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw new UnauthenticatedError(
      'This account is temporarily locked after too many failed attempts. Try again later or contact the school administrator.',
      ErrorCode.ACCOUNT_LOCKED,
    );
  }

  const passwordCorrect = await verifyPassword(args.password, user.passwordHash);
  if (!passwordCorrect) {
    await registerFailedAttempt(user);
    await recordSafely({
      action: AuditAction.LOGIN_FAILED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: 'Incorrect password.',
      actorUserId: user.id,
      schoolId: user.schoolId,
      metadata: { failedAttempts: user.failedLoginAttempts + 1 },
    });
    throw invalidCredentials();
  }

  // Status is checked only after the password is proved. Telling an unauthenticated
  // caller that an account is suspended would leak which addresses are registered;
  // telling the account's real owner is useful, and they have now authenticated.
  if (user.status !== 'ACTIVE') {
    await recordSafely({
      action: AuditAction.LOGIN_BLOCKED_INACTIVE,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: `Account status is ${user.status}.`,
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw new ForbiddenError(
      'This account is not active. Contact the school administrator.',
      ErrorCode.ACCOUNT_INACTIVE,
    );
  }

  // Opportunistic upgrade: if the stored hash predates a raised cost policy, replace it
  // now that the plaintext is in hand. Failure here must not block the sign-in.
  if (needsRehash(user.passwordHash)) {
    try {
      const upgraded = await hashPassword(args.password);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
      log.info({ userId: user.id }, 'Upgraded a password hash to the current cost parameters');
    } catch (error) {
      log.warn({ err: error, userId: user.id }, 'Could not upgrade a password hash');
    }
  }

  const grants = await loadUserWithGrants(user.id);
  if (grants === null) throw invalidCredentials();

  const mfaRequired = rolesRequireMfa(grants.roleKeys);

  if (mfaRequired && !user.mfaEnabled) {
    // A role requiring MFA was granted to an account that has not enrolled. Enrolment is
    // mandatory rather than optional, so the account is routed into it instead of being
    // admitted on one factor.
    const { token, expiresInSeconds } = await issueChallengeToken({
      userId: user.id,
      audience: TokenAudience.MFA_ENROLMENT,
    });
    await recordSafely({
      action: AuditAction.MFA_ENROLMENT_STARTED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      reason: 'Password verified; enrolment required before access is granted.',
      actorUserId: user.id,
      schoolId: user.schoolId,
      metadata: { roleKeys: [...grants.roleKeys] },
    });
    return { kind: 'mfa_enrolment_required', enrolmentToken: token, expiresInSeconds };
  }

  if (user.mfaEnabled) {
    const { token, expiresInSeconds } = await issueChallengeToken({
      userId: user.id,
      audience: TokenAudience.MFA_CHALLENGE,
    });
    await recordSafely({
      action: AuditAction.MFA_CHALLENGE_ISSUED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      reason: 'Password verified; awaiting the second factor.',
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    return { kind: 'mfa_required', challengeToken: token, expiresInSeconds };
  }

  // Cleared only once the sign-in is actually complete -- which, for this branch, is now.
  //
  // Doing it immediately after the password check instead would break lockout for every
  // MFA account: an attacker holding a correct password but no authenticator could reset
  // the counter to zero on each attempt (sign in, guess one code, repeat) and never reach
  // the threshold, leaving six digits brute-forceable. The MFA paths clear the counter in
  // `verifyMfa` and `confirmMfaEnrolment`, on the same principle. `lastLoginAt` follows
  // the same rule: it means "completed a sign-in", not "got the password right".
  await clearFailedAttempts(user.id, args.ipAddress);

  const credentials = await establishSession({
    userId: user.id,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    mfaSatisfied: false,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });

  await record({
    action: AuditAction.LOGIN_SUCCEEDED,
    entityType: AuditEntity.USER,
    entityId: user.id,
    actorUserId: user.id,
    schoolId: user.schoolId,
    metadata: { sessionId: credentials.sessionId, mfaSatisfied: false },
  });

  return { kind: 'authenticated', credentials };
}

/** Create the session and its first access/refresh pair. */
async function establishSession(args: {
  userId: string;
  schoolId: string | null;
  isSystemAdministrator: boolean;
  mfaSatisfied: boolean;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}): Promise<SessionCredentials> {
  const created = await createSession({
    userId: args.userId,
    schoolId: args.schoolId,
    mfaSatisfied: args.mfaSatisfied,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });

  const access = await issueAccessToken({
    userId: args.userId,
    sessionId: created.session.id,
    schoolId: args.schoolId,
    isSystemAdministrator: args.isSystemAdministrator,
    mfaSatisfied: args.mfaSatisfied,
  });

  return {
    accessToken: access.token,
    accessTokenExpiresInSeconds: access.expiresInSeconds,
    refreshToken: created.refreshToken,
    refreshTokenExpiresAt: created.refreshTokenExpiresAt,
    sessionId: created.session.id,
    userId: args.userId,
  };
}

/** Re-issue an access token for an existing session, after a refresh rotation. */
export async function issueAccessTokenForSession(args: {
  userId: string;
  sessionId: string;
  schoolId: string | null;
  isSystemAdministrator: boolean;
  mfaSatisfied: boolean;
}): Promise<{ accessToken: string; accessTokenExpiresInSeconds: number }> {
  const access = await issueAccessToken(args);
  return { accessToken: access.token, accessTokenExpiresInSeconds: access.expiresInSeconds };
}

/* ------------------------------------------------------------- MFA verification */

export interface VerifyMfaArgs {
  readonly challengeToken: string;
  /** A six-digit TOTP code, or a recovery code. Exactly one must be supplied. */
  readonly code?: string | undefined;
  readonly recoveryCode?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Complete the second factor and establish a session.
 *
 * A failure here increments the same lockout counter as a wrong password: six digits is
 * a million guesses, which is trivial to exhaust if attempts are unlimited.
 */
export async function verifyMfa(args: VerifyMfaArgs): Promise<SessionCredentials> {
  const claims = await verifyChallengeToken(args.challengeToken, TokenAudience.MFA_CHALLENGE);

  const user = await prisma.user.findFirst({
    where: { id: claims.userId, deletedAt: null },
    select: {
      id: true,
      schoolId: true,
      status: true,
      isSystemAdministrator: true,
      mfaEnabled: true,
      mfaSecretEncrypted: true,
      mfaLastUsedCounter: true,
      failedLoginAttempts: true,
      lockedUntil: true,
    },
  });

  if (user === null || !user.mfaEnabled || user.mfaSecretEncrypted === null) {
    throw new UnauthenticatedError(
      'Two-factor authentication is not set up for this account.',
      ErrorCode.MFA_INVALID,
    );
  }
  if (user.status !== 'ACTIVE') {
    throw new ForbiddenError(
      'This account is not active. Contact the school administrator.',
      ErrorCode.ACCOUNT_INACTIVE,
    );
  }
  if (user.lockedUntil !== null && user.lockedUntil > new Date()) {
    throw new UnauthenticatedError(
      'This account is temporarily locked after too many failed attempts.',
      ErrorCode.ACCOUNT_LOCKED,
    );
  }

  const usingRecoveryCode = args.recoveryCode !== undefined && args.recoveryCode.trim() !== '';
  const usingTotp = args.code !== undefined && args.code.trim() !== '';

  if (usingRecoveryCode === usingTotp) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'Provide either an authenticator code or a recovery code.',
    );
  }

  let recoveryCodeUsed = false;

  if (usingRecoveryCode) {
    const codeHash = hashRecoveryCode(args.recoveryCode);
    // Matching on `usedAt: null` in the same statement that consumes the code makes it
    // single-use even under concurrent attempts.
    const consumed = await prisma.mfaRecoveryCode.updateMany({
      where: { userId: user.id, codeHash, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (consumed.count === 0) {
      await registerFailedAttempt(user);
      await recordSafely({
        action: AuditAction.MFA_FAILED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        result: 'FAILURE',
        reason: 'Recovery code was invalid or had already been used.',
        actorUserId: user.id,
        schoolId: user.schoolId,
      });
      throw new UnauthenticatedError('That recovery code is not valid.', ErrorCode.MFA_INVALID);
    }
    recoveryCodeUsed = true;
  } else {
    let secret: string;
    try {
      secret = decryptSecret(user.mfaSecretEncrypted);
    } catch (error) {
      // A secret that will not decrypt means the encryption key changed or the row was
      // tampered with. Neither is the user's fault and neither is recoverable here.
      log.error({ err: error, userId: user.id }, 'Stored MFA secret could not be decrypted');
      throw new UnauthenticatedError(
        'Two-factor authentication could not be verified. Contact the school administrator.',
        ErrorCode.MFA_INVALID,
      );
    }

    const verification = verifyTotp({
      secret,
      code: args.code!,
      lastUsedCounter: user.mfaLastUsedCounter,
    });

    if (!verification.valid) {
      await registerFailedAttempt(user);
      await recordSafely({
        action: AuditAction.MFA_FAILED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        result: 'FAILURE',
        reason: 'Authenticator code was invalid, expired or already used.',
        actorUserId: user.id,
        schoolId: user.schoolId,
      });
      throw new UnauthenticatedError(
        'That code is not valid. Check your authenticator app and try again.',
        ErrorCode.MFA_INVALID,
      );
    }

    // Record the counter so the same code cannot be presented twice within its window.
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaLastUsedCounter: verification.counter ?? null },
    });
  }

  await clearFailedAttempts(user.id, args.ipAddress);

  const credentials = await establishSession({
    userId: user.id,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    mfaSatisfied: true,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });

  await record({
    action: recoveryCodeUsed ? AuditAction.MFA_RECOVERY_CODE_USED : AuditAction.MFA_VERIFIED,
    entityType: AuditEntity.USER,
    entityId: user.id,
    actorUserId: user.id,
    schoolId: user.schoolId,
    metadata: {
      sessionId: credentials.sessionId,
      method: recoveryCodeUsed ? 'recovery_code' : 'totp',
    },
  });
  await record({
    action: AuditAction.LOGIN_SUCCEEDED,
    entityType: AuditEntity.USER,
    entityId: user.id,
    actorUserId: user.id,
    schoolId: user.schoolId,
    metadata: { sessionId: credentials.sessionId, mfaSatisfied: true },
  });

  if (recoveryCodeUsed) {
    const remaining = await prisma.mfaRecoveryCode.count({
      where: { userId: user.id, usedAt: null },
    });
    log.warn(
      { userId: user.id, remainingRecoveryCodes: remaining },
      'A recovery code was used to sign in',
    );
  }

  return credentials;
}

/* --------------------------------------------------------------- MFA enrolment */

export interface MfaEnrolmentOffer {
  /** The base32 secret, for manual entry when a QR code cannot be scanned. */
  readonly secret: string;
  /** `otpauth://` URI the authenticator app consumes, usually via a QR code. */
  readonly otpauthUri: string;
}

/**
 * Begin enrolment: generate a secret, hold it as *pending*, and hand back the details
 * the authenticator app needs.
 *
 * Pending rather than active, because a secret only becomes real once the user has
 * proved they can generate a code from it. Activating immediately would let an abandoned
 * enrolment lock the account out of its own second factor.
 */
export async function startMfaEnrolment(userId: string): Promise<MfaEnrolmentOffer> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, email: true, schoolId: true, mfaEnabled: true },
  });
  if (user === null) {
    throw new UnauthenticatedError('Your session is no longer valid.', ErrorCode.TOKEN_INVALID);
  }
  if (user.mfaEnabled) {
    throw new ConflictError(
      'Two-factor authentication is already enabled for this account.',
      ErrorCode.CONFLICT,
    );
  }

  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaPendingSecretEncrypted: encryptSecret(secret) },
  });

  return {
    secret,
    otpauthUri: buildTotpUri({ secret, accountLabel: user.email }),
  };
}

export interface MfaEnrolmentResult {
  /** Shown once and never retrievable again. Only hashes are stored. */
  readonly recoveryCodes: readonly string[];
  /** Present when enrolment completed as part of a sign-in, so no session existed yet. */
  readonly credentials?: SessionCredentials;
}

/**
 * Confirm enrolment with a code generated from the pending secret.
 *
 * On success the secret becomes active, recovery codes are issued once, and any other
 * session for this user is revoked — enabling a second factor should not leave older
 * single-factor sessions running.
 */
export async function confirmMfaEnrolment(args: {
  userId: string;
  code: string;
  /** True when this completes a sign-in, in which case a session is created. */
  establishSessionOnSuccess: boolean;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}): Promise<MfaEnrolmentResult> {
  const user = await prisma.user.findFirst({
    where: { id: args.userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      schoolId: true,
      status: true,
      isSystemAdministrator: true,
      mfaEnabled: true,
      mfaPendingSecretEncrypted: true,
      failedLoginAttempts: true,
    },
  });

  if (user?.mfaPendingSecretEncrypted == null) {
    throw new DomainError(
      ErrorCode.MFA_ENROLMENT_REQUIRED,
      'Start two-factor setup again: no pending enrolment was found.',
    );
  }
  if (user.status !== 'ACTIVE') {
    throw new ForbiddenError(
      'This account is not active. Contact the school administrator.',
      ErrorCode.ACCOUNT_INACTIVE,
    );
  }

  const secret = decryptSecret(user.mfaPendingSecretEncrypted);
  const verification = verifyTotp({ secret, code: args.code, accountLabel: user.email });

  if (!verification.valid) {
    await registerFailedAttempt(user);
    await recordSafely({
      action: AuditAction.MFA_FAILED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: 'Enrolment code was invalid.',
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw new UnauthenticatedError(
      'That code is not valid. Check your authenticator app and try again.',
      ErrorCode.MFA_INVALID,
    );
  }

  const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaSecretEncrypted: user.mfaPendingSecretEncrypted,
        mfaPendingSecretEncrypted: null,
        mfaEnrolledAt: new Date(),
        mfaLastUsedCounter: verification.counter ?? null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Replace any codes from a previous enrolment: codes are tied to a secret, and a
    // stale code must not unlock a newly enrolled factor.
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({
      data: plainCodes.map((code) => ({ userId: user.id, codeHash: hashRecoveryCode(code) })),
    });

    await record(
      {
        action: AuditAction.MFA_ENROLLED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        actorUserId: user.id,
        schoolId: user.schoolId,
        metadata: { recoveryCodesIssued: plainCodes.length },
      },
      tx,
    );
  });

  // Existing sessions predate the second factor, so they are ended.
  await revokeAllSessionsForUser(user.id, SessionRevocationReason.MFA_CHANGED);

  if (!args.establishSessionOnSuccess) {
    return { recoveryCodes: plainCodes };
  }

  const credentials = await establishSession({
    userId: user.id,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    mfaSatisfied: true,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });

  await record({
    action: AuditAction.LOGIN_SUCCEEDED,
    entityType: AuditEntity.USER,
    entityId: user.id,
    actorUserId: user.id,
    schoolId: user.schoolId,
    metadata: { sessionId: credentials.sessionId, mfaSatisfied: true, viaEnrolment: true },
  });

  return { recoveryCodes: plainCodes, credentials };
}

/**
 * Turn MFA off.
 *
 * Requires the current password *and* a current code: disabling a second factor is
 * exactly what an attacker holding a hijacked session would do, so it must not be
 * possible from the session alone. Refused outright when a held role mandates MFA.
 */
export async function disableMfa(args: {
  userId: string;
  password: string;
  code: string;
}): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: args.userId, deletedAt: null },
    select: {
      id: true,
      schoolId: true,
      passwordHash: true,
      mfaEnabled: true,
      mfaSecretEncrypted: true,
      mfaLastUsedCounter: true,
      failedLoginAttempts: true,
    },
  });

  if (user === null || !user.mfaEnabled || user.mfaSecretEncrypted === null) {
    throw new ConflictError(
      'Two-factor authentication is not enabled for this account.',
      ErrorCode.CONFLICT,
    );
  }

  const grants = await loadUserWithGrants(args.userId);
  if (grants !== null && rolesRequireMfa(grants.roleKeys)) {
    throw new ForbiddenError(
      'Two-factor authentication is required for your role and cannot be turned off.',
      ErrorCode.FORBIDDEN,
      { logContext: { userId: args.userId, roleKeys: [...grants.roleKeys] } },
    );
  }

  if (!(await verifyPassword(args.password, user.passwordHash))) {
    await registerFailedAttempt(user);
    throw new UnauthenticatedError('Your password is incorrect.', ErrorCode.INVALID_CREDENTIALS);
  }

  const verification = verifyTotp({
    secret: decryptSecret(user.mfaSecretEncrypted),
    code: args.code,
    lastUsedCounter: user.mfaLastUsedCounter,
  });
  if (!verification.valid) {
    await registerFailedAttempt(user);
    throw new UnauthenticatedError('That code is not valid.', ErrorCode.MFA_INVALID);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaPendingSecretEncrypted: null,
        mfaEnrolledAt: null,
        mfaLastUsedCounter: null,
      },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await record(
      {
        action: AuditAction.MFA_DISABLED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        actorUserId: user.id,
        schoolId: user.schoolId,
      },
      tx,
    );
  });

  await revokeAllSessionsForUser(user.id, SessionRevocationReason.MFA_CHANGED);
}

/** Issue a fresh set of recovery codes, invalidating the previous set. */
export async function regenerateRecoveryCodes(userId: string): Promise<readonly string[]> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, schoolId: true, mfaEnabled: true },
  });
  if (!user?.mfaEnabled) {
    throw new ConflictError(
      'Two-factor authentication is not enabled for this account.',
      ErrorCode.CONFLICT,
    );
  }

  const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

  await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: plainCodes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    });
    await record(
      {
        action: AuditAction.MFA_RECOVERY_CODES_REGENERATED,
        entityType: AuditEntity.USER,
        entityId: userId,
        actorUserId: userId,
        schoolId: user.schoolId,
        metadata: { count: plainCodes.length },
      },
      tx,
    );
  });

  return plainCodes;
}

/** Verify an enrolment token and return the user it names. */
export async function resolveEnrolmentToken(token: string): Promise<string> {
  const claims = await verifyChallengeToken(token, TokenAudience.MFA_ENROLMENT);
  return claims.userId;
}

/** Roles whose members must use MFA, for display in the UI. */
export function mfaRequiredForRoles(roleKeys: readonly RoleKey[]): boolean {
  return rolesRequireMfa(roleKeys);
}
