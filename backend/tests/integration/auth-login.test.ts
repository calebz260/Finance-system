/**
 * Sign-in, second factors and brute-force protection, over real HTTP against a real
 * database.
 *
 * These cover the Phase 2 rules that are cheap to state and expensive to get wrong:
 * that an unknown email is indistinguishable from a wrong password, that the four
 * high-privilege roles cannot reach a session on one factor, that a failed second
 * factor counts towards lockout, and that an observed code cannot be used twice.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode, RoleKey } from '@sfs/shared';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';
import {
  TEST_PASSWORD,
  createSchool,
  createTestUser,
  seedRoleCatalogue,
  totpCodeFor,
  type TestUser,
} from './helpers/auth.js';

const app: Express = createApp();

let roleIds = new Map<string, string>();
let schoolId = '';

/** A role that does not require MFA, so one factor reaches a session. */
let parent: TestUser;
/** A role that does require it. */
let bursar: TestUser;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  roleIds = await seedRoleCatalogue();
  schoolId = await createSchool('GSK', 'GS Kicukiro');

  parent = await createTestUser(roleIds, {
    email: 'parent@gskicukiro.invalid',
    roleKeys: [RoleKey.PARENT],
    schoolId,
  });
  bursar = await createTestUser(roleIds, {
    email: 'bursar@gskicukiro.invalid',
    roleKeys: [RoleKey.BURSAR],
    schoolId,
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

function login(email: string, password: string): request.Test {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}

describe('password sign-in', () => {
  it('establishes a session for a role that does not require MFA', async () => {
    const response = await login(parent.email, TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authenticated');
    expect(response.body.data.accessToken).toBeTypeOf('string');
    expect(response.body.data.user.email).toBe(parent.email);
    expect(response.body.data.user.roleKeys).toEqual([RoleKey.PARENT]);
    expect(response.body.data.user.permissions).toContain('own.financials_read');
  });

  it('puts the refresh token in an httpOnly cookie scoped to the auth routes', async () => {
    // Not readable by JavaScript, and not attached to ordinary API calls.
    const response = await login(parent.email, TEST_PASSWORD);
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0] ?? '';

    expect(cookie).toContain('sfs_refresh=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('never returns the refresh token in the body', async () => {
    const response = await login(parent.email, TEST_PASSWORD);
    expect(JSON.stringify(response.body)).not.toContain('sfs_refresh');
    expect(response.body.data.refreshToken).toBeUndefined();
  });

  it('answers identically for an unknown email and a wrong password', async () => {
    // Anything else turns the sign-in form into a way to enumerate every parent and
    // member of staff at the school.
    const unknown = await login('nobody@gskicukiro.invalid', TEST_PASSWORD);
    const wrong = await login(parent.email, 'CompletelyWrong-2026');

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(wrong.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('treats the email address case-insensitively', async () => {
    const response = await login(parent.email.toUpperCase(), TEST_PASSWORD);
    expect(response.status).toBe(200);
  });

  it('refuses an account that is not active, once the password is proved', async () => {
    const suspended = await createTestUser(roleIds, {
      email: 'suspended@gskicukiro.invalid',
      roleKeys: [RoleKey.PARENT],
      schoolId,
      status: 'SUSPENDED',
    });

    const response = await login(suspended.email, TEST_PASSWORD);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.ACCOUNT_INACTIVE);
  });

  it('records both the success and the failure in the audit log', async () => {
    await login(parent.email, TEST_PASSWORD);
    await login(parent.email, 'CompletelyWrong-2026');

    const entries = await prisma.auditLog.findMany({
      where: { entityId: parent.id },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, result: true },
    });

    expect(entries.map((entry) => entry.action)).toContain('auth.login.succeeded');
    expect(entries.map((entry) => entry.action)).toContain('auth.login.failed');
    expect(entries.find((entry) => entry.action === 'auth.login.failed')?.result).toBe('FAILURE');
  });

  it('records a failed attempt on an unknown address without inventing a user', async () => {
    await login('nobody@gskicukiro.invalid', TEST_PASSWORD);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'auth.login.failed', actorUserId: null },
    });

    expect(entry).not.toBeNull();
    expect(entry?.entityId).toBeNull();
  });
});

describe('brute-force protection', () => {
  it('locks the account after the configured number of consecutive failures', async () => {
    // MAX_FAILED_LOGIN_ATTEMPTS is 5 in the test environment.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(parent.email, `WrongPassword-${String(attempt)}`);
    }

    const locked = await login(parent.email, TEST_PASSWORD);

    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
  });

  it('refuses the correct password while the lock is in force', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(parent.email, 'WrongPassword-2026');
    }

    const response = await login(parent.email, TEST_PASSWORD);
    expect(response.body.error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
  });

  it('counts in the database, so a restart does not reset it', async () => {
    await login(parent.email, 'WrongPassword-2026');
    await login(parent.email, 'WrongPassword-2026');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: parent.id },
      select: { failedLoginAttempts: true },
    });
    expect(user.failedLoginAttempts).toBe(2);
  });

  it('clears the counter on a completed sign-in', async () => {
    await login(parent.email, 'WrongPassword-2026');
    await login(parent.email, TEST_PASSWORD);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: parent.id },
      select: { failedLoginAttempts: true, lockedUntil: true, lastLoginAt: true },
    });
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('audits the lockout itself, not just the failures', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(parent.email, 'WrongPassword-2026');
    }

    const lock = await prisma.auditLog.findFirst({
      where: { action: 'auth.account.locked', entityId: parent.id },
    });
    expect(lock).not.toBeNull();
  });

  it('records a sign-in attempt made while locked', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(parent.email, 'WrongPassword-2026');
    }
    await login(parent.email, TEST_PASSWORD);

    const blocked = await prisma.auditLog.findFirst({
      where: { action: 'auth.login.blocked_locked', entityId: parent.id },
    });
    expect(blocked).not.toBeNull();
  });
});

describe('MFA-required roles', () => {
  it('returns a challenge rather than a session when the password is correct', async () => {
    const response = await login(bursar.email, TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('mfa_required');
    expect(response.body.data.challengeToken).toBeTypeOf('string');
    expect(response.body.data.accessToken).toBeUndefined();
  });

  it('creates no session until the second factor is proved', async () => {
    await login(bursar.email, TEST_PASSWORD);

    expect(await prisma.session.count({ where: { userId: bursar.id } })).toBe(0);
  });

  it('refuses the challenge token as a bearer token', async () => {
    // If this passed, MFA would be decorative: step one already hands out a token.
    const challenge = await login(bursar.email, TEST_PASSWORD);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${challenge.body.data.challengeToken as string}`);

    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('establishes a session once a valid code is presented', async () => {
    const challenge = await login(bursar.email, TEST_PASSWORD);

    const response = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: challenge.body.data.challengeToken,
        code: totpCodeFor(bursar.mfaSecret!),
      });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTypeOf('string');
    expect(response.body.data.user.mfaSatisfied).toBe(true);

    const session = await prisma.session.findFirstOrThrow({ where: { userId: bursar.id } });
    expect(session.mfaSatisfied).toBe(true);
  });

  it('refuses a wrong code and counts it towards the lockout', async () => {
    // Six digits is a million guesses. Without this, MFA would be the one credential an
    // attacker could brute-force without limit.
    const challenge = await login(bursar.email, TEST_PASSWORD);

    const response = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.body.data.challengeToken, code: '000000' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(ErrorCode.MFA_INVALID);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: bursar.id },
      select: { failedLoginAttempts: true },
    });
    expect(user.failedLoginAttempts).toBe(1);
  });

  it('does not clear the lockout counter merely because the password was right', async () => {
    // Otherwise an attacker holding a correct password but no authenticator resets the
    // counter on every attempt and never reaches the threshold.
    await login(bursar.email, 'WrongPassword-2026');
    await login(bursar.email, TEST_PASSWORD);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: bursar.id },
      select: { failedLoginAttempts: true },
    });
    expect(user.failedLoginAttempts).toBe(1);
  });

  it('refuses a code that has already been used', async () => {
    const code = totpCodeFor(bursar.mfaSecret!);

    const first = await login(bursar.email, TEST_PASSWORD);
    const accepted = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: first.body.data.challengeToken, code });
    expect(accepted.status).toBe(200);

    const second = await login(bursar.email, TEST_PASSWORD);
    const replayed = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: second.body.data.challengeToken, code });

    expect(replayed.status).toBe(401);
    expect(replayed.body.error.code).toBe(ErrorCode.MFA_INVALID);
  });

  it('refuses a challenge token that names a different account', async () => {
    const bursarChallenge = await login(bursar.email, TEST_PASSWORD);
    const otherBursar = await createTestUser(roleIds, {
      email: 'bursar.two@gskicukiro.invalid',
      roleKeys: [RoleKey.BURSAR],
      schoolId,
    });

    // A code from the other account's authenticator against this account's challenge.
    const response = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: bursarChallenge.body.data.challengeToken,
        code: totpCodeFor(otherBursar.mfaSecret!),
      });

    expect(response.status).toBe(401);
  });

  it('requires exactly one of a code and a recovery code', async () => {
    const challenge = await login(bursar.email, TEST_PASSWORD);

    const neither = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.body.data.challengeToken });
    expect(neither.status).toBe(400);

    const both = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: challenge.body.data.challengeToken,
        code: totpCodeFor(bursar.mfaSecret!),
        recoveryCode: 'AC3EF-HJK4M-NPQ6R-TUVWX',
      });
    expect(both.status).toBe(400);
  });
});

describe('recovery codes', () => {
  const RECOVERY_CODE = 'AC3EF-HJK4M-NPQ6R-TUVWX';
  let withCodes: TestUser;

  beforeEach(async () => {
    withCodes = await createTestUser(roleIds, {
      email: 'finance@gskicukiro.invalid',
      roleKeys: [RoleKey.FINANCE_MANAGER],
      schoolId,
      recoveryCodes: [RECOVERY_CODE],
    });
  });

  it('signs in with a recovery code when the authenticator is unavailable', async () => {
    const challenge = await login(withCodes.email, TEST_PASSWORD);

    const response = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.body.data.challengeToken, recoveryCode: RECOVERY_CODE });

    expect(response.status).toBe(200);
    expect(response.body.data.user.mfaSatisfied).toBe(true);
  });

  it('accepts the code however the user typed it off paper', async () => {
    const challenge = await login(withCodes.email, TEST_PASSWORD);

    const response = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: challenge.body.data.challengeToken,
        recoveryCode: RECOVERY_CODE.toLowerCase().replace(/-/g, ''),
      });

    expect(response.status).toBe(200);
  });

  it('consumes the code, so it cannot be used a second time', async () => {
    const first = await login(withCodes.email, TEST_PASSWORD);
    await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: first.body.data.challengeToken, recoveryCode: RECOVERY_CODE });

    const second = await login(withCodes.email, TEST_PASSWORD);
    const reused = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: second.body.data.challengeToken, recoveryCode: RECOVERY_CODE });

    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe(ErrorCode.MFA_INVALID);
  });

  it('records the use, because it matters during an incident', async () => {
    const challenge = await login(withCodes.email, TEST_PASSWORD);
    await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.body.data.challengeToken, recoveryCode: RECOVERY_CODE });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'auth.mfa.recovery_code_used', entityId: withCodes.id },
    });
    expect(entry).not.toBeNull();
  });
});

describe('enrolment forced at sign-in', () => {
  let unenrolled: TestUser;

  beforeEach(async () => {
    unenrolled = await createTestUser(roleIds, {
      email: 'newadmin@gskicukiro.invalid',
      roleKeys: [RoleKey.SCHOOL_ADMIN],
      schoolId,
      enrolMfa: false,
    });
  });

  it('routes an unenrolled high-privilege account into enrolment, not into a session', async () => {
    const response = await login(unenrolled.email, TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('mfa_enrolment_required');
    expect(response.body.data.enrolmentToken).toBeTypeOf('string');
    expect(await prisma.session.count({ where: { userId: unenrolled.id } })).toBe(0);
  });

  it('completes enrolment and establishes the session in one step', async () => {
    const challenge = await login(unenrolled.email, TEST_PASSWORD);
    const enrolmentToken = challenge.body.data.enrolmentToken as string;

    const started = await request(app)
      .post('/api/v1/auth/mfa/enrolment/start')
      .send({ enrolmentToken });

    expect(started.status).toBe(200);
    expect(started.body.data.secret).toBeTypeOf('string');
    expect(started.body.data.otpauthUri).toContain('otpauth://totp/');

    const confirmed = await request(app)
      .post('/api/v1/auth/mfa/enrolment/confirm')
      .send({ enrolmentToken, code: totpCodeFor(started.body.data.secret as string) });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.recoveryCodes).toHaveLength(10);
    expect(confirmed.body.data.session.accessToken).toBeTypeOf('string');
    expect(confirmed.body.data.session.user.mfaSatisfied).toBe(true);
  });

  it('keeps the secret pending until a valid code proves the user holds it', async () => {
    // Activating on issue would let an abandoned enrolment lock the account out of its
    // own second factor.
    const challenge = await login(unenrolled.email, TEST_PASSWORD);
    await request(app)
      .post('/api/v1/auth/mfa/enrolment/start')
      .send({ enrolmentToken: challenge.body.data.enrolmentToken });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: unenrolled.id },
      select: { mfaEnabled: true, mfaSecretEncrypted: true, mfaPendingSecretEncrypted: true },
    });

    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaSecretEncrypted).toBeNull();
    expect(user.mfaPendingSecretEncrypted).not.toBeNull();
  });

  it('refuses a wrong confirmation code', async () => {
    const challenge = await login(unenrolled.email, TEST_PASSWORD);
    const enrolmentToken = challenge.body.data.enrolmentToken as string;
    await request(app).post('/api/v1/auth/mfa/enrolment/start').send({ enrolmentToken });

    const response = await request(app)
      .post('/api/v1/auth/mfa/enrolment/confirm')
      .send({ enrolmentToken, code: '000000' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(ErrorCode.MFA_INVALID);
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const challenge = await login(unenrolled.email, TEST_PASSWORD);
    const enrolmentToken = challenge.body.data.enrolmentToken as string;
    const started = await request(app)
      .post('/api/v1/auth/mfa/enrolment/start')
      .send({ enrolmentToken });
    await request(app)
      .post('/api/v1/auth/mfa/enrolment/confirm')
      .send({ enrolmentToken, code: totpCodeFor(started.body.data.secret as string) });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: unenrolled.id },
      select: { mfaSecretEncrypted: true },
    });

    expect(user.mfaSecretEncrypted).not.toContain(started.body.data.secret);
    expect(user.mfaSecretEncrypted?.startsWith('v1.')).toBe(true);
  });
});
