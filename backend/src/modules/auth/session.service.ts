/**
 * Session lifecycle: creation, refresh-token rotation, and revocation.
 *
 * The interesting part is rotation. Each refresh consumes one token and issues the next,
 * and the consumed token is kept rather than deleted. If a consumed token is presented
 * again, one of two things happened: the legitimate client replayed it (a retry, a
 * double-submitted request), or someone stole it. There is no way to tell which from the
 * request alone — so the whole session is revoked and the event is audited.
 *
 * That is deliberately the strict choice. The alternative, issuing a fresh token and
 * hoping, lets a thief ride along indefinitely: they refresh, the victim refreshes, and
 * both keep working. Making the session collapse turns a silent compromise into a visible
 * one — the user is signed out, which is annoying, and an audit entry exists, which is
 * the point.
 */
import type { SessionModel } from '../../generated/prisma/models.js';
import { config } from '../../config/env.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import { ErrorCode } from '@sfs/shared';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { recordSafely } from '../audit/audit.service.js';

/** Why a session ended. Recorded on the session and surfaced in the audit trail. */
export const SessionRevocationReason = {
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all',
  TOKEN_REUSE_DETECTED: 'token_reuse_detected',
  PASSWORD_CHANGED: 'password_changed',
  ACCOUNT_SUSPENDED: 'account_suspended',
  MFA_CHANGED: 'mfa_changed',
  SUPERSEDED: 'superseded',
} as const;

export type SessionRevocationReason =
  (typeof SessionRevocationReason)[keyof typeof SessionRevocationReason];

export interface CreateSessionArgs {
  readonly userId: string;
  readonly schoolId: string | null;
  readonly mfaSatisfied: boolean;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface CreatedSession {
  readonly session: SessionModel;
  /** The raw refresh token. Returned once, stored only as a hash. */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export async function createSession(
  args: CreateSessionArgs,
  client: PrismaTransactionClient = prisma,
): Promise<CreatedSession> {
  const now = Date.now();
  const expiresAt = new Date(now + config.auth.refreshTokenTtlSeconds * 1000);
  const refreshToken = generateToken();

  const session = await client.session.create({
    data: {
      userId: args.userId,
      schoolId: args.schoolId,
      mfaSatisfied: args.mfaSatisfied,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      expiresAt,
      refreshTokens: {
        create: { tokenHash: hashToken(refreshToken), expiresAt },
      },
    },
  });

  return { session, refreshToken, refreshTokenExpiresAt: expiresAt };
}

export interface RotatedSession {
  readonly session: SessionModel;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

/**
 * Exchange a refresh token for the next one in the chain.
 *
 * Runs in a single transaction so the consume-and-issue pair cannot half-apply, and so
 * two concurrent refreshes cannot both succeed: the partial unique index allowing one
 * unused token per session makes the loser fail rather than fork the chain.
 */
export async function rotateRefreshToken(presentedToken: string): Promise<RotatedSession> {
  const tokenHash = hashToken(presentedToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { session: true },
  });

  if (stored === null) {
    throw new UnauthenticatedError(
      'Your session is no longer valid. Please sign in again.',
      ErrorCode.TOKEN_INVALID,
    );
  }

  // --- reuse detection, before any other check
  if (stored.usedAt !== null) {
    await revokeSession(stored.sessionId, SessionRevocationReason.TOKEN_REUSE_DETECTED);
    await recordSafely({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      entityType: AuditEntity.SESSION,
      entityId: stored.sessionId,
      result: 'FAILURE',
      reason: 'A refresh token was presented after it had already been exchanged.',
      actorUserId: stored.session.userId,
      schoolId: stored.session.schoolId,
      metadata: { refreshTokenId: stored.id, originallyUsedAt: stored.usedAt.toISOString() },
    });

    throw new UnauthenticatedError(
      'Your session was ended for security reasons. Please sign in again.',
      ErrorCode.TOKEN_INVALID,
    );
  }

  const now = new Date();
  if (stored.expiresAt <= now) {
    throw new UnauthenticatedError(
      'Your session has expired. Please sign in again.',
      ErrorCode.TOKEN_EXPIRED,
    );
  }
  if (stored.session.revokedAt !== null) {
    throw new UnauthenticatedError(
      'Your session is no longer valid. Please sign in again.',
      ErrorCode.TOKEN_INVALID,
    );
  }
  if (stored.session.expiresAt <= now) {
    throw new UnauthenticatedError(
      'Your session has expired. Please sign in again.',
      ErrorCode.TOKEN_EXPIRED,
    );
  }

  const nextToken = generateToken();
  // The new token inherits the session's absolute expiry: refreshing extends activity,
  // not the maximum session lifetime, so a stolen token cannot be kept alive forever.
  const nextExpiresAt = stored.session.expiresAt;

  const session = await prisma.$transaction(async (tx) => {
    // Consume before issuing, not after.
    //
    // `refresh_tokens_one_active_per_session` is a unique index over `session_id` where
    // `used_at IS NULL`, so while the presented token is still unused the session already
    // holds its one permitted live token. Inserting the replacement first therefore
    // collides with the very token being rotated, and every refresh fails on a unique
    // violation. Marking the old one used first frees the slot the new row needs.
    //
    // Matching on `usedAt: null` also settles the concurrent case: if another refresh got
    // there first this updates zero rows and the transaction is abandoned, rather than
    // re-consuming a token and forking the chain.
    const consumed = await tx.refreshToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count === 0) {
      throw new UnauthenticatedError(
        'Your session is no longer valid. Please sign in again.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const issued = await tx.refreshToken.create({
      data: {
        sessionId: stored.sessionId,
        tokenHash: hashToken(nextToken),
        expiresAt: nextExpiresAt,
      },
    });

    // Recorded last, so the chain can be walked during an investigation. Safe against
    // `refresh_tokens_replaced_implies_used_check`, because `usedAt` was set above.
    await tx.refreshToken.update({
      where: { id: stored.id },
      data: { replacedById: issued.id },
    });

    return tx.session.update({
      where: { id: stored.sessionId },
      data: { lastSeenAt: now },
    });
  });

  return { session, refreshToken: nextToken, refreshTokenExpiresAt: nextExpiresAt };
}

/**
 * Revoke one session.
 *
 * Idempotent, and it does not overwrite an existing reason: the first reason recorded is
 * the true one, and a later `logout` must not paper over `token_reuse_detected`.
 */
export async function revokeSession(
  sessionId: string,
  reason: SessionRevocationReason,
  client: PrismaTransactionClient = prisma,
): Promise<void> {
  await client.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/**
 * Revoke every live session for a user.
 *
 * Called on "sign out everywhere", on a password change, and whenever an administrator
 * suspends an account or changes its roles — the cases where leaving an existing session
 * running would defeat the action.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  reason: SessionRevocationReason,
  options: { exceptSessionId?: string } = {},
  client: PrismaTransactionClient = prisma,
): Promise<number> {
  const result = await client.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId !== undefined ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/**
 * Revoke one of a user's own sessions, by id.
 *
 * The ownership check is part of the same statement as the revocation rather than a
 * read-then-write: a caller must not be able to end someone else's session by guessing an
 * id, and checking first would leave a window between the check and the update. Returns
 * false when the id does not name a live session belonging to this user, which the caller
 * reports as "not found" -- deliberately not distinguishing "someone else's session"
 * from "no such session", since that difference is only useful to an attacker.
 */
export async function revokeOwnSession(
  userId: string,
  sessionId: string,
  reason: SessionRevocationReason = SessionRevocationReason.LOGOUT,
): Promise<boolean> {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count > 0;
}

/** Live sessions for a user, newest activity first. */
export async function listActiveSessions(userId: string): Promise<SessionModel[]> {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
  });
}
