/**
 * Changing and resetting a password.
 *
 * The rules that shape this file:
 *
 *  - **Changing a password ends every other session.** A password change is what someone
 *    does *because* they think their account is compromised. If the attacker's session
 *    survived it, the action would be theatre.
 *
 *  - **Asking for a reset reveals nothing.** The response is identical whether or not the
 *    address belongs to an account, because a difference here turns the reset form into
 *    an account-enumeration oracle for every parent and staff member at the school.
 *
 *  - **A reset token is single-use, short-lived and stored as a hash.** It is a credential
 *    that arrives over a channel the school does not control, so a database reader must
 *    not be able to mint one, and a used one must not work twice.
 *
 *  - **Completing a reset clears the lockout.** Otherwise the honest recovery path — "I
 *    forgot it, I locked myself out, I reset it" — still ends at a locked account, and the
 *    user calls the bursar anyway.
 */
import { ErrorCode } from '@sfs/shared';

import { config } from '../../config/env.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { DomainError, UnauthenticatedError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertPasswordAcceptable,
  hashPassword,
  PasswordPolicyError,
  verifyPassword,
} from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record, recordSafely } from '../audit/audit.service.js';
import { getPasswordResetDelivery } from './password-delivery.js';
import { SessionRevocationReason, revokeAllSessionsForUser } from './session.service.js';

const log = createLogger('auth.password');

/**
 * Turn a policy refusal into the domain error the HTTP layer already knows how to
 * render. The message is written for the person choosing the password, so it is safe to
 * show and is the one thing here that genuinely helps them.
 */
function asValidationError(error: unknown): never {
  if (error instanceof PasswordPolicyError) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, error.message, {
      fieldErrors: [{ path: 'body.newPassword', message: error.message }],
    });
  }
  throw error;
}

function applyPolicy(
  newPassword: string,
  identity: { email: string; firstName: string; lastName: string },
): void {
  try {
    assertPasswordAcceptable(newPassword, identity);
  } catch (error) {
    asValidationError(error);
  }
}

/* ------------------------------------------------------------- change (signed in) */

export interface ChangePasswordArgs {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  /**
   * The session making the request. It is kept alive; every other session is ended, so
   * the user is not signed out of the device they are currently using.
   */
  readonly currentSessionId: string;
}

/**
 * Change a password for a signed-in user.
 *
 * The current password is required even though the caller already holds a session: a
 * hijacked session must not be enough to lock the real owner out of their own account.
 */
export async function changePassword(args: ChangePasswordArgs): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: args.userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      schoolId: true,
      passwordHash: true,
    },
  });

  if (user === null) {
    throw new UnauthenticatedError('Your session is no longer valid.', ErrorCode.TOKEN_INVALID);
  }

  if (!(await verifyPassword(args.currentPassword, user.passwordHash))) {
    await recordSafely({
      action: AuditAction.PASSWORD_RESET_FAILED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: 'Current password was incorrect on a password-change attempt.',
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw new UnauthenticatedError(
      'Your current password is incorrect.',
      ErrorCode.INVALID_CREDENTIALS,
    );
  }

  // Checked against the identity so the new password cannot be the user's own name or
  // email, and after the current password is proved so the policy text is only shown to
  // someone who has authenticated.
  applyPolicy(args.newPassword, user);

  // Refused rather than silently accepted: "change your password" that leaves the same
  // password in place is not a change, and the user would believe they had acted.
  if (await verifyPassword(args.newPassword, user.passwordHash)) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'Your new password must be different from your current one.',
      {
        fieldErrors: [
          {
            path: 'body.newPassword',
            message: 'Your new password must be different from your current one.',
          },
        ],
      },
    );
  }

  const passwordHash = await hashPassword(args.newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // Whatever forced the change — an administrator-created account, a seeded
        // password — has now been satisfied.
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });

    await record(
      {
        action: AuditAction.PASSWORD_CHANGED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        actorUserId: user.id,
        schoolId: user.schoolId,
        metadata: { method: 'self_service', sessionsKept: 1 },
      },
      tx,
    );
  });

  // Every other device is signed out; this one is not, because the user is standing in
  // front of it and has just proved the old password.
  const revoked = await revokeAllSessionsForUser(
    user.id,
    SessionRevocationReason.PASSWORD_CHANGED,
    { exceptSessionId: args.currentSessionId },
  );

  log.info({ userId: user.id, sessionsRevoked: revoked }, 'Password changed');
}

/* ----------------------------------------------------------------- reset request */

export interface RequestPasswordResetArgs {
  readonly email: string;
  readonly ipAddress?: string | undefined;
}

/**
 * Begin a reset.
 *
 * Returns void in every case — unknown address, suspended account, success — and the
 * controller answers the same way for all of them. An attacker learns nothing; the owner
 * of a real address gets a link.
 */
export async function requestPasswordReset(args: RequestPasswordResetArgs): Promise<void> {
  const email = args.email.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, email: true, firstName: true, schoolId: true, status: true },
  });

  if (user === null) {
    await recordSafely({
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      entityType: AuditEntity.USER,
      result: 'FAILURE',
      reason: 'No account exists for the submitted email address.',
      metadata: { attemptedEmail: email },
    });
    return;
  }

  // A suspended account is not a route back in. Recorded, because a burst of these is
  // worth seeing.
  if (user.status !== 'ACTIVE') {
    await recordSafely({
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: `Reset requested for an account with status ${user.status}.`,
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    return;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.auth.passwordResetTtlSeconds * 1000);

  await prisma.$transaction(async (tx) => {
    // One live reset at a time. Requesting a second link invalidates the first, so a
    // link left in an old message cannot be used after the user asks again.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        requestedIp: args.ipAddress ?? null,
      },
    });

    await record(
      {
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        actorUserId: user.id,
        schoolId: user.schoolId,
        metadata: { expiresAt: expiresAt.toISOString() },
      },
      tx,
    );
  });

  // Outside the transaction: delivery is a side effect on another system, and holding a
  // database transaction open across it would be wrong in both directions.
  await getPasswordResetDelivery().deliver({
    email: user.email,
    firstName: user.firstName,
    token,
    expiresAt,
  });
}

/* ---------------------------------------------------------------- reset completion */

export interface ResetPasswordArgs {
  readonly token: string;
  readonly newPassword: string;
}

/** Identical for an unknown, expired, already-used or malformed token. */
function invalidResetToken(): DomainError {
  return new DomainError(
    ErrorCode.TOKEN_INVALID,
    'This password reset link is no longer valid. Request a new one.',
  );
}

/**
 * Complete a reset.
 *
 * Every session is ended, including any the attacker may hold: unlike a change, a reset
 * is performed by someone who could not sign in, so there is no session worth sparing.
 */
export async function resetPassword(args: ResetPasswordArgs): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(args.token) },
    select: {
      id: true,
      usedAt: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          schoolId: true,
          status: true,
          deletedAt: true,
        },
      },
    },
  });

  if (stored === null) throw invalidResetToken();

  const { user } = stored;

  if (stored.usedAt !== null) {
    // A second use of a consumed token is either a double-submitted form or someone
    // working from an intercepted message. Worth recording either way.
    await recordSafely({
      action: AuditAction.PASSWORD_RESET_FAILED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: 'A password-reset token was presented after it had already been used.',
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw invalidResetToken();
  }

  if (stored.expiresAt <= new Date()) {
    await recordSafely({
      action: AuditAction.PASSWORD_RESET_FAILED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: 'A password-reset token was presented after it had expired.',
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw invalidResetToken();
  }

  // A token minted before the account was suspended or deleted must not outlive that
  // decision.
  if (user.deletedAt !== null || user.status !== 'ACTIVE') {
    await recordSafely({
      action: AuditAction.PASSWORD_RESET_FAILED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      result: 'FAILURE',
      reason: `Reset completed against an account with status ${user.status}.`,
      actorUserId: user.id,
      schoolId: user.schoolId,
    });
    throw invalidResetToken();
  }

  applyPolicy(args.newPassword, user);

  const passwordHash = await hashPassword(args.newPassword);

  await prisma.$transaction(async (tx) => {
    // Consumed by the same statement that requires it to be unused, so two submissions
    // of the same link cannot both succeed.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) throw invalidResetToken();

    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        // The honest recovery path ends here, so it must not end at a locked account.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await record(
      {
        action: AuditAction.PASSWORD_RESET_COMPLETED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        actorUserId: user.id,
        schoolId: user.schoolId,
      },
      tx,
    );
  });

  // No exception: whoever reset the password could not sign in, so no live session
  // belongs to them.
  const revoked = await revokeAllSessionsForUser(user.id, SessionRevocationReason.PASSWORD_CHANGED);

  log.info({ userId: user.id, sessionsRevoked: revoked }, 'Password reset completed');
}
