/**
 * Session lifecycle: what a session grants, how it is renewed, and every way it ends.
 *
 * The behaviour worth the most attention is refresh-token rotation. A consumed token
 * presented a second time is either a client retry or a theft, and the request cannot
 * tell which — so the session collapses. That is deliberately the strict choice, and it
 * is only a real defence if it is asserted.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode, RoleKey } from '@sfs/shared';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';
import {
  bearer,
  cookiesFrom,
  createSchool,
  createTestUser,
  seedRoleCatalogue,
  signIn,
  totpCodeFor,
  type Session,
  type TestUser,
} from './helpers/auth.js';

const app: Express = createApp();

let roleIds = new Map<string, string>();
let schoolId = '';
let parent: TestUser;
let session: Session;

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
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('GET /auth/me', () => {
  it('describes the caller and the grants in force right now', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(parent.id);
    expect(response.body.data.firstName).toBe('Claudine');
    expect(response.body.data.schoolId).toBe(schoolId);
    expect(response.body.data.roleKeys).toEqual([RoleKey.PARENT]);
  });

  it('refuses a request with no token', async () => {
    const response = await request(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('refuses a malformed authorization header', async () => {
    for (const header of ['Bearer', 'Basic abc', session.accessToken, 'Bearer  ']) {
      const response = await request(app).get('/api/v1/auth/me').set('Authorization', header);
      expect(response.status).toBe(401);
    }
  });

  it('reflects a role change without waiting for the token to expire', async () => {
    // Grants are re-read from the database on every request; a token minted before the
    // change carries the old answer and must not be trusted for it.
    await prisma.userRole.deleteMany({ where: { userId: parent.id } });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(200);
    expect(response.body.data.roleKeys).toEqual([]);
    expect(response.body.data.permissions).toEqual([]);
  });

  it('refuses a token whose account has been suspended', async () => {
    await prisma.user.update({ where: { id: parent.id }, data: { status: 'SUSPENDED' } });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.ACCOUNT_INACTIVE);
  });

  it('refuses a token whose session has been revoked', async () => {
    await prisma.session.updateMany({
      where: { userId: parent.id },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('does not say why a session was revoked', async () => {
    // "Revoked because token reuse was detected" is information an attacker would use.
    await prisma.session.updateMany({
      where: { userId: parent.id },
      data: { revokedAt: new Date(), revokedReason: 'token_reuse_detected' },
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));

    expect(response.body.error.message).not.toContain('reuse');
  });

  it('demands a second factor as soon as a role requiring one is granted', async () => {
    // Granting the Bursar role must not leave a single-factor session running.
    await prisma.userRole.create({
      data: { userId: parent.id, roleId: roleIds.get(RoleKey.BURSAR)!, schoolId },
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.MFA_REQUIRED);
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges the cookie for a usable access token and a fresh cookie', async () => {
    // Note what is *not* asserted: that the access token string differs. Two tokens
    // minted within the same second carry identical claims and are therefore identical,
    // which is correct — the credential that must change on every exchange is the
    // refresh token, and that is what the next assertion checks.
    const response = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(parent.id);

    const issued = cookiesFrom(response)[0] ?? '';
    expect(issued).toContain('sfs_refresh=');
    expect(issued).not.toBe(session.cookies[0]);

    const usable = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${response.body.data.accessToken as string}`);
    expect(usable.status).toBe(200);
  });

  it('rejects a request with no cookie', async () => {
    const response = await request(app).post('/api/v1/auth/refresh');
    expect(response.status).toBe(401);
  });

  it('consumes the presented token, so it cannot be exchanged twice', async () => {
    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('revokes the whole session when a consumed token is presented again', async () => {
    // The strict choice: silently issuing a fresh token would let a thief ride along
    // indefinitely while the victim keeps working.
    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    const stored = await prisma.session.findFirstOrThrow({ where: { userId: parent.id } });
    expect(stored.revokedAt).not.toBeNull();
    expect(stored.revokedReason).toBe('token_reuse_detected');

    // Even the legitimately rotated cookie is now useless.
    const afterCollapse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiesFrom(rotated));
    expect(afterCollapse.status).toBe(401);
  });

  it('audits the reuse, because it is a security event and not just an error', async () => {
    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'auth.token.reuse_detected' },
    });
    expect(entry).not.toBeNull();
    expect(entry?.result).toBe('FAILURE');
  });

  it('records the rotation chain so an investigation can walk it', async () => {
    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    const consumed = await prisma.refreshToken.findFirstOrThrow({
      where: { usedAt: { not: null } },
    });
    expect(consumed.replacedById).not.toBeNull();
  });

  it('does not extend the session beyond its absolute expiry', async () => {
    // Refreshing renews activity, not the maximum lifetime: a stolen token must not be
    // keepable alive forever.
    const before = await prisma.session.findFirstOrThrow({ where: { userId: parent.id } });

    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    const after = await prisma.session.findFirstOrThrow({ where: { userId: parent.id } });
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
  });

  it('refuses to renew a suspended account, which never passes through authenticate', async () => {
    await prisma.user.update({ where: { id: parent.id }, data: { status: 'SUSPENDED' } });

    const response = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    expect(response.status).toBe(401);
  });

  it('clears the cookie when the refresh fails, rather than leaving a dead one behind', async () => {
    await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);
    const failed = await request(app).post('/api/v1/auth/refresh').set('Cookie', session.cookies);

    expect(cookiesFrom(failed).join(';')).toContain('sfs_refresh=;');
  });
});

describe('sign-out', () => {
  it('ends the current session only', async () => {
    const other = await signIn(app, parent);

    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(204);

    const stillValid = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(other));
    expect(stillValid.status).toBe(200);
  });

  it('clears the refresh cookie', async () => {
    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', bearer(session));

    expect(cookiesFrom(response).join(';')).toContain('sfs_refresh=;');
  });

  it('makes the access token useless immediately', async () => {
    await request(app).post('/api/v1/auth/logout').set('Authorization', bearer(session));

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));
    expect(response.status).toBe(401);
  });

  it('ends every session, including the caller`s, on logout-all', async () => {
    // The "someone else is using my account" action, so it deliberately does not spare
    // the device asking.
    const other = await signIn(app, parent);

    const response = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(200);
    expect(response.body.data.sessionsRevoked).toBe(2);

    for (const ended of [session, other]) {
      const check = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(ended));
      expect(check.status).toBe(401);
    }
  });
});

describe('session management', () => {
  it('lists the caller`s live sessions and marks the current one', async () => {
    await signIn(app, parent);

    const response = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data.filter((item: { current: boolean }) => item.current)).toHaveLength(1);
  });

  it('reveals no credential material in the list', async () => {
    const response = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', bearer(session));

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(session.accessToken);
    expect(serialised).not.toContain('tokenHash');
  });

  it('signs one other device out by id', async () => {
    const other = await signIn(app, parent);
    const list = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', bearer(session));
    const otherSession = (list.body.data as Array<{ id: string; current: boolean }>).find(
      (item) => !item.current,
    );
    if (otherSession === undefined) throw new Error('Expected a second live session.');

    const response = await request(app)
      .delete(`/api/v1/auth/sessions/${otherSession.id}`)
      .set('Authorization', bearer(session));

    expect(response.status).toBe(204);
    const check = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(other));
    expect(check.status).toBe(401);
  });

  it('reports another user`s session as not found, rather than as forbidden', async () => {
    // The difference between "someone else's session" and "no such id" is only useful
    // to an attacker.
    const stranger = await createTestUser(roleIds, {
      email: 'stranger@gskicukiro.invalid',
      roleKeys: [RoleKey.PARENT],
      schoolId,
    });
    const strangerSession = await signIn(app, stranger);
    const strangerRow = await prisma.session.findFirstOrThrow({ where: { userId: stranger.id } });

    const response = await request(app)
      .delete(`/api/v1/auth/sessions/${strangerRow.id}`)
      .set('Authorization', bearer(session));

    expect(response.status).toBe(404);
    const stillValid = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(strangerSession));
    expect(stillValid.status).toBe(200);
  });
});

describe('voluntary MFA enrolment', () => {
  it('enrols a role that does not mandate MFA, and requires signing in again', async () => {
    // A session that never satisfied a challenge cannot be upgraded in place, so the
    // honest answer is to end it rather than claim a factor it never proved.
    const started = await request(app)
      .post('/api/v1/auth/mfa/enable/start')
      .set('Authorization', bearer(session));

    expect(started.status).toBe(200);

    const confirmed = await request(app)
      .post('/api/v1/auth/mfa/enable/confirm')
      .set('Authorization', bearer(session))
      .send({ code: totpCodeFor(started.body.data.secret as string) });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.reauthenticationRequired).toBe(true);
    expect(confirmed.body.data.recoveryCodes).toHaveLength(10);

    const afterEnrolment = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session));
    expect(afterEnrolment.status).toBe(401);
  });

  it('refuses to mint recovery codes from a session that never proved a second factor', async () => {
    // Recovery codes bypass the second factor. A single-factor session minting a fresh
    // set would be a way around MFA rather than a way back into it.
    const response = await request(app)
      .post('/api/v1/auth/mfa/recovery-codes')
      .set('Authorization', bearer(session));

    expect(response.status).toBe(403);
  });
});
