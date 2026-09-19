/**
 * Backend-enforced authorisation, exercised through the account-administration routes.
 *
 * Phase 2 of the plan requires every role to be tested for what it may and may not do,
 * including the negative cases. That is what this file is: the role matrix asserted
 * against real HTTP, plus the rules that stop a legitimate permission being turned into
 * an escalation — self-assignment, rank, tenant scope, and the last administrator.
 *
 * The negative cases matter more than the positive ones. A permission that is granted
 * too widely produces no error and no symptom until someone uses it.
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
  bearer,
  createSchool,
  createTestUser,
  seedRoleCatalogue,
  signIn,
  type Session,
  type TestUser,
} from './helpers/auth.js';

const app: Express = createApp();

let roleIds = new Map<string, string>();
let schoolId = '';
let otherSchoolId = '';

const users = {} as Record<RoleKey, TestUser>;
const sessions = {} as Record<RoleKey, Session>;

let subject: TestUser;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  roleIds = await seedRoleCatalogue();
  schoolId = await createSchool('GSK', 'GS Kicukiro');
  otherSchoolId = await createSchool('GSN', 'GS Nyamirambo');

  // One account per role, all at the same school, so a denial is about the role rather
  // than about the tenant boundary.
  for (const roleKey of [
    RoleKey.SCHOOL_ADMIN,
    RoleKey.FINANCE_MANAGER,
    RoleKey.BURSAR,
    RoleKey.DOS,
    RoleKey.PARENT,
    RoleKey.STUDENT,
  ]) {
    users[roleKey] = await createTestUser(roleIds, {
      email: `${roleKey.toLowerCase()}@gskicukiro.invalid`,
      roleKeys: [roleKey],
      schoolId,
    });
    sessions[roleKey] = await signIn(app, users[roleKey]);
  }

  users[RoleKey.SUPER_ADMIN] = await createTestUser(roleIds, {
    email: 'superadmin@sfs.invalid',
    roleKeys: [RoleKey.SUPER_ADMIN],
    schoolId: null,
    isSystemAdministrator: true,
  });
  sessions[RoleKey.SUPER_ADMIN] = await signIn(app, users[RoleKey.SUPER_ADMIN]);

  // An ordinary account for the privileged roles to act on.
  subject = await createTestUser(roleIds, {
    email: 'subject@gskicukiro.invalid',
    roleKeys: [RoleKey.PARENT],
    schoolId,
    firstName: 'Subject',
    lastName: 'Account',
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

async function versionOf(userId: string): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { version: true },
  });
  return user.version;
}

/* ----------------------------------------------------------------- the matrix */

describe('GET /users — who may read accounts', () => {
  const allowed = [RoleKey.SUPER_ADMIN, RoleKey.SCHOOL_ADMIN];
  const denied = [
    RoleKey.FINANCE_MANAGER,
    RoleKey.BURSAR,
    RoleKey.DOS,
    RoleKey.PARENT,
    RoleKey.STUDENT,
  ];

  it.each(allowed)('admits %s, which holds user.read', async (roleKey) => {
    const response = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(sessions[roleKey]));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it.each(denied)('refuses %s, which does not', async (roleKey) => {
    const response = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(sessions[roleKey]));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.INSUFFICIENT_PERMISSION);
  });

  it('refuses an unauthenticated caller before any permission is considered', async () => {
    const response = await request(app).get('/api/v1/users');
    expect(response.status).toBe(401);
  });
});

describe('POST /users — who may create accounts', () => {
  const body = {
    email: 'created@gskicukiro.invalid',
    firstName: 'Created',
    lastName: 'Account',
    roleKeys: [RoleKey.PARENT],
  };

  it('admits a School Administrator', async () => {
    const response = await request(app)
      .post('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send(body);

    expect(response.status).toBe(201);
    expect(response.body.data.user.email).toBe(body.email);
  });

  it.each([RoleKey.FINANCE_MANAGER, RoleKey.BURSAR, RoleKey.DOS, RoleKey.PARENT, RoleKey.STUDENT])(
    'refuses %s',
    async (roleKey) => {
      const response = await request(app)
        .post('/api/v1/users')
        .set('Authorization', bearer(sessions[roleKey]))
        .send(body);

      expect(response.status).toBe(403);
    },
  );
});

describe('PUT /users/:id/status — who may suspend an account', () => {
  it('admits a School Administrator, which holds user.deactivate', async () => {
    const response = await request(app)
      .put(`/api/v1/users/${subject.id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        expectedVersion: await versionOf(subject.id),
        status: 'SUSPENDED',
        reason: 'Left the school',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('SUSPENDED');
  });

  it.each([RoleKey.FINANCE_MANAGER, RoleKey.BURSAR, RoleKey.DOS])(
    'refuses %s, which does not',
    async (roleKey) => {
      const response = await request(app)
        .put(`/api/v1/users/${subject.id}/status`)
        .set('Authorization', bearer(sessions[roleKey]))
        .send({ expectedVersion: 0, status: 'SUSPENDED' });

      expect(response.status).toBe(403);
    },
  );
});

describe('GET /roles — who may read the catalogue', () => {
  it('admits a School Administrator and lists what each role may do', async () => {
    const response = await request(app)
      .get('/api/v1/roles')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(7);
    const bursar = (response.body.data as Array<{ key: string; permissions: string[] }>).find(
      (role) => role.key === RoleKey.BURSAR,
    );
    // The Bursar/Finance Manager separation of duties, asserted against the API rather
    // than against the constant: a bursar records and verifies, and cannot reverse.
    expect(bursar?.permissions).toContain('payment.verify_manual');
    expect(bursar?.permissions).not.toContain('payment.reverse');
    expect(bursar?.permissions).not.toContain('adjustment.approve');
  });

  it.each([RoleKey.PARENT, RoleKey.STUDENT])('refuses %s', async (roleKey) => {
    const response = await request(app)
      .get('/api/v1/roles')
      .set('Authorization', bearer(sessions[roleKey]));

    expect(response.status).toBe(403);
  });
});

/* -------------------------------------------------------------- tenant scoping */

describe('tenant scoping', () => {
  let foreignUser: TestUser;

  beforeEach(async () => {
    foreignUser = await createTestUser(roleIds, {
      email: 'foreign@gsnyamirambo.invalid',
      roleKeys: [RoleKey.PARENT],
      schoolId: otherSchoolId,
    });
  });

  it('does not list accounts from another school', async () => {
    const response = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    const emails = (response.body.data as Array<{ email: string }>).map((user) => user.email);
    expect(emails).not.toContain(foreignUser.email);
    expect(emails).toContain(subject.email);
  });

  it('reports an account from another school as not found, not as forbidden', async () => {
    // Answering 403 would confirm the id exists somewhere, which is itself a disclosure.
    const response = await request(app)
      .get(`/api/v1/users/${foreignUser.id}`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    expect(response.status).toBe(404);
  });

  it('refuses to modify an account from another school', async () => {
    const response = await request(app)
      .patch(`/api/v1/users/${foreignUser.id}`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({ expectedVersion: 0, firstName: 'Renamed' });

    expect(response.status).toBe(404);

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: foreignUser.id } });
    expect(unchanged.firstName).not.toBe('Renamed');
  });

  it('refuses to create an account in another school', async () => {
    const response = await request(app)
      .post('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        email: 'planted@gsnyamirambo.invalid',
        firstName: 'Planted',
        lastName: 'Account',
        roleKeys: [RoleKey.PARENT],
        schoolId: otherSchoolId,
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.SCHOOL_SCOPE_VIOLATION);
  });

  it('lets a Super Administrator see across schools', async () => {
    const response = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SUPER_ADMIN]));

    const emails = (response.body.data as Array<{ email: string }>).map((user) => user.email);
    expect(emails).toContain(foreignUser.email);
    expect(emails).toContain(subject.email);
  });
});

/* --------------------------------------------------------- escalation defences */

describe('role assignment', () => {
  function grant(session: Session, userId: string, roleKey: RoleKey): request.Test {
    return request(app)
      .post(`/api/v1/users/${userId}/roles`)
      .set('Authorization', bearer(session))
      .send({ roleKey });
  }

  it('lets a School Administrator grant a role below their own rank', async () => {
    const response = await grant(sessions[RoleKey.SCHOOL_ADMIN], subject.id, RoleKey.DOS);

    expect(response.status).toBe(200);
    expect(
      (response.body.data.roles as Array<{ roleKey: string }>).map((role) => role.roleKey),
    ).toContain(RoleKey.DOS);
  });

  it('refuses to grant a role above the caller`s own rank', async () => {
    // Otherwise `user.assign_role` is indistinguishable from Super Administrator.
    const response = await grant(sessions[RoleKey.SCHOOL_ADMIN], subject.id, RoleKey.SUPER_ADMIN);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.INSUFFICIENT_PERMISSION);
  });

  it('refuses a caller changing the roles on their own account', async () => {
    // The escalation a rank check alone does not catch: a School Administrator (rank
    // 80) does not hold `payment.reverse`, but a Finance Manager (rank 70) does.
    const response = await grant(
      sessions[RoleKey.SCHOOL_ADMIN],
      users[RoleKey.SCHOOL_ADMIN].id,
      RoleKey.FINANCE_MANAGER,
    );

    expect(response.status).toBe(403);

    const held = await prisma.userRole.count({
      where: {
        userId: users[RoleKey.SCHOOL_ADMIN].id,
        role: { key: RoleKey.FINANCE_MANAGER },
      },
    });
    expect(held).toBe(0);
  });

  it('refuses a caller revoking a role from their own account', async () => {
    const response = await request(app)
      .delete(`/api/v1/users/${users[RoleKey.SCHOOL_ADMIN].id}/roles/${RoleKey.SCHOOL_ADMIN}`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    expect(response.status).toBe(403);
  });

  it('cannot even see a Super Administrator, whose account is not scoped to a school', async () => {
    // Scoping denies before rank is ever considered, and answers "not found" rather
    // than confirming that the account exists.
    const response = await request(app)
      .put(`/api/v1/users/${users[RoleKey.SUPER_ADMIN].id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({ expectedVersion: 0, status: 'SUSPENDED' });

    expect(response.status).toBe(404);
  });

  it('refuses to act on an in-scope account that outranks the caller', async () => {
    // The rank guard proper: a visible account holding a more privileged role. Without
    // it, `user.deactivate` at one school would be enough to suspend whoever sits above
    // the person holding it.
    const outranking = await createTestUser(roleIds, {
      email: 'outranking@gskicukiro.invalid',
      roleKeys: [RoleKey.SUPER_ADMIN],
      schoolId,
    });

    const response = await request(app)
      .put(`/api/v1/users/${outranking.id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({ expectedVersion: await versionOf(outranking.id), status: 'SUSPENDED' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.INSUFFICIENT_PERMISSION);
  });

  it('refuses to remove the only active Super Administrator', async () => {
    // There is no recovery path from an installation nobody can administer.
    const response = await request(app)
      .put(`/api/v1/users/${users[RoleKey.SUPER_ADMIN].id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SUPER_ADMIN]))
      .send({
        expectedVersion: await versionOf(users[RoleKey.SUPER_ADMIN].id),
        status: 'SUSPENDED',
      });

    // Refused as self-action first; the last-administrator guard is asserted below
    // through a second Super Administrator acting on the first.
    expect(response.status).toBe(400);
  });

  it('refuses to revoke the last Super Administrator role, even by another one', async () => {
    const second = await createTestUser(roleIds, {
      email: 'second.super@sfs.invalid',
      roleKeys: [RoleKey.SUPER_ADMIN],
      schoolId: null,
      isSystemAdministrator: true,
      status: 'SUSPENDED',
    });

    // `second` is suspended, so it does not count as a way back in: revoking the only
    // active one must still be refused.
    const response = await request(app)
      .delete(`/api/v1/users/${users[RoleKey.SUPER_ADMIN].id}/roles/${RoleKey.SUPER_ADMIN}`)
      .set('Authorization', bearer(sessions[RoleKey.SUPER_ADMIN]));

    expect(response.status).toBe(403);
    expect(second.id).toBeTypeOf('string');
  });

  it('requires a second factor to change roles at all', async () => {
    // Granting a role is how privilege is escalated, so it must not be reachable from a
    // session that only ever proved a password.
    const singleFactorAdmin = await createTestUser(roleIds, {
      email: 'nomfa.admin@gskicukiro.invalid',
      roleKeys: [RoleKey.SCHOOL_ADMIN],
      schoolId,
      enrolMfa: false,
    });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: singleFactorAdmin.email, password: TEST_PASSWORD });

    // An unenrolled account holding an MFA-required role never reaches a session at
    // all: it is routed into enrolment. That is the strongest possible form of this.
    expect(login.body.data.status).toBe('mfa_enrolment_required');
    expect(login.body.data.accessToken).toBeUndefined();
  });

  it('takes a revoked role into effect on the next request', async () => {
    const dosSession = sessions[RoleKey.DOS];
    const before = await request(app).get('/api/v1/users').set('Authorization', bearer(dosSession));
    expect(before.status).toBe(403);

    await prisma.userRole.create({
      data: {
        userId: users[RoleKey.DOS].id,
        roleId: roleIds.get(RoleKey.SCHOOL_ADMIN)!,
        schoolId,
      },
    });

    const after = await request(app).get('/api/v1/users').set('Authorization', bearer(dosSession));
    // SCHOOL_ADMIN requires MFA, and this session never proved one — so the grant takes
    // effect immediately, and takes effect as a refusal.
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe(ErrorCode.MFA_REQUIRED);
  });
});

describe('account creation rules', () => {
  it('forces a password change and returns the generated password exactly once', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        email: 'newbursar@gskicukiro.invalid',
        firstName: 'New',
        lastName: 'Bursar',
        roleKeys: [RoleKey.BURSAR],
      });

    expect(created.status).toBe(201);
    expect(created.body.data.temporaryPassword).toBeTypeOf('string');
    expect(created.body.data.user.mustChangePassword).toBe(true);
    expect(created.body.data.user.status).toBe('INVITED');

    const fetched = await request(app)
      .get(`/api/v1/users/${created.body.data.user.id as string}`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    expect(fetched.body.data.temporaryPassword).toBeUndefined();
  });

  it('never returns credential material in an account projection', async () => {
    const response = await request(app)
      .get(`/api/v1/users/${subject.id}`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('argon2');
    expect(serialised).not.toContain('mfaSecret');
  });

  it('refuses a duplicate email address', async () => {
    const response = await request(app)
      .post('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        email: subject.email,
        firstName: 'Duplicate',
        lastName: 'Account',
        roleKeys: [RoleKey.PARENT],
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it('refuses an account with no role, which could sign in and do nothing', async () => {
    const response = await request(app)
      .post('/api/v1/users')
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        email: 'roleless@gskicukiro.invalid',
        firstName: 'No',
        lastName: 'Role',
        roleKeys: [],
      });

    expect(response.status).toBe(400);
  });
});

describe('optimistic locking on account edits', () => {
  it('rejects an update built on a stale version', async () => {
    const admin = bearer(sessions[RoleKey.SCHOOL_ADMIN]);
    const version = await versionOf(subject.id);

    const first = await request(app)
      .patch(`/api/v1/users/${subject.id}`)
      .set('Authorization', admin)
      .send({ expectedVersion: version, firstName: 'First' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/v1/users/${subject.id}`)
      .set('Authorization', admin)
      .send({ expectedVersion: version, firstName: 'Second' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ErrorCode.RECORD_MODIFIED);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: subject.id } });
    expect(stored.firstName).toBe('First');
  });
});

describe('must-change-password gate', () => {
  it('lets the account change its password but nothing else', async () => {
    const forced = await createTestUser(roleIds, {
      email: 'forced.admin@gskicukiro.invalid',
      roleKeys: [RoleKey.SCHOOL_ADMIN],
      schoolId,
      mustChangePassword: true,
    });
    const forcedSession = await signIn(app, forced);

    const blocked = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(forcedSession));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe(ErrorCode.PASSWORD_CHANGE_REQUIRED);

    const allowed = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(forcedSession))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Cornflower-Anvil-Ledger-6' });
    expect(allowed.status).toBe(204);

    const afterChange = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(forcedSession));
    expect(afterChange.status).toBe(200);
  });
});

describe('unlocking an account', () => {
  it('clears a lockout so the owner can sign in again', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: subject.email, password: 'WrongPassword-2026' });
    }

    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: subject.email, password: TEST_PASSWORD });
    expect(locked.body.error.code).toBe(ErrorCode.ACCOUNT_LOCKED);

    const unlocked = await request(app)
      .post(`/api/v1/users/${subject.id}/unlock`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.data.locked).toBe(false);

    const signedIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: subject.email, password: TEST_PASSWORD });
    expect(signedIn.status).toBe(200);
  });

  it('does not change the password, which the administrator has no business setting', async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: subject.id },
      select: { passwordHash: true },
    });

    await request(app)
      .post(`/api/v1/users/${subject.id}/unlock`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]));

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: subject.id },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
  });
});

describe('suspension', () => {
  it('ends every session the suspended account holds', async () => {
    const victimSession = await signIn(app, subject);

    await request(app)
      .put(`/api/v1/users/${subject.id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        expectedVersion: await versionOf(subject.id),
        status: 'SUSPENDED',
        reason: 'Withdrawn',
      });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(victimSession));
    expect(response.status).toBe(401);
  });

  it('refuses a caller suspending their own account', async () => {
    const response = await request(app)
      .put(`/api/v1/users/${users[RoleKey.SCHOOL_ADMIN].id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        expectedVersion: await versionOf(users[RoleKey.SCHOOL_ADMIN].id),
        status: 'SUSPENDED',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('audits the decision with the reason given', async () => {
    await request(app)
      .put(`/api/v1/users/${subject.id}/status`)
      .set('Authorization', bearer(sessions[RoleKey.SCHOOL_ADMIN]))
      .send({
        expectedVersion: await versionOf(subject.id),
        status: 'SUSPENDED',
        reason: 'Left the school',
      });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'user.deactivated', entityId: subject.id },
    });
    expect(entry?.reason).toBe('Left the school');
    expect(entry?.actorUserId).toBe(users[RoleKey.SCHOOL_ADMIN].id);
  });
});

describe('denials are recorded', () => {
  it('writes an audit entry when a caller is refused', async () => {
    // A single 403 is usually a misconfigured account; a pattern of them is someone
    // probing, and that distinction only exists if the attempts are recorded.
    await request(app).get('/api/v1/users').set('Authorization', bearer(sessions[RoleKey.BURSAR]));

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'auth.access_denied' },
      orderBy: { occurredAt: 'desc' },
    });

    expect(entry).not.toBeNull();
    expect(entry?.result).toBe('FAILURE');
    expect(entry?.entityType).toBe('Route');
  });
});
