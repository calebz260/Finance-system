/**
 * The academic structure: periods, programmes, levels and classes.
 *
 * These are configuration rather than transactions, but every financial record in
 * later phases is scoped by them, so the invariants are financial ones in disguise: a
 * charge belongs to exactly one term, "the current year" has exactly one answer, and
 * promotion walks a chain that must terminate.
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
} from './helpers/auth.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';

const app: Express = createApp();

let roleIds = new Map<string, string>();
let schoolId = '';
let academic: AcademicFixture;
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

  adminSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'admin@gskicukiro.invalid',
      roleKeys: [RoleKey.SCHOOL_ADMIN],
      schoolId,
    }),
  );
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

describe('reading the structure', () => {
  it('lets a bursar read it, since a payment cannot be recorded without it', async () => {
    const response = await request(app)
      .get('/api/v1/academic-years')
      .set('Authorization', bearer(bursarSession));

    expect(response.status).toBe(200);
    expect(response.body.data[0].terms).toHaveLength(3);
  });

  it('refuses a parent, who sees their own children rather than the configuration', async () => {
    const response = await request(app)
      .get('/api/v1/academic-years')
      .set('Authorization', bearer(parentSession));

    expect(response.status).toBe(403);
  });

  it('answers null for the current year rather than 404 when none is set', async () => {
    // A school that has not configured a year is in a normal setup state, and the
    // screen has to say so rather than render an error.
    await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });

    const response = await request(app)
      .get('/api/v1/academic-years/current')
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
  });
});

describe('academic years', () => {
  function createYear(body: Record<string, unknown>): request.Test {
    return request(app)
      .post('/api/v1/academic-years')
      .set('Authorization', bearer(adminSession))
      .send(body);
  }

  it('creates a year', async () => {
    const response = await createYear({
      name: '2027',
      startDate: '2027-01-11',
      endDate: '2027-11-05',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('UPCOMING');
    expect(response.body.data.isCurrent).toBe(false);
  });

  it('refuses a year that ends before it starts', async () => {
    const response = await createYear({
      name: '2027',
      startDate: '2027-11-05',
      endDate: '2027-01-11',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('refuses a date that does not exist', async () => {
    const response = await createYear({
      name: '2027',
      startDate: '2027-02-31',
      endDate: '2027-11-05',
    });

    expect(response.status).toBe(400);
  });

  it('keeps exactly one year current', async () => {
    // Enrolment, fee structures and every "current" report resolve through this, so
    // two answers would be worse than none.
    const next = await createYear({
      name: '2027',
      startDate: '2027-01-11',
      endDate: '2027-11-05',
    });

    const response = await request(app)
      .put(`/api/v1/academic-years/${next.body.data.id as string}/current`)
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(200);
    expect(response.body.data.isCurrent).toBe(true);

    const current = await prisma.academicYear.count({ where: { schoolId, isCurrent: true } });
    expect(current).toBe(1);
  });

  it('refuses to make a closed year current', async () => {
    const closed = await createYear({
      name: '2024',
      startDate: '2024-01-08',
      endDate: '2024-11-01',
      status: 'CLOSED',
    });

    const response = await request(app)
      .put(`/api/v1/academic-years/${closed.body.data.id as string}/current`)
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
  });

  it('refuses to reopen a closed year', async () => {
    // A closed period is the boundary a reconciliation was signed off against.
    const closed = await createYear({
      name: '2024',
      startDate: '2024-01-08',
      endDate: '2024-11-01',
      status: 'CLOSED',
    });

    const response = await request(app)
      .patch(`/api/v1/academic-years/${closed.body.data.id as string}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: closed.body.data.version, status: 'ACTIVE' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/cannot be reopened/i);
  });

  it('refuses a bursar, who reads the structure but does not configure it', async () => {
    const response = await request(app)
      .post('/api/v1/academic-years')
      .set('Authorization', bearer(bursarSession))
      .send({ name: '2027', startDate: '2027-01-11', endDate: '2027-11-05' });

    expect(response.status).toBe(403);
  });
});

describe('terms', () => {
  function createTerm(body: Record<string, unknown>): request.Test {
    return request(app)
      .post('/api/v1/terms')
      .set('Authorization', bearer(adminSession))
      .send({ academicYearId: academic.academicYearId, ...body });
  }

  it('refuses a term that falls outside its academic year', async () => {
    // A date outside every term belongs to no term, and a charge scoped by term then
    // has nowhere to go.
    const response = await createTerm({
      name: 'Term 4',
      sequence: 4,
      startDate: '2026-11-10',
      endDate: '2026-12-20',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/must fall within/i);
  });

  it('refuses a term that overlaps another', async () => {
    // A date inside two terms belongs to two, which is worse.
    const response = await createTerm({
      name: 'Overlapping',
      sequence: 4,
      startDate: '2026-03-01',
      endDate: '2026-05-01',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/overlap/i);
  });

  it('accepts a term in a genuine gap between two others', async () => {
    const response = await createTerm({
      name: 'Short break term',
      sequence: 4,
      startDate: '2026-04-06',
      endDate: '2026-04-17',
    });

    expect(response.status).toBe(201);
  });

  it('keeps exactly one term current', async () => {
    const secondTerm = academic.termIds[1]!;

    await request(app)
      .put(`/api/v1/terms/${secondTerm}/current`)
      .set('Authorization', bearer(adminSession));

    const current = await prisma.term.findMany({ where: { schoolId, isCurrent: true } });
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(secondTerm);
  });

  it('rejects an edit built on a stale version', async () => {
    const termId = academic.termIds[0]!;
    const term = await prisma.term.findUniqueOrThrow({ where: { id: termId } });

    await request(app)
      .patch(`/api/v1/terms/${termId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: term.version, name: 'First term' });

    const stale = await request(app)
      .patch(`/api/v1/terms/${termId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: term.version, name: 'Term one' });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe(ErrorCode.RECORD_MODIFIED);
  });
});

describe('programmes and levels', () => {
  it('creates a programme and its levels', async () => {
    const program = await request(app)
      .post('/api/v1/programs')
      .set('Authorization', bearer(adminSession))
      .send({ code: 'ALEVEL', name: 'Advanced Level', durationYears: 2 });

    expect(program.status).toBe(201);

    const level = await request(app)
      .post('/api/v1/levels')
      .set('Authorization', bearer(adminSession))
      .send({
        programId: program.body.data.id,
        code: 'S4',
        name: 'Senior 4',
        sequence: 1,
      });

    expect(level.status).toBe(201);
    expect(level.body.data.programName).toBe('Advanced Level');
  });

  it('refuses a duplicate programme code within the school', async () => {
    const response = await request(app)
      .post('/api/v1/programs')
      .set('Authorization', bearer(adminSession))
      .send({ code: academic.programCode, name: 'Duplicate' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it('discontinues a programme without touching its history', async () => {
    // Existing enrolments reference it; rewriting them to hide that it was offered
    // would falsify the record.
    const program = await prisma.program.findUniqueOrThrow({ where: { id: academic.programId } });

    const response = await request(app)
      .patch(`/api/v1/programs/${academic.programId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: program.version, status: 'DISCONTINUED' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('DISCONTINUED');
    expect(await prisma.level.count({ where: { programId: academic.programId } })).toBe(3);
  });

  it('exposes the level chain promotion walks', async () => {
    const response = await request(app)
      .get('/api/v1/levels')
      .query({ programId: academic.programId })
      .set('Authorization', bearer(adminSession));

    const levels = response.body.data as Array<{
      code: string;
      nextLevelId: string | null;
      isTerminal: boolean;
    }>;

    const s1 = levels.find((level) => level.code === 'S1');
    const s3 = levels.find((level) => level.code === 'S3');
    expect(s1?.nextLevelId).toBe(academic.levelIds[1]);
    expect(s3?.nextLevelId).toBeNull();
    expect(s3?.isTerminal).toBe(true);
  });

  it('refuses a level that points at itself', async () => {
    const levelId = academic.levelIds[0]!;

    const response = await request(app)
      .put(`/api/v1/levels/${levelId}/next`)
      .set('Authorization', bearer(adminSession))
      .send({ nextLevelId: levelId });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/never end/i);
  });

  it('refuses a chain that would loop', async () => {
    // S1 -> S2 -> S3 already; pointing S3 back at S1 would make promotion run forever.
    const response = await request(app)
      .put(`/api/v1/levels/${academic.levelIds[2]!}/next`)
      .set('Authorization', bearer(adminSession))
      .send({ nextLevelId: academic.levelIds[0] });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/loop/i);
  });

  it('refuses a chain across two programmes', async () => {
    // Promotion would otherwise move a student between programmes silently.
    const tradeLevel = await prisma.level.findFirstOrThrow({
      where: { programId: academic.tradeProgramId },
    });

    const response = await request(app)
      .put(`/api/v1/levels/${academic.levelIds[2]!}/next`)
      .set('Authorization', bearer(adminSession))
      .send({ nextLevelId: tradeLevel.id });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/same programme/i);
  });

  it('allows unchaining a level, which is how a terminal level is expressed', async () => {
    const response = await request(app)
      .put(`/api/v1/levels/${academic.levelIds[1]!}/next`)
      .set('Authorization', bearer(adminSession))
      .send({ nextLevelId: null });

    expect(response.status).toBe(200);
    expect(response.body.data.nextLevelId).toBeNull();
  });
});

describe('class sections', () => {
  it('reports live occupancy, not historical', async () => {
    const response = await request(app)
      .get('/api/v1/class-sections')
      .query({ academicYearId: academic.academicYearId })
      .set('Authorization', bearer(adminSession));

    const section = (response.body.data as Array<{ id: string; enrolledCount: number }>).find(
      (item) => item.id === academic.classSectionId,
    );
    expect(section?.enrolledCount).toBe(0);
  });

  it('allows capacity to be lowered below current occupancy', async () => {
    // The number is a planning guide. Refusing the edit would leave an administrator
    // unable to record a room that genuinely shrank; enrolment is what enforces it.
    const section = await prisma.classSection.findUniqueOrThrow({
      where: { id: academic.classSectionId },
    });

    const response = await request(app)
      .patch(`/api/v1/class-sections/${academic.classSectionId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: section.version, capacity: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.capacity).toBe(1);
  });

  it('refuses a class for a level that does not exist', async () => {
    const response = await request(app)
      .post('/api/v1/class-sections')
      .set('Authorization', bearer(adminSession))
      .send({
        academicYearId: academic.academicYearId,
        levelId: '11111111-1111-4111-8111-111111111111',
        code: 'C',
        name: 'Ghost class',
      });

    expect(response.status).toBe(404);
  });
});

describe('tenant scoping', () => {
  it('does not show another school`s structure', async () => {
    const otherSchoolId = await createSchool('GSN', 'GS Nyamirambo');
    await seedAcademicStructure(otherSchoolId, { yearName: '2026-other' });

    const response = await request(app)
      .get('/api/v1/academic-years')
      .set('Authorization', bearer(adminSession));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe('2026');
  });
});
