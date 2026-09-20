/**
 * Student registration, profile, lifecycle and guardian linking, over real HTTP.
 *
 * The cases that matter most are the ones about records that outlive the student:
 * that a Student ID is allocated once and never changes, that enrolment history is
 * appended rather than overwritten, and that leaving the school ends an enrolment
 * instead of deleting it.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode, RoleKey } from '@sfs/shared';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { seedAcademicStructure, type AcademicFixture } from './helpers/academic.js';
import {
  bearer,
  createSchool,
  createTestUser,
  seedRoleCatalogue,
  signIn,
  type Session,
  type TestUser,
} from './helpers/auth.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';

const app: Express = createApp();

let roleIds = new Map<string, string>();
let schoolId = '';
let academic: AcademicFixture;
let admin: TestUser;
let adminSession: Session;
let bursarSession: Session;
let parentSession: Session;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  roleIds = await seedRoleCatalogue();
  schoolId = await createSchool('GSK', 'GS Kicukiro');
  academic = await seedAcademicStructure(schoolId);

  admin = await createTestUser(roleIds, {
    email: 'admin@gskicukiro.invalid',
    roleKeys: [RoleKey.SCHOOL_ADMIN],
    schoolId,
  });
  adminSession = await signIn(app, admin);

  bursarSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'bursar@gskicukiro.invalid',
      roleKeys: [RoleKey.BURSAR],
      schoolId,
    }),
  );

  parentSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'parent@gskicukiro.invalid',
      roleKeys: [RoleKey.PARENT],
      schoolId,
    }),
  );
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

function registerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: 'Aline',
    lastName: 'Mutesi',
    gender: 'FEMALE',
    dateOfBirth: '2012-04-18',
    admissionDate: '2026-01-12',
    district: 'Kicukiro',
    enrolment: { levelId: academic.levelIds[0], classSectionId: academic.classSectionId },
    ...overrides,
  };
}

async function registerStudent(overrides: Record<string, unknown> = {}): Promise<request.Response> {
  return request(app)
    .post('/api/v1/students')
    .set('Authorization', bearer(adminSession))
    .send(registerBody(overrides));
}

describe('POST /students', () => {
  it('registers a student and allocates the Student ID', async () => {
    const response = await registerStudent();

    expect(response.status).toBe(201);
    expect(response.body.data.studentId).toBe('STU-2026-00001');
    expect(response.body.data.firstName).toBe('Aline');
    expect(response.headers.location).toBe(`/api/v1/students/${response.body.data.id as string}`);
  });

  it('numbers students sequentially within the admission year', async () => {
    await registerStudent();
    const second = await registerStudent({ firstName: 'Diane', lastName: 'Keza' });

    expect(second.body.data.studentId).toBe('STU-2026-00002');
  });

  it('creates the first enrolment in the same operation', async () => {
    // A student with no enrolment cannot be placed, charged or reported on.
    const response = await registerStudent();

    expect(response.body.data.currentEnrollment).not.toBeNull();
    expect(response.body.data.currentEnrollment.levelName).toBe('Senior 1');
    expect(response.body.data.currentEnrollment.classSectionName).toBe('S1 A');
    expect(response.body.data.currentEnrollment.status).toBe('ENROLLED');
    expect(response.body.data.enrollments).toHaveLength(1);
  });

  it('records the programme from the level rather than trusting the caller', async () => {
    const response = await registerStudent();

    expect(response.body.data.currentEnrollment.programId).toBe(academic.programId);
  });

  it('refuses a class that belongs to a different level', async () => {
    // Placing a student in the wrong class silently is worse than refusing the request.
    const otherLevel = academic.levelIds[1]!;
    const response = await registerStudent({
      enrolment: { levelId: otherLevel, classSectionId: academic.classSectionId },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/different level/i);
  });

  it('refuses a class that is already full', async () => {
    // The fixture class holds two.
    await registerStudent({ firstName: 'One' });
    await registerStudent({ firstName: 'Two' });

    const third = await registerStudent({ firstName: 'Three' });

    expect(third.status).toBe(409);
    expect(third.body.error.message).toMatch(/full/i);
  });

  it('allows a class with no capacity set to keep taking students', async () => {
    const response = await registerStudent({
      enrolment: {
        levelId: academic.levelIds[0],
        classSectionId: academic.spareClassSectionId,
      },
    });

    expect(response.status).toBe(201);
  });

  it('refuses registration when no academic year is current', async () => {
    await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });

    const response = await registerStudent();

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
    expect(response.body.error.message).toMatch(/no academic year/i);
  });

  it('audits the registration', async () => {
    const response = await registerStudent();

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'student.registered', entityId: response.body.data.id },
    });
    expect(entry).not.toBeNull();
  });

  it.each([RoleKey.BURSAR, RoleKey.PARENT])('refuses %s, which cannot register', async (role) => {
    const session = role === RoleKey.BURSAR ? bursarSession : parentSession;

    const response = await request(app)
      .post('/api/v1/students')
      .set('Authorization', bearer(session))
      .send(registerBody());

    expect(response.status).toBe(403);
  });
});

describe('GET /students', () => {
  beforeEach(async () => {
    await registerStudent({ firstName: 'Aline', lastName: 'Mutesi' });
    await registerStudent({
      firstName: 'Diane',
      lastName: 'Keza',
      enrolment: { levelId: academic.levelIds[0], classSectionId: academic.spareClassSectionId },
    });
  });

  it('lists students with their current placement', async () => {
    const response = await request(app)
      .get('/api/v1/students')
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.meta.totalItems).toBe(2);
    expect(response.body.data[0].currentEnrollment.levelName).toBe('Senior 1');
  });

  it('lets a bursar read students, since they cannot take a payment otherwise', async () => {
    const response = await request(app)
      .get('/api/v1/students')
      .set('Authorization', bearer(bursarSession));

    expect(response.status).toBe(200);
  });

  it('refuses a parent, who sees their own children rather than the roll', async () => {
    const response = await request(app)
      .get('/api/v1/students')
      .set('Authorization', bearer(parentSession));

    expect(response.status).toBe(403);
  });

  it('searches by Student ID and by name', async () => {
    const byId = await request(app)
      .get('/api/v1/students')
      .query({ search: 'STU-2026-00001' })
      .set('Authorization', bearer(adminSession));
    expect(byId.body.data).toHaveLength(1);

    const byName = await request(app)
      .get('/api/v1/students')
      .query({ search: 'keza' })
      .set('Authorization', bearer(adminSession));
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].lastName).toBe('Keza');
  });

  it('filters by class', async () => {
    const response = await request(app)
      .get('/api/v1/students')
      .query({ classSectionId: academic.classSectionId })
      .set('Authorization', bearer(adminSession));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].firstName).toBe('Aline');
  });

  it('paginates rather than streaming the whole roll', async () => {
    const response = await request(app)
      .get('/api/v1/students')
      .query({ pageSize: 1 })
      .set('Authorization', bearer(adminSession));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta.totalPages).toBe(2);
    expect(response.body.meta.hasNextPage).toBe(true);
  });
});

describe('tenant scoping', () => {
  let foreignStudentId = '';

  beforeEach(async () => {
    const otherSchoolId = await createSchool('GSN', 'GS Nyamirambo');
    const otherAcademic = await seedAcademicStructure(otherSchoolId, { yearName: '2026-other' });
    const otherAdmin = await createTestUser(roleIds, {
      email: 'admin@gsnyamirambo.invalid',
      roleKeys: [RoleKey.SCHOOL_ADMIN],
      schoolId: otherSchoolId,
    });
    const otherSession = await signIn(app, otherAdmin);

    const created = await request(app)
      .post('/api/v1/students')
      .set('Authorization', bearer(otherSession))
      .send({
        firstName: 'Foreign',
        lastName: 'Student',
        admissionDate: '2026-01-12',
        enrolment: { levelId: otherAcademic.levelIds[0] },
      });
    foreignStudentId = created.body.data.id;
  });

  it('does not list another school`s students', async () => {
    await registerStudent();

    const response = await request(app)
      .get('/api/v1/students')
      .set('Authorization', bearer(adminSession));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].lastName).toBe('Mutesi');
  });

  it('reports another school`s student as not found, not as forbidden', async () => {
    const response = await request(app)
      .get(`/api/v1/students/${foreignStudentId}`)
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(404);
  });

  it('numbers each school`s students independently', async () => {
    const ours = await registerStudent();

    // Both schools start at 1: the identifier is unique per school, not globally.
    expect(ours.body.data.studentId).toBe('STU-2026-00001');
    const foreign = await prisma.student.findUniqueOrThrow({ where: { id: foreignStudentId } });
    expect(foreign.studentId).toBe('STU-2026-00001');
  });
});

describe('PATCH /students/:studentId', () => {
  let studentId = '';
  let version = 0;

  beforeEach(async () => {
    const created = await registerStudent();
    studentId = created.body.data.id;
    version = created.body.data.version;
  });

  it('corrects a profile', async () => {
    const response = await request(app)
      .patch(`/api/v1/students/${studentId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: version, lastName: 'Mutesi Uwase', phone: '0788123456' });

    expect(response.status).toBe(200);
    expect(response.body.data.lastName).toBe('Mutesi Uwase');
    expect(response.body.data.phone).toBe('0788123456');
  });

  it('never changes the Student ID, which is printed on receipts', async () => {
    const response = await request(app)
      .patch(`/api/v1/students/${studentId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: version, studentId: 'STU-2026-09999' });

    // `strictObject` rejects the unknown field rather than ignoring it.
    expect(response.status).toBe(400);

    const stored = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(stored.studentId).toBe('STU-2026-00001');
  });

  it('rejects an edit built on a stale version', async () => {
    await request(app)
      .patch(`/api/v1/students/${studentId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: version, firstName: 'First' });

    const second = await request(app)
      .patch(`/api/v1/students/${studentId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: version, firstName: 'Second' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ErrorCode.RECORD_MODIFIED);
  });
});

describe('PUT /students/:studentId/status', () => {
  let studentId = '';
  let version = 0;
  let enrollmentId = '';

  beforeEach(async () => {
    const created = await registerStudent();
    studentId = created.body.data.id;
    version = created.body.data.version;
    enrollmentId = created.body.data.currentEnrollment.id;
  });

  function changeStatus(body: Record<string, unknown>): request.Test {
    return request(app)
      .put(`/api/v1/students/${studentId}/status`)
      .set('Authorization', bearer(adminSession))
      .send(body);
  }

  it('withdraws a student and ends the live enrolment in the same operation', async () => {
    // Leaving these to be done separately is how a withdrawn student stays on a class
    // list and keeps accruing term charges.
    const response = await changeStatus({
      expectedVersion: version,
      status: 'WITHDRAWN',
      reason: 'Moved to Kigali',
      effectiveDate: '2026-03-20',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('WITHDRAWN');

    const enrollment = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
    expect(enrollment.status).toBe('WITHDRAWN');
    expect(enrollment.endDate?.toISOString().slice(0, 10)).toBe('2026-03-20');
    expect(enrollment.exitReason).toBe('Moved to Kigali');
  });

  it('keeps the enrolment row rather than deleting it', async () => {
    await changeStatus({ expectedVersion: version, status: 'TRANSFERRED', reason: 'Transferred' });

    const history = await prisma.enrollment.findMany({ where: { studentId } });
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe('TRANSFERRED_OUT');
  });

  it('requires a reason for anything but reinstatement', async () => {
    const response = await changeStatus({ expectedVersion: version, status: 'WITHDRAWN' });

    expect(response.status).toBe(400);
    expect(response.body.error.fieldErrors?.[0]?.path).toBe('body.reason');
  });

  it('refuses a transition that makes no sense', async () => {
    await changeStatus({ expectedVersion: version, status: 'ARCHIVED', reason: 'Left years ago' });

    const reloaded = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    const response = await changeStatus({
      expectedVersion: reloaded.version,
      status: 'ACTIVE',
      reason: 'Back again',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
  });

  it('refuses a change to the status the student already has', async () => {
    const response = await changeStatus({
      expectedVersion: version,
      status: 'ACTIVE',
      reason: 'No change',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
  });

  it('audits the change with its reason', async () => {
    await changeStatus({ expectedVersion: version, status: 'WITHDRAWN', reason: 'Moved away' });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'student.status_changed', entityId: studentId },
    });
    expect(entry?.reason).toBe('Moved away');
  });
});

describe('guardians', () => {
  let studentId = '';
  let guardianId = '';

  beforeEach(async () => {
    const created = await registerStudent();
    studentId = created.body.data.id;

    const guardian = await request(app)
      .post('/api/v1/guardians')
      .set('Authorization', bearer(adminSession))
      .send({ firstName: 'Jean', lastName: 'Mutesi', phone: '+250788123456' });
    guardianId = guardian.body.data.id;
  });

  it('creates a guardian and links them to a student', async () => {
    const response = await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({
        guardianId,
        relationship: 'FATHER',
        isPrimaryContact: true,
        isFinanciallyResponsible: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.relationship).toBe('FATHER');
    expect(response.body.data.canViewFinancials).toBe(true);
  });

  it('shows the link on the student profile', async () => {
    await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId, relationship: 'FATHER' });

    const student = await request(app)
      .get(`/api/v1/students/${studentId}`)
      .set('Authorization', bearer(adminSession));

    expect(student.body.data.guardians).toHaveLength(1);
    expect(student.body.data.guardians[0].guardianPhone).toBe('+250788123456');
  });

  it('refuses to link the same guardian twice', async () => {
    await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId });

    const second = await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it('keeps exactly one primary contact per student', async () => {
    // Two primary contacts is the same as none when somebody has to be rung.
    const other = await request(app)
      .post('/api/v1/guardians')
      .set('Authorization', bearer(adminSession))
      .send({ firstName: 'Claudine', lastName: 'Uwase', phone: '+250788999888' });

    await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId, isPrimaryContact: true });

    await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId: other.body.data.id, isPrimaryContact: true });

    const primaries = await prisma.studentGuardian.count({
      where: { studentId, isPrimaryContact: true },
    });
    expect(primaries).toBe(1);
  });

  it('audits a change to the financial rights on a link', async () => {
    // These flags decide who may see a balance and who may pay, so a change to them
    // is a security-relevant event.
    const link = await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId, canInitiatePayments: true });

    await request(app)
      .patch(`/api/v1/guardian-links/${link.body.data.id as string}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: link.body.data.version, canInitiatePayments: false });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'guardian.link_updated', entityId: link.body.data.id },
    });
    expect(entry).not.toBeNull();
    expect(entry?.beforeState).toMatchObject({ canInitiatePayments: true });
    expect(entry?.afterState).toMatchObject({ canInitiatePayments: false });
  });

  it('removes access when a link is deleted, without touching the student', async () => {
    const link = await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set('Authorization', bearer(adminSession))
      .send({ guardianId });

    const response = await request(app)
      .delete(`/api/v1/guardian-links/${link.body.data.id as string}`)
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(204);
    expect(await prisma.studentGuardian.count({ where: { studentId } })).toBe(0);
    expect(await prisma.student.count({ where: { id: studentId } })).toBe(1);
    // The guardian record itself survives: they may be linked to other children.
    expect(await prisma.guardian.count({ where: { id: guardianId } })).toBe(1);
  });
});

describe('enrolment history', () => {
  let studentId = '';

  beforeEach(async () => {
    const created = await registerStudent();
    studentId = created.body.data.id;
  });

  it('appends a new enrolment rather than overwriting the last', async () => {
    const first = await prisma.enrollment.findFirstOrThrow({ where: { studentId } });

    await request(app)
      .post(`/api/v1/enrolments/${first.id}/end`)
      .set('Authorization', bearer(adminSession))
      .send({ status: 'PROMOTED', endDate: '2026-11-06' });

    const next = await request(app)
      .post('/api/v1/enrolments')
      .set('Authorization', bearer(adminSession))
      .send({
        studentId,
        levelId: academic.levelIds[1],
        enrollmentType: 'CONTINUING',
      });

    expect(next.status).toBe(201);

    const history = await request(app)
      .get(`/api/v1/students/${studentId}/enrolments`)
      .set('Authorization', bearer(adminSession));

    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.map((item: { status: string }) => item.status)).toContain('PROMOTED');
    expect(history.body.data.map((item: { status: string }) => item.status)).toContain('ENROLLED');
  });

  it('refuses a second live enrolment in the same year', async () => {
    // Two would mean two sets of term charges for one student.
    const response = await request(app)
      .post('/api/v1/enrolments')
      .set('Authorization', bearer(adminSession))
      .send({ studentId, levelId: academic.levelIds[1] });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/already enrolled/i);
  });

  it('moves a student between classes in the same level', async () => {
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { studentId } });

    const response = await request(app)
      .patch(`/api/v1/enrolments/${enrollment.id}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: enrollment.version, classSectionId: academic.spareClassSectionId });

    expect(response.status).toBe(200);
    expect(response.body.data.classSectionName).toBe('S1 B');
  });

  it('refuses to change an enrolment that has already ended', async () => {
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { studentId } });
    await request(app)
      .post(`/api/v1/enrolments/${enrollment.id}/end`)
      .set('Authorization', bearer(adminSession))
      .send({ status: 'WITHDRAWN', exitReason: 'Left' });

    const response = await request(app)
      .patch(`/api/v1/enrolments/${enrollment.id}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: enrollment.version + 1, classSectionId: null });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
  });

  it('refuses an enrolment that ends before it starts', async () => {
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { studentId } });

    const response = await request(app)
      .post(`/api/v1/enrolments/${enrollment.id}/end`)
      .set('Authorization', bearer(adminSession))
      .send({ status: 'WITHDRAWN', endDate: '2025-01-01', exitReason: 'Impossible' });

    expect(response.status).toBe(400);
  });
});
