/**
 * Changing and resetting a password.
 *
 * Three properties carry the weight here, and each has a specific failure it prevents:
 *
 *  - a change ends other sessions, so the action means something when the reason for
 *    taking it is that someone else has the password;
 *  - a reset request says the same thing whoever asks, so the form cannot be used to
 *    discover which addresses have accounts;
 *  - a reset token works exactly once and only before it expires.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode, RoleKey } from '@sfs/shared';

import { createApp } from '../../src/app.js';
import { verifyPassword } from '../../src/lib/password.js';
import { prisma } from '../../src/lib/prisma.js';
import {
  RecordingPasswordResetDelivery,
  setPasswordResetDelivery,
  type PasswordResetDelivery,
} from '../../src/modules/auth/password-delivery.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';
import {
  TEST_PASSWORD,
  bearer,
  createSchool,
  createTestUser,
  seedRoleCatalogue,
  signIn,
  type Session,
  type TestUser,
} from './helpers/auth.js';

const app: Express = createApp();
const NEW_PASSWORD = 'Amaranth-Kettle-Drum-41';

let roleIds = new Map<string, string>();
let schoolId = '';
let parent: TestUser;
let session: Session;
let delivery: RecordingPasswordResetDelivery;
let previousDelivery: PasswordResetDelivery;

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
    firstName: 'Claudine',
    lastName: 'Uwase',
  });
  session = await signIn(app, parent);

  delivery = new RecordingPasswordResetDelivery();
  previousDelivery = setPasswordResetDelivery(delivery);
});

afterEach(() => {
  setPasswordResetDelivery(previousDelivery);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/**
 * The token from the message the service just delivered.
 *
 * Throws rather than asserting non-null: if nothing was delivered, the test that
 * depends on it should say so plainly instead of comparing against `undefined`.
 */
function deliveredToken(): string {
  const message = delivery.last();
  if (message === undefined) {
    throw new Error('Expected a password-reset message to have been delivered, but none was.');
  }
  return message.token;
}

function changePassword(token: string, body: Record<string, unknown>): request.Test {
  return request(app)
    .post('/api/v1/auth/password/change')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

describe('POST /auth/password/change', () => {
  it('changes the password and lets the owner sign in with the new one', async () => {
    const response = await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(204);

    const signedIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: parent.email, password: NEW_PASSWORD });
    expect(signedIn.status).toBe(200);

    const stale = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: parent.email, password: TEST_PASSWORD });
    expect(stale.status).toBe(401);
  });

  it('requires the current password, so a hijacked session is not enough', async () => {
    const response = await changePassword(session.accessToken, {
      currentPassword: 'NotTheCurrentOne-2026',
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
  });

  it('requires a session', async () => {
    const response = await request(app)
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
  });

  it('applies the password policy to the new password', async () => {
    const tooShort = await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'short',
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);

    const common = await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'Password123!',
    });
    expect(common.status).toBe(400);
    expect(common.body.error.message).toMatch(/commonly used/);

    const personal = await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'ClaudineUwase2026',
    });
    expect(personal.status).toBe(400);
    expect(personal.body.error.message).toMatch(/must not contain your name/);
  });

  it('refuses a "change" to the same password', async () => {
    const response = await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/different from your current one/);
  });

  it('ends every other session but keeps the one making the change', async () => {
    const other = await signIn(app, parent);

    await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const kept = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(session));
    expect(kept.status).toBe(200);

    const ended = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(other));
    expect(ended.status).toBe(401);
  });

  it('clears the must-change-password flag', async () => {
    const forced = await createTestUser(roleIds, {
      email: 'newstaff@gskicukiro.invalid',
      roleKeys: [RoleKey.PARENT],
      schoolId,
      mustChangePassword: true,
    });
    const forcedSession = await signIn(app, forced);

    await changePassword(forcedSession.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: forced.id },
      select: { mustChangePassword: true },
    });
    expect(user.mustChangePassword).toBe(false);
  });

  it('stores a new Argon2id hash, never the plaintext', async () => {
    await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: parent.id },
      select: { passwordHash: true, passwordChangedAt: true },
    });

    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(NEW_PASSWORD);
    await expect(verifyPassword(NEW_PASSWORD, user.passwordHash)).resolves.toBe(true);
    expect(user.passwordChangedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('audits the change', async () => {
    await changePassword(session.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.changed', entityId: parent.id },
    });
    expect(entry).not.toBeNull();
  });
});

describe('POST /auth/password/reset-request', () => {
  function requestReset(email: string): request.Test {
    return request(app).post('/api/v1/auth/password/reset-request').send({ email });
  }

  it('accepts the request and sends a link to a real account', async () => {
    const response = await requestReset(parent.email);

    expect(response.status).toBe(202);
    expect(delivery.messages).toHaveLength(1);
    expect(delivery.last()?.email).toBe(parent.email);
    expect(delivery.last()?.token).toBeTypeOf('string');
  });

  it('answers identically for an address with no account', async () => {
    // A different status, body or timing would make the form an account-enumeration
    // oracle for every parent and member of staff.
    const known = await requestReset(parent.email);
    const unknown = await requestReset('nobody@gskicukiro.invalid');

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(delivery.messages).toHaveLength(1);
  });

  it('answers identically for a suspended account, and sends nothing', async () => {
    await prisma.user.update({ where: { id: parent.id }, data: { status: 'SUSPENDED' } });

    const response = await requestReset(parent.email);

    expect(response.status).toBe(202);
    expect(delivery.messages).toHaveLength(0);
  });

  it('never returns the token to the caller', async () => {
    const response = await requestReset(parent.email);

    expect(JSON.stringify(response.body)).not.toContain(deliveredToken());
  });

  it('stores only a hash of the token', async () => {
    await requestReset(parent.email);

    const stored = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: parent.id },
    });
    expect(stored.tokenHash).not.toBe(deliveredToken());
    expect(stored.tokenHash).not.toContain(deliveredToken());
  });

  it('invalidates a previous link when a second is requested', async () => {
    // A link left in an older message must not still work after the user asks again.
    await requestReset(parent.email);
    const first = deliveredToken();
    await requestReset(parent.email);

    const response = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: first, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('records the request', async () => {
    await requestReset(parent.email);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_requested', entityId: parent.id },
    });
    expect(entry).not.toBeNull();
  });
});

describe('POST /auth/password/reset', () => {
  async function tokenFor(user: TestUser): Promise<string> {
    await request(app).post('/api/v1/auth/password/reset-request').send({ email: user.email });
    return deliveredToken();
  }

  function reset(token: string, newPassword: string): request.Test {
    return request(app).post('/api/v1/auth/password/reset').send({ token, newPassword });
  }

  it('sets the new password and lets the owner sign in', async () => {
    const response = await reset(await tokenFor(parent), NEW_PASSWORD);

    expect(response.status).toBe(204);

    const signedIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: parent.email, password: NEW_PASSWORD });
    expect(signedIn.status).toBe(200);
  });

  it('consumes the token, so the link works exactly once', async () => {
    const token = await tokenFor(parent);
    await reset(token, NEW_PASSWORD);

    const second = await reset(token, 'Another-Valid-Password-7');

    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('refuses an expired token', async () => {
    const token = await tokenFor(parent);
    // The whole row is moved into the past: a check constraint enforces
    // `expires_at > created_at`, so backdating only the expiry is not a state the
    // database will accept — which is itself the right behaviour.
    const issuedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.passwordResetToken.updateMany({
      where: { userId: parent.id },
      data: { createdAt: issuedAt, expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000) },
    });

    const response = await reset(token, NEW_PASSWORD);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('refuses an unknown token with the same message as an expired one', async () => {
    const unknown = await reset('a-token-that-was-never-issued', NEW_PASSWORD);
    const token = await tokenFor(parent);
    await reset(token, NEW_PASSWORD);
    const used = await reset(token, NEW_PASSWORD);

    expect(unknown.body.error.code).toBe(used.body.error.code);
    expect(unknown.body.error.message).toBe(used.body.error.message);
  });

  it('applies the password policy', async () => {
    const response = await reset(await tokenFor(parent), 'password123');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('ends every session, since whoever reset it could not sign in', async () => {
    const live = await signIn(app, parent);

    await reset(await tokenFor(parent), NEW_PASSWORD);

    const response = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(live));
    expect(response.status).toBe(401);
  });

  it('clears a lockout, so the honest recovery path actually recovers the account', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: parent.email, password: 'WrongPassword-2026' });
    }

    await reset(await tokenFor(parent), NEW_PASSWORD);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: parent.id },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();

    const signedIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: parent.email, password: NEW_PASSWORD });
    expect(signedIn.status).toBe(200);
  });

  it('refuses a token minted before the account was suspended', async () => {
    const token = await tokenFor(parent);
    await prisma.user.update({ where: { id: parent.id }, data: { status: 'SUSPENDED' } });

    const response = await reset(token, NEW_PASSWORD);

    expect(response.status).toBe(400);
  });

  it('audits completion, and records a failure when a spent token is presented', async () => {
    const token = await tokenFor(parent);
    await reset(token, NEW_PASSWORD);
    await reset(token, NEW_PASSWORD);

    const completed = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_completed', entityId: parent.id },
    });
    const failed = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_failed', entityId: parent.id },
    });

    expect(completed).not.toBeNull();
    expect(failed).not.toBeNull();
    expect(failed?.result).toBe('FAILURE');
  });
});
