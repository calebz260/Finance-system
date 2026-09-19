/**
 * Access and intermediate tokens.
 *
 * The property that matters most here is audience separation. The token handed out
 * after step one of two-factor authentication must not be usable as a session token —
 * if it were, MFA would be advisory, because anyone holding a correct password could
 * simply present the challenge token instead of completing the challenge.
 */
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@sfs/shared';

import { AppError } from '../../src/lib/errors.js';
import {
  TokenAudience,
  issueAccessToken,
  issueChallengeToken,
  verifyAccessToken,
  verifyChallengeToken,
} from '../../src/modules/auth/token.service.js';

const SUBJECT = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  schoolId: '33333333-3333-4333-8333-333333333333',
  isSystemAdministrator: false,
  mfaSatisfied: true,
};

/** The error code an AppError carried, for assertions that care about the code. */
async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('Expected the operation to reject, but it resolved.');
}

describe('access tokens', () => {
  it('round-trips the claims the request pipeline needs', async () => {
    const issued = await issueAccessToken(SUBJECT);
    const claims = await verifyAccessToken(issued.token);

    expect(claims.userId).toBe(SUBJECT.userId);
    expect(claims.sessionId).toBe(SUBJECT.sessionId);
    expect(claims.schoolId).toBe(SUBJECT.schoolId);
    expect(claims.mfaSatisfied).toBe(true);
    expect(claims.isSystemAdministrator).toBe(false);
  });

  it('carries no permissions, so a grant change cannot be outrun by a stale token', async () => {
    const issued = await issueAccessToken(SUBJECT);
    const [, payload] = issued.token.split('.') as [string, string, string];
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    expect(Object.keys(decoded as object).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'mfa', 'sch', 'sid', 'sub', 'sys'].sort(),
    );
  });

  it('reports the configured lifetime', async () => {
    const issued = await issueAccessToken(SUBJECT);
    // 15 minutes by default; the test environment does not override it.
    expect(issued.expiresInSeconds).toBe(15 * 60);
  });

  it('rejects a token with a tampered payload', async () => {
    const issued = await issueAccessToken(SUBJECT);
    const [header, , signature] = issued.token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...SUBJECT, sub: 'someone-else', sys: true }),
    ).toString('base64url');

    expect(await codeOf(verifyAccessToken(`${header}.${forged}.${signature}`))).toBe(
      ErrorCode.TOKEN_INVALID,
    );
  });

  it('rejects a token signed with a different key', async () => {
    const foreign = await new SignJWT({ sub: SUBJECT.userId, sid: SUBJECT.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('school-finance-system')
      .setAudience(TokenAudience.ACCESS)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('an-entirely-different-signing-key-0123456789'));

    expect(await codeOf(verifyAccessToken(foreign))).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('distinguishes expiry, which the client uses to decide whether to refresh', async () => {
    const expired = await new SignJWT({ sub: SUBJECT.userId, sid: SUBJECT.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('school-finance-system')
      .setAudience(TokenAudience.ACCESS)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode('test-only-access-token-secret-0123456789abcdef'));

    expect(await codeOf(verifyAccessToken(expired))).toBe(ErrorCode.TOKEN_EXPIRED);
  });

  it('rejects an access token that is missing its session claim', async () => {
    const sessionless = await new SignJWT({ sub: SUBJECT.userId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('school-finance-system')
      .setAudience(TokenAudience.ACCESS)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('test-only-access-token-secret-0123456789abcdef'));

    expect(await codeOf(verifyAccessToken(sessionless))).toBe(ErrorCode.TOKEN_INVALID);
  });
});

describe('audience separation', () => {
  it('refuses an MFA challenge token where an access token is required', async () => {
    // Without this, completing the second factor would be optional for anyone who
    // noticed that step one already returns a usable token.
    const { token } = await issueChallengeToken({
      userId: SUBJECT.userId,
      audience: TokenAudience.MFA_CHALLENGE,
    });

    expect(await codeOf(verifyAccessToken(token))).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('refuses an enrolment token where a challenge token is required, and the reverse', async () => {
    const enrolment = await issueChallengeToken({
      userId: SUBJECT.userId,
      audience: TokenAudience.MFA_ENROLMENT,
    });
    const challenge = await issueChallengeToken({
      userId: SUBJECT.userId,
      audience: TokenAudience.MFA_CHALLENGE,
    });

    await expect(
      verifyChallengeToken(enrolment.token, TokenAudience.MFA_CHALLENGE),
    ).rejects.toThrow();
    await expect(
      verifyChallengeToken(challenge.token, TokenAudience.MFA_ENROLMENT),
    ).rejects.toThrow();
  });

  it('refuses an access token where a challenge token is required', async () => {
    const issued = await issueAccessToken(SUBJECT);

    await expect(verifyChallengeToken(issued.token, TokenAudience.MFA_CHALLENGE)).rejects.toThrow();
  });

  it('accepts a challenge token for its own audience and names the user', async () => {
    const { token, expiresInSeconds } = await issueChallengeToken({
      userId: SUBJECT.userId,
      audience: TokenAudience.MFA_CHALLENGE,
    });

    const claims = await verifyChallengeToken(token, TokenAudience.MFA_CHALLENGE);

    expect(claims.userId).toBe(SUBJECT.userId);
    expect(claims.audience).toBe(TokenAudience.MFA_CHALLENGE);
    // Short-lived: long enough to open an authenticator app, no longer.
    expect(expiresInSeconds).toBe(5 * 60);
  });

  it('grants nothing beyond naming a user: no session, no school, no privilege', async () => {
    const { token } = await issueChallengeToken({
      userId: SUBJECT.userId,
      audience: TokenAudience.MFA_CHALLENGE,
    });
    const [, payload] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

    expect(decoded.sid).toBeUndefined();
    expect(decoded.sch).toBeUndefined();
    expect(decoded.sys).toBeUndefined();
    expect(decoded.mfa).toBeUndefined();
  });
});
