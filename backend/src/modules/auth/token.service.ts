/**
 * Token issuing and verification.
 *
 * Two kinds of credential, with deliberately different properties:
 *
 *  - **Access token** — a short-lived JWT naming a session. Stateless to verify, but the
 *    session it names is still re-read on every request, so revocation is immediate. The
 *    token's job is tamper-proof identification and a hard expiry, not to be the sole
 *    source of truth about permissions.
 *
 *  - **Intermediate tokens** — issued between a correct password and a completed MFA
 *    challenge, or to authorise enrolment. These carry a *different audience* from an
 *    access token and are rejected by the authentication middleware. That separation is
 *    the whole point: without it, the token handed out after step one of two-factor
 *    authentication would itself grant access, and MFA would be advisory.
 *
 * Refresh tokens are not JWTs at all. They are opaque random values, stored only as
 * hashes, because they are long-lived and must be revocable and traceable individually.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import { ErrorCode } from '@sfs/shared';

import { config } from '../../config/env.js';
import { UnauthenticatedError } from '../../lib/errors.js';

const ISSUER = 'school-finance-system';

/**
 * Audiences separate the token kinds. A verifier always states which audience it will
 * accept, so a challenge token can never stand in for an access token.
 */
export const TokenAudience = {
  ACCESS: 'sfs:access',
  MFA_CHALLENGE: 'sfs:mfa-challenge',
  MFA_ENROLMENT: 'sfs:mfa-enrolment',
} as const;

export type TokenAudience = (typeof TokenAudience)[keyof typeof TokenAudience];

const secretKey = new TextEncoder().encode(config.auth.accessTokenSecret);

export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly schoolId: string | null;
  readonly isSystemAdministrator: boolean;
  readonly mfaSatisfied: boolean;
  readonly expiresAt: Date;
}

export interface ChallengeTokenClaims {
  readonly userId: string;
  readonly audience: TokenAudience;
  readonly expiresAt: Date;
}

async function sign(
  payload: JWTPayload,
  audience: TokenAudience,
  ttlSeconds: number,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(secretKey);
}

export interface IssueAccessTokenArgs {
  readonly userId: string;
  readonly sessionId: string;
  readonly schoolId: string | null;
  readonly isSystemAdministrator: boolean;
  readonly mfaSatisfied: boolean;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly expiresInSeconds: number;
}

export async function issueAccessToken(args: IssueAccessTokenArgs): Promise<IssuedAccessToken> {
  const ttl = config.auth.accessTokenTtlSeconds;
  const token = await sign(
    {
      sub: args.userId,
      sid: args.sessionId,
      sch: args.schoolId,
      sys: args.isSystemAdministrator,
      mfa: args.mfaSatisfied,
    },
    TokenAudience.ACCESS,
    ttl,
  );

  return {
    token,
    expiresAt: new Date(Date.now() + ttl * 1000),
    expiresInSeconds: ttl,
  };
}

/**
 * Verify an access token.
 *
 * Every failure mode -- bad signature, wrong audience, expiry, missing claim -- becomes
 * the same 401 shape. The distinction that *is* surfaced is expiry, because the web
 * client uses it to decide whether to attempt a silent refresh rather than bouncing the
 * user to the sign-in screen.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, secretKey, {
      issuer: ISSUER,
      audience: TokenAudience.ACCESS,
      algorithms: ['HS256'],
    });
    payload = result.payload;
  } catch (error) {
    const expired = error instanceof Error && error.name === 'JWTExpired';
    throw new UnauthenticatedError(
      expired ? 'Your session has expired. Please sign in again.' : 'Invalid session token.',
      expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
      { cause: error },
    );
  }

  const userId = payload.sub;
  const sessionId = payload.sid;
  if (typeof userId !== 'string' || typeof sessionId !== 'string') {
    throw new UnauthenticatedError('Invalid session token.', ErrorCode.TOKEN_INVALID);
  }

  const schoolClaim = payload.sch;
  const expirySeconds = payload.exp ?? 0;

  return {
    userId,
    sessionId,
    schoolId: typeof schoolClaim === 'string' ? schoolClaim : null,
    isSystemAdministrator: payload.sys === true,
    mfaSatisfied: payload.mfa === true,
    expiresAt: new Date(expirySeconds * 1000),
  };
}

/**
 * Issue the intermediate token for a pending MFA step.
 *
 * It names the user and nothing else: no session exists yet, so there is nothing for it
 * to grant. Short-lived, because it is the credential that sits between "password was
 * correct" and "second factor proved".
 */
export async function issueChallengeToken(args: {
  userId: string;
  audience: typeof TokenAudience.MFA_CHALLENGE | typeof TokenAudience.MFA_ENROLMENT;
}): Promise<{ token: string; expiresInSeconds: number }> {
  const ttl = config.auth.mfaChallengeTtlSeconds;
  const token = await sign({ sub: args.userId }, args.audience, ttl);
  return { token, expiresInSeconds: ttl };
}

/** Verify an intermediate token, insisting on the expected audience. */
export async function verifyChallengeToken(
  token: string,
  audience: typeof TokenAudience.MFA_CHALLENGE | typeof TokenAudience.MFA_ENROLMENT,
): Promise<ChallengeTokenClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, secretKey, {
      issuer: ISSUER,
      audience,
      algorithms: ['HS256'],
    });
    payload = result.payload;
  } catch (error) {
    throw new UnauthenticatedError(
      'This verification step has expired. Please sign in again.',
      ErrorCode.TOKEN_EXPIRED,
      { cause: error },
    );
  }

  if (typeof payload.sub !== 'string') {
    throw new UnauthenticatedError('Invalid verification token.', ErrorCode.TOKEN_INVALID);
  }

  return {
    userId: payload.sub,
    audience,
    expiresAt: new Date((payload.exp ?? 0) * 1000),
  };
}
