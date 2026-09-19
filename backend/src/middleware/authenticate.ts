/**
 * Authentication middleware.
 *
 * Establishes who is calling, and refuses the request if anything about that is not
 * currently true. The order of checks is deliberate — each one is a way a previously
 * valid session stops being valid:
 *
 *   1. a bearer token is present and well-formed
 *   2. its signature and expiry hold, and its audience is `access` (not an MFA challenge)
 *   3. the named session exists, is unrevoked and unexpired
 *   4. the user still exists and is ACTIVE
 *   5. if any of the user's roles requires MFA, this session satisfied it
 *
 * Steps 3–5 are what make revocation immediate: a suspended account or a removed role
 * takes effect on the next request rather than when a token happens to expire.
 */
import type { NextFunction, Request, Response } from 'express';

import { ErrorCode, rolesRequireMfa } from '@sfs/shared';

import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { setContextActor } from '../lib/request-context.js';
import { buildPrincipal, loadUserWithGrants } from '../modules/auth/principal.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

const log = createLogger('auth.authenticate');

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header === undefined) return null;

  // Case-insensitive scheme, exactly one space, non-empty token.
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Require a valid, fully-authenticated session.
 *
 * On success, `req.principal` holds the caller's identity, current permissions and
 * tenant scope, and the ambient request context gains the actor so audit entries record
 * who acted without every call site remembering to pass it.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (token === null) {
      throw new UnauthenticatedError('Sign in to continue.', ErrorCode.UNAUTHENTICATED);
    }

    const claims = await verifyAccessToken(token);

    const session = await prisma.session.findUnique({
      where: { id: claims.sessionId },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        revokedReason: true,
        expiresAt: true,
        mfaSatisfied: true,
      },
    });

    // A session whose `userId` disagrees with the token's subject is treated exactly like
    // a missing one: it means the token was minted for a different user.
    if (session?.userId !== claims.userId) {
      throw new UnauthenticatedError('Your session is no longer valid.', ErrorCode.TOKEN_INVALID);
    }
    if (session.revokedAt !== null) {
      // The reason is deliberately not returned: "your session was revoked because token
      // reuse was detected" is information an attacker would find useful.
      log.warn(
        { sessionId: session.id, reason: session.revokedReason },
        'Rejected a request on a revoked session',
      );
      throw new UnauthenticatedError(
        'Your session has ended. Please sign in again.',
        ErrorCode.TOKEN_INVALID,
      );
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthenticatedError(
        'Your session has expired. Please sign in again.',
        ErrorCode.TOKEN_EXPIRED,
      );
    }

    const user = await loadUserWithGrants(claims.userId);
    if (user === null) {
      throw new UnauthenticatedError('Your session is no longer valid.', ErrorCode.TOKEN_INVALID);
    }
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenError(
        'This account is not active. Contact the school administrator.',
        ErrorCode.ACCOUNT_INACTIVE,
        { logContext: { userId: user.id, status: user.status } },
      );
    }

    // MFA is evaluated against the roles held *now*, not at sign-in. Granting someone the
    // Bursar role must not leave them with an authenticated session that never proved a
    // second factor.
    if (rolesRequireMfa(user.roleKeys) && !session.mfaSatisfied) {
      throw new ForbiddenError(
        'This account now requires two-factor authentication. Please sign in again.',
        ErrorCode.MFA_REQUIRED,
        { logContext: { userId: user.id, roleKeys: user.roleKeys } },
      );
    }

    req.principal = buildPrincipal({
      user,
      sessionId: session.id,
      mfaSatisfied: session.mfaSatisfied,
    });

    setContextActor({
      userId: user.id,
      ...(user.schoolId !== null ? { schoolId: user.schoolId } : {}),
    });

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Read the authenticated principal.
 *
 * Throws rather than returning undefined if the route was not wired behind
 * `authenticate` — a missing middleware is a wiring bug that must surface immediately,
 * not become an unauthenticated request that quietly proceeds.
 */
export function requirePrincipal(req: Request): NonNullable<Request['principal']> {
  if (req.principal === undefined) {
    throw new Error(
      'requirePrincipal() was called on a route without the authenticate middleware. This is a wiring bug.',
    );
  }
  return req.principal;
}
