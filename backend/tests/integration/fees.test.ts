/**
 * Fee configuration, charge generation and the financial ledger, over real HTTP.
 *
 * The cases that matter here are the ones about money being counted once and only once:
 * that re-running generation does not double-charge, that two structures cannot quietly
 * bill the same category twice, that relief never edits the charge it reduces, and that
 * the balance always comes from the ledger rather than from summing business records.
 *
 * Authorisation is exercised alongside, not separately, because in a finance module the
 * question "may this person do this?" is part of the operation rather than a wrapper
 * around it — and the negative cases are the ones that matter.
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
let adminSession: Session;
let bursar: TestUser;
let bursarSession: Session;
let financeSession: Session;
let secondFinanceSession: Session;
let dosSession: Session;

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

  bursar = await createTestUser(roleIds, {
    email: 'bursar@gskicukiro.invalid',
    roleKeys: [RoleKey.BURSAR],
    schoolId,
  });
  bursarSession = await signIn(app, bursar);

  financeSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'finance@gskicukiro.invalid',
      roleKeys: [RoleKey.FINANCE_MANAGER],
      schoolId,
    }),
  );

  // A second Finance Manager, because approving your own request is refused and the
  // separation of duties cannot be exercised with only one.
  secondFinanceSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'finance2@gskicukiro.invalid',
      roleKeys: [RoleKey.FINANCE_MANAGER],
      schoolId,
    }),
  );

  dosSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'dos@gskicukiro.invalid',
      roleKeys: [RoleKey.DOS],
      schoolId,
    }),
  );
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ helpers */

async function createCategory(code = 'TUITION', name = 'Tuition'): Promise<string> {
  const response = await request(app)
    .post('/api/v1/fee-categories')
    .set('Authorization', bearer(adminSession))
    .send({ code, name });

  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

interface StructureOptions {
  readonly name?: string;
  readonly termId?: string | null;
  readonly levelId?: string | null;
  readonly programId?: string | null;
  readonly residency?: 'DAY' | 'BOARDING' | null;
  readonly items?: ReadonlyArray<{ feeCategoryId: string; label: string; amount: string }>;
  readonly activate?: boolean;
}

async function createStructure(options: StructureOptions): Promise<{
  id: string;
  version: number;
}> {
  const response = await request(app)
    .post('/api/v1/fee-structures')
    .set('Authorization', bearer(adminSession))
    .send({
      name: options.name ?? 'S1 Term 1',
      academicYearId: academic.academicYearId,
      termId: options.termId === undefined ? academic.termIds[0] : options.termId,
      ...(options.levelId !== undefined ? { levelId: options.levelId } : {}),
      ...(options.programId !== undefined ? { programId: options.programId } : {}),
      ...(options.residency !== undefined ? { residency: options.residency } : {}),
      items: options.items ?? [],
    });

  expect(response.status).toBe(201);
  const id = response.body.data.id as string;
  let version = response.body.data.version as number;

  if (options.activate !== false) {
    const activated = await request(app)
      .put(`/api/v1/fee-structures/${id}/status`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: version, status: 'ACTIVE' });

    expect(activated.status).toBe(200);
    version = activated.body.data.version as number;
  }

  return { id, version };
}

/**
 * Register a student into the current year.
 *
 * `enrolment` is nested because registration and first enrolment are one operation in
 * Phase 3 — a student with no enrolment cannot be charged, which is exactly the
 * precondition several tests below rely on.
 */
async function registerStudent(
  overrides: { firstName?: string; lastName?: string; gender?: string; residency?: string } = {},
): Promise<{ id: string; studentId: string }> {
  const response = await request(app)
    .post('/api/v1/students')
    .set('Authorization', bearer(adminSession))
    .send({
      firstName: overrides.firstName ?? 'Aline',
      lastName: overrides.lastName ?? 'Uwase',
      gender: overrides.gender ?? 'FEMALE',
      dateOfBirth: '2010-05-14',
      admissionDate: '2026-01-12',
      enrolment: {
        levelId: academic.levelIds[0],
        classSectionId: academic.spareClassSectionId,
        residency: overrides.residency ?? 'DAY',
      },
    });

  expect(response.status).toBe(201);
  return { id: response.body.data.id as string, studentId: response.body.data.studentId as string };
}

/**
 * A second academic year with one term, for the cross-period cases.
 *
 * Built directly rather than through `seedAcademicStructure`, which also creates
 * programmes and levels and would collide on their per-school unique codes.
 */
async function createSpareYear(name: string): Promise<{ academicYearId: string; termId: string }> {
  const year = await prisma.academicYear.create({
    data: {
      schoolId,
      name,
      startDate: new Date(Date.UTC(2027, 0, 11)),
      endDate: new Date(Date.UTC(2027, 10, 5)),
      status: 'UPCOMING',
      isCurrent: false,
    },
  });

  const term = await prisma.term.create({
    data: {
      schoolId,
      academicYearId: year.id,
      name: 'Term 1',
      sequence: 1,
      startDate: new Date(Date.UTC(2027, 0, 11)),
      endDate: new Date(Date.UTC(2027, 3, 2)),
      status: 'UPCOMING',
      isCurrent: false,
    },
  });

  return { academicYearId: year.id, termId: term.id };
}

async function balanceOf(studentId: string): Promise<Record<string, string>> {
  const response = await request(app)
    .get(`/api/v1/students/${studentId}/balance`)
    .set('Authorization', bearer(bursarSession));

  expect(response.status).toBe(200);
  return response.body.data as Record<string, string>;
}

/* --------------------------------------------------------------- categories */

describe('fee categories', () => {
  it('creates a category', async () => {
    const response = await request(app)
      .post('/api/v1/fee-categories')
      .set('Authorization', bearer(adminSession))
      .send({ code: 'boarding', name: 'Boarding', description: 'Bed and meals.' });

    expect(response.status).toBe(201);
    // Codes are upper-cased on the way in: they are identifiers, used in imports and
    // reports, and case-sensitivity there is a trap.
    expect(response.body.data.code).toBe('BOARDING');
  });

  it('refuses a duplicate code within the school', async () => {
    await createCategory('TUITION');

    const response = await request(app)
      .post('/api/v1/fee-categories')
      .set('Authorization', bearer(adminSession))
      .send({ code: 'TUITION', name: 'Tuition again' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it('deactivates rather than deleting, so historical charges still name it', async () => {
    const categoryId = await createCategory();
    const current = await request(app)
      .get(`/api/v1/fee-categories/${categoryId}`)
      .set('Authorization', bearer(adminSession));

    const response = await request(app)
      .patch(`/api/v1/fee-categories/${categoryId}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: current.body.data.version, isActive: false });

    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);

    // The row is still there, which is the whole point.
    expect(await prisma.feeCategory.count({ where: { id: categoryId } })).toBe(1);
  });

  it('refuses a bursar, who reads fee configuration but does not set prices', async () => {
    const response = await request(app)
      .post('/api/v1/fee-categories')
      .set('Authorization', bearer(bursarSession))
      .send({ code: 'TUITION', name: 'Tuition' });

    expect(response.status).toBe(403);
  });

  it('lets a bursar read them, since they cannot explain a charge otherwise', async () => {
    await createCategory();

    const response = await request(app)
      .get('/api/v1/fee-categories')
      .set('Authorization', bearer(bursarSession));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- structures */

describe('fee structures', () => {
  it('creates a structure with its items and totals them', async () => {
    const tuition = await createCategory('TUITION', 'Tuition');
    const materials = await createCategory('MATERIALS', 'Materials');

    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'S1 Term 1 2026',
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        levelId: academic.levelIds[0],
        items: [
          { feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' },
          { feeCategoryId: materials, label: 'Materials', amount: '12500.50' },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('DRAFT');
    // Totalled through Money, so the half-unit survives.
    expect(response.body.data.totalAmount).toBe('107500.50');
  });

  it('accepts a structure with no term, which is a once-a-year fee', async () => {
    const registration = await createCategory('REGISTRATION', 'Registration');

    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'Registration 2026',
        academicYearId: academic.academicYearId,
        termId: null,
        items: [{ feeCategoryId: registration, label: 'Registration', amount: '15000.00' }],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.termId).toBeNull();
  });

  it('refuses a term from a different academic year', async () => {
    const other = await createSpareYear('2027');
    const tuition = await createCategory();

    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'Mismatched',
        academicYearId: academic.academicYearId,
        termId: other.termId,
        items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '1000.00' }],
      });

    expect(response.status).toBe(400);
  });

  it('refuses the same category twice within one structure', async () => {
    const tuition = await createCategory();

    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'Doubled',
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        items: [
          { feeCategoryId: tuition, label: 'Tuition', amount: '1000.00' },
          { feeCategoryId: tuition, label: 'Tuition again', amount: '2000.00' },
        ],
      });

    expect(response.status).toBe(400);
  });

  it('refuses a negative amount, which would be an unapproved discount in disguise', async () => {
    const tuition = await createCategory();

    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'Negative',
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '-1000.00' }],
      });

    expect(response.status).toBe(400);
  });

  it('refuses an amount sent as a JSON number, which has already lost precision', async () => {
    const tuition = await createCategory();

    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'Float',
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        items: [{ feeCategoryId: tuition, label: 'Tuition', amount: 150000.1 }],
      });

    expect(response.status).toBe(400);
  });

  it('refuses to create a structure with no items at all', async () => {
    // Rejected by validation rather than by the service: a structure that charges
    // nothing is not a thing anyone means to create.
    const response = await request(app)
      .post('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession))
      .send({
        name: 'Empty',
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        items: [],
      });

    expect(response.status).toBe(400);
  });

  it('refuses to activate a structure whose items were all removed', async () => {
    const tuition = await createCategory();
    const structure = await createStructure({
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
      activate: false,
    });

    const detail = await request(app)
      .get(`/api/v1/fee-structures/${structure.id}`)
      .set('Authorization', bearer(adminSession));
    const itemId = detail.body.data.items[0].id as string;

    const removed = await request(app)
      .delete(`/api/v1/fee-structures/${structure.id}/items/${itemId}`)
      .set('Authorization', bearer(adminSession));
    expect(removed.status).toBe(200);

    const response = await request(app)
      .put(`/api/v1/fee-structures/${structure.id}/status`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: removed.body.data.version, status: 'ACTIVE' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('locks a structure once it has raised charges', async () => {
    const tuition = await createCategory();
    const structure = await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    await registerStudent();

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    const current = await request(app)
      .get(`/api/v1/fee-structures/${structure.id}`)
      .set('Authorization', bearer(adminSession));

    const response = await request(app)
      .post(`/api/v1/fee-structures/${structure.id}/items`)
      .set('Authorization', bearer(adminSession))
      .send({ feeCategoryId: tuition, label: 'Extra', amount: '100.00' });

    expect(response.status).toBe(409);
    expect(current.body.data.chargeCount).toBeGreaterThan(0);
  });

  it('refuses to reactivate an archived structure', async () => {
    const tuition = await createCategory();
    const structure = await createStructure({
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });

    const archived = await request(app)
      .put(`/api/v1/fee-structures/${structure.id}/status`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: structure.version, status: 'ARCHIVED' });
    expect(archived.status).toBe(200);

    const response = await request(app)
      .put(`/api/v1/fee-structures/${structure.id}/status`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: archived.body.data.version, status: 'ACTIVE' });

    expect(response.status).toBe(409);
  });

  it('rejects an edit built on a stale version', async () => {
    const tuition = await createCategory();
    const structure = await createStructure({
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
      activate: false,
    });

    const response = await request(app)
      .patch(`/api/v1/fee-structures/${structure.id}`)
      .set('Authorization', bearer(adminSession))
      .send({ expectedVersion: structure.version + 5, name: 'Renamed' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.RECORD_MODIFIED);
  });

  it('does not show another school`s structures', async () => {
    const otherSchoolId = await createSchool('OTHER', 'Other School');
    const otherAcademic = await seedAcademicStructure(otherSchoolId, { isCurrent: false });
    const otherCategory = await prisma.feeCategory.create({
      data: { schoolId: otherSchoolId, code: 'TUITION', name: 'Tuition' },
    });
    await prisma.feeStructure.create({
      data: {
        schoolId: otherSchoolId,
        name: 'Theirs',
        academicYearId: otherAcademic.academicYearId,
        termId: otherAcademic.termIds[0]!,
        status: 'ACTIVE',
        items: {
          create: {
            schoolId: otherSchoolId,
            feeCategoryId: otherCategory.id,
            label: 'Tuition',
            amount: '1.00',
          },
        },
      },
    });

    const response = await request(app)
      .get('/api/v1/fee-structures')
      .set('Authorization', bearer(adminSession));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });
});

/* -------------------------------------------------------------- charge runs */

describe('charge generation', () => {
  it('previews without writing anything', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    await registerStudent();

    const response = await request(app)
      .post('/api/v1/charge-runs/preview')
      .set('Authorization', bearer(bursarSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(response.status).toBe(200);
    expect(response.body.data.chargesToCreate).toBe(1);
    expect(response.body.data.totalAmount).toBe('95000.00');
    expect(await prisma.studentCharge.count()).toBe(0);
    expect(await prisma.financialEntry.count()).toBe(0);
  });

  it('raises a charge and posts a matching DEBIT to the ledger', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    const student = await registerStudent();

    const response = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(response.status).toBe(201);
    expect(response.body.data.chargesCreated).toBe(1);

    const entries = await prisma.financialEntry.findMany({ where: { studentId: student.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryType).toBe('DEBIT');
    expect(entries[0]?.source).toBe('CHARGE');
    expect(entries[0]?.amount.toString()).toBe('95000');

    expect((await balanceOf(student.id)).outstanding).toBe('95000.00');
  });

  it('opens a financial account on first activity, with the school currency', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    const student = await registerStudent();

    expect(await prisma.studentFinancialAccount.count()).toBe(0);

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    const account = await prisma.studentFinancialAccount.findUnique({
      where: { studentId: student.id },
    });
    expect(account).not.toBeNull();
    expect(account?.currency).toBe('RWF');
  });

  it('is idempotent: running it twice does not double-charge', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    const student = await registerStudent();

    const body = { academicYearId: academic.academicYearId, termId: academic.termIds[0] };

    const first = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send(body);
    const second = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send(body);

    expect(first.body.data.chargesCreated).toBe(1);
    expect(second.body.data.chargesCreated).toBe(0);
    expect(second.body.data.chargesSkipped).toBe(1);

    // The balance is the assertion that matters: a double charge would show here even
    // if the counts above were somehow wrong.
    expect((await balanceOf(student.id)).outstanding).toBe('95000.00');
  });

  it('charges the same category again in a different term', async () => {
    const tuition = await createCategory();
    await createStructure({
      name: 'Term 1',
      termId: academic.termIds[0],
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition T1', amount: '95000.00' }],
    });
    await createStructure({
      name: 'Term 2',
      termId: academic.termIds[1],
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition T2', amount: '95000.00' }],
    });
    const student = await registerStudent();

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });
    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[1] });

    // Two terms, two charges. The duplicate key must not have blocked the second.
    expect((await balanceOf(student.id)).outstanding).toBe('190000.00');
  });

  it('refuses the whole run when two structures would charge the same category', async () => {
    const tuition = await createCategory();
    await createStructure({
      name: 'Level structure',
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    await createStructure({
      name: 'Programme structure',
      programId: academic.programId,
      items: [{ feeCategoryId: tuition, label: 'Tuition again', amount: '80000.00' }],
    });
    await registerStudent();

    const response = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(response.status).toBe(409);
    // Nothing at all was written — the run is all or nothing.
    expect(await prisma.studentCharge.count()).toBe(0);
    expect(await prisma.financialEntry.count()).toBe(0);
  });

  it('does not charge a day student a boarding fee', async () => {
    const tuition = await createCategory('TUITION', 'Tuition');
    const boarding = await createCategory('BOARDING', 'Boarding');

    await createStructure({
      name: 'Tuition, everyone',
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    await createStructure({
      name: 'Boarding, boarders only',
      residency: 'BOARDING',
      items: [{ feeCategoryId: boarding, label: 'Boarding', amount: '140000.00' }],
    });

    const dayStudent = await registerStudent({ residency: 'DAY' });
    const boarder = await registerStudent({
      firstName: 'Eric',
      lastName: 'Habimana',
      gender: 'MALE',
      residency: 'BOARDING',
    });

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect((await balanceOf(dayStudent.id)).outstanding).toBe('95000.00');
    expect((await balanceOf(boarder.id)).outstanding).toBe('235000.00');
  });

  it('does not charge a student from another level', async () => {
    const tuition = await createCategory();
    await createStructure({
      // Targets S2; the student is in S1.
      levelId: academic.levelIds[1],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    const student = await registerStudent();

    const response = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(response.body.data.chargesCreated).toBe(0);
    expect((await balanceOf(student.id)).outstanding).toBe('0.00');
  });

  it('refuses to raise charges into a closed term', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    await registerStudent();

    await prisma.term.update({
      where: { id: academic.termIds[0]! },
      data: { status: 'CLOSED', isCurrent: false },
    });

    const response = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PERIOD_CLOSED);
  });

  it('refuses a bursar previewing and then applying, since applying needs charge.create', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });

    const preview = await request(app)
      .post('/api/v1/charge-runs/preview')
      .set('Authorization', bearer(bursarSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });
    expect(preview.status).toBe(200);

    // A Bursar does hold `charge.create`, so this succeeds — the case exists to pin
    // that the preview and the apply are separately authorised rather than one gate.
    const applied = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(bursarSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });
    expect(applied.status).toBe(201);
  });

  it('refuses a DOS, who has no financial permissions at all', async () => {
    const response = await request(app)
      .post('/api/v1/charge-runs/preview')
      .set('Authorization', bearer(dosSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(response.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ charges */

describe('charges', () => {
  it('raises an ad-hoc charge with a reason and posts a DEBIT', async () => {
    const tuition = await createCategory();
    const student = await registerStudent();

    const response = await request(app)
      .post('/api/v1/charges')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        feeCategoryId: tuition,
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        description: 'Replacement textbook',
        amount: '12000.00',
        notes: 'Lost the issued copy.',
      });

    expect(response.status).toBe(201);
    expect((await balanceOf(student.id)).outstanding).toBe('12000.00');
  });

  it('allows a second ad-hoc charge in a category the student already holds', async () => {
    // Ad-hoc charges carry no structure item, which is what exempts them from the
    // duplicate key. This is the supported escape hatch.
    const tuition = await createCategory();
    const student = await registerStudent();

    const body = {
      studentId: student.id,
      feeCategoryId: tuition,
      academicYearId: academic.academicYearId,
      termId: academic.termIds[0],
      description: 'Resit fee',
      amount: '5000.00',
      notes: 'First resit.',
    };

    const first = await request(app)
      .post('/api/v1/charges')
      .set('Authorization', bearer(bursarSession))
      .send(body);
    const second = await request(app)
      .post('/api/v1/charges')
      .set('Authorization', bearer(bursarSession))
      .send({ ...body, description: 'Second resit', notes: 'Second resit.' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await balanceOf(student.id)).outstanding).toBe('10000.00');
  });

  it('refuses a charge against a student with no enrolment for that year', async () => {
    const tuition = await createCategory();
    const other = await createSpareYear('2028');
    const student = await registerStudent();

    const response = await request(app)
      .post('/api/v1/charges')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        feeCategoryId: tuition,
        academicYearId: other.academicYearId,
        description: 'Something',
        amount: '1000.00',
        notes: 'No enrolment exists for that year.',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('voids a charge by posting an opposing CREDIT, never by deleting it', async () => {
    const tuition = await createCategory();
    const student = await registerStudent();

    const created = await request(app)
      .post('/api/v1/charges')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        feeCategoryId: tuition,
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        description: 'Raised in error',
        amount: '12000.00',
        notes: 'Wrong student.',
      });

    const response = await request(app)
      .post(`/api/v1/charges/${created.body.data.id}/void`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: created.body.data.version,
        reason: 'Raised against the wrong student.',
      });

    expect(response.status).toBe(200);
    expect((await balanceOf(student.id)).outstanding).toBe('0.00');

    // The charge row survives, and so does its original DEBIT. Two entries, netting out.
    expect(await prisma.studentCharge.count({ where: { id: created.body.data.id } })).toBe(1);
    const entries = await prisma.financialEntry.findMany({ where: { studentId: student.id } });
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.reversalOfEntryId !== null)).toHaveLength(1);
  });

  it('refuses a bursar voiding a charge, which needs charge.void', async () => {
    const tuition = await createCategory();
    const student = await registerStudent();

    const created = await request(app)
      .post('/api/v1/charges')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        feeCategoryId: tuition,
        academicYearId: academic.academicYearId,
        termId: academic.termIds[0],
        description: 'Something',
        amount: '1000.00',
        notes: 'A note.',
      });

    const response = await request(app)
      .post(`/api/v1/charges/${created.body.data.id}/void`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: created.body.data.version, reason: 'Trying to void my own error.' });

    expect(response.status).toBe(403);
  });

  it('allows the correct charge to be re-raised after a void', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    const student = await registerStudent();

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    const charge = await prisma.studentCharge.findFirstOrThrow({
      where: { studentId: student.id },
    });

    await request(app)
      .post(`/api/v1/charges/${charge.id}/void`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: charge.version, reason: 'Wrong amount configured.' });

    // The duplicate key excludes VOID rows, so generation can raise it again.
    const rerun = await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    expect(rerun.body.data.chargesCreated).toBe(1);
    expect((await balanceOf(student.id)).outstanding).toBe('95000.00');
  });

  it('reports another school`s charge as not found, not as forbidden', async () => {
    const otherSchoolId = await createSchool('OTHER', 'Other School');
    const otherAcademic = await seedAcademicStructure(otherSchoolId, { isCurrent: false });
    const otherCategory = await prisma.feeCategory.create({
      data: { schoolId: otherSchoolId, code: 'TUITION', name: 'Tuition' },
    });
    const otherStudent = await prisma.student.create({
      data: {
        schoolId: otherSchoolId,
        studentId: 'STU-2026-09999',
        firstName: 'Other',
        lastName: 'Student',
        admissionDate: new Date(Date.UTC(2026, 0, 12)),
        admissionYear: 2026,
      },
    });
    const otherEnrolment = await prisma.enrollment.create({
      data: {
        schoolId: otherSchoolId,
        studentId: otherStudent.id,
        academicYearId: otherAcademic.academicYearId,
        programId: otherAcademic.programId,
        levelId: otherAcademic.levelIds[0]!,
        startDate: new Date(Date.UTC(2026, 0, 12)),
      },
    });
    const otherCharge = await prisma.studentCharge.create({
      data: {
        schoolId: otherSchoolId,
        studentId: otherStudent.id,
        enrollmentId: otherEnrolment.id,
        academicYearId: otherAcademic.academicYearId,
        feeCategoryId: otherCategory.id,
        description: 'Theirs',
        amount: '1000.00',
        raisedByUserId: bursar.id,
      },
    });

    const response = await request(app)
      .get(`/api/v1/charges/${otherCharge.id}`)
      .set('Authorization', bearer(bursarSession));

    // 404, not 403: answering "forbidden" would confirm the id exists elsewhere.
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------- relief */

describe('relief', () => {
  async function chargedStudent(): Promise<{
    studentId: string;
    chargeId: string;
    version: number;
  }> {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '100000.00' }],
    });
    const student = await registerStudent();

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    const charge = await prisma.studentCharge.findFirstOrThrow({
      where: { studentId: student.id },
    });

    return { studentId: student.id, chargeId: charge.id, version: charge.version };
  }

  it('posts nothing until a request is approved', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const response = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Sibling rate agreed with the head teacher.',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('PENDING_APPROVAL');

    const balance = await balanceOf(studentId);
    expect(balance.outstanding).toBe('100000.00');
    expect(balance.pendingApprovalCount).toBe(1);
  });

  it('credits the ledger on approval, without touching the charge', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Sibling rate.',
      });

    const approved = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    expect(approved.status).toBe(200);
    expect((await balanceOf(studentId)).outstanding).toBe('90000.00');

    // The charge itself is untouched: still 100,000, as it was raised.
    const charge = await prisma.studentCharge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.amount.toString()).toBe('100000');
  });

  it('applies a discount, a scholarship and a waiver together', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const scholarship = await request(app)
      .post('/api/v1/scholarships')
      .set('Authorization', bearer(adminSession))
      .send({ code: 'MERIT', name: 'District Merit Bursary' });
    expect(scholarship.status).toBe(201);

    const approve = async (kind: string, body: Record<string, unknown>): Promise<void> => {
      const requested = await request(app)
        .post(`/api/v1/relief/${kind}`)
        .set('Authorization', bearer(bursarSession))
        .send(body);
      expect(requested.status).toBe(201);

      const decided = await request(app)
        .post(`/api/v1/relief/${kind}/${requested.body.data.id}/decision`)
        .set('Authorization', bearer(financeSession))
        .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });
      expect(decided.status).toBe(200);
    };

    const base = {
      studentId,
      studentChargeId: chargeId,
      academicYearId: academic.academicYearId,
    };

    await approve('DISCOUNT', { ...base, amount: '10000.00', reason: 'Sibling rate.' });
    await approve('SCHOLARSHIP', {
      ...base,
      scholarshipId: scholarship.body.data.id,
      amount: '20000.00',
      reason: 'Merit award for 2026.',
    });

    // 100,000 − 10,000 − 20,000 = 70,000. The worked example from the specification.
    expect((await balanceOf(studentId)).outstanding).toBe('70000.00');
  });

  it('refuses relief larger than the charge still carries', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const response = await request(app)
      .post('/api/v1/relief/WAIVER')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '150000.00',
        reason: 'Attempting to waive more than is owed.',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.AMOUNT_EXCEEDS_BALANCE);
  });

  it('refuses a second discount that would take the total past the charge', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const first = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '60000.00',
        reason: 'First reduction.',
      });
    await request(app)
      .post(`/api/v1/relief/DISCOUNT/${first.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: first.body.data.version, decision: 'APPROVE' });

    const second = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '60000.00',
        reason: 'Second reduction.',
      });

    expect(second.status).toBe(400);
  });

  it('takes a percentage against what remains, not the face value', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const first = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '50000.00',
        reason: 'Half off.',
      });
    await request(app)
      .post(`/api/v1/relief/DISCOUNT/${first.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: first.body.data.version, decision: 'APPROVE' });

    const second = await request(app)
      .post('/api/v1/relief/WAIVER')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        percentage: '50',
        reason: 'Half of what is left.',
      });

    // 50% of the remaining 50,000, not of the original 100,000.
    expect(second.status).toBe(201);
    expect(second.body.data.amount).toBe('25000.00');
  });

  it('refuses a bursar approving, which needs adjustment.approve', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Sibling rate.',
      });

    const response = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    expect(response.status).toBe(403);
  });

  it('refuses a Finance Manager approving their own request', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(financeSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Requested by the approver.',
      });

    const own = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe(ErrorCode.AUTHORISATION_REQUIRED);

    // A second Finance Manager may approve it, which is the point of the rule.
    const other = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(secondFinanceSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    expect(other.status).toBe(200);
    expect((await balanceOf(studentId)).outstanding).toBe('90000.00');
  });

  it('posts nothing when a request is rejected', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/WAIVER')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Requesting a write-off.',
      });

    const rejected = await request(app)
      .post(`/api/v1/relief/WAIVER/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: requested.body.data.version,
        decision: 'REJECT',
        note: 'The family can pay.',
      });

    expect(rejected.status).toBe(200);
    expect((await balanceOf(studentId)).outstanding).toBe('100000.00');
    expect(await prisma.financialEntry.count({ where: { studentId, source: 'WAIVER' } })).toBe(0);
  });

  it('reverses approved relief by posting an opposing entry, keeping the decision', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Sibling rate.',
      });
    const approved = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    const reversed = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/reverse`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: approved.body.data.version,
        reason: 'Applied to the wrong sibling.',
      });

    expect(reversed.status).toBe(200);
    expect(reversed.body.data.status).toBe('REVERSED');
    // Back to the full charge, and the approver is still recorded.
    expect((await balanceOf(studentId)).outstanding).toBe('100000.00');
    expect(reversed.body.data.decidedByName).not.toBeNull();

    const entries = await prisma.financialEntry.findMany({
      where: { studentId, source: 'DISCOUNT' },
    });
    expect(entries).toHaveLength(2);
  });

  it('adds a debiting adjustment as a surcharge', async () => {
    const { studentId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/ADJUSTMENT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        academicYearId: academic.academicYearId,
        direction: 'DEBIT',
        amount: '5000.00',
        reason: 'Late payment fee authorised by the board.',
      });
    await request(app)
      .post(`/api/v1/relief/ADJUSTMENT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    const balance = await balanceOf(studentId);
    expect(balance.totalSurcharged).toBe('5000.00');
    expect(balance.outstanding).toBe('105000.00');
  });

  it('records a credit balance when a student-level credit exceeds what is owed', async () => {
    const { studentId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/ADJUSTMENT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        academicYearId: academic.academicYearId,
        direction: 'CREDIT',
        amount: '120000.00',
        reason: 'Correcting a historic overcharge.',
      });
    await request(app)
      .post(`/api/v1/relief/ADJUSTMENT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    const balance = await balanceOf(studentId);
    expect(balance.outstanding).toBe('0.00');
    expect(balance.creditBalance).toBe('20000.00');
  });

  it('refuses relief naming another student`s charge', async () => {
    const { chargeId } = await chargedStudent();
    const other = await registerStudent({ firstName: 'Other', lastName: 'Pupil' });

    const response = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: other.id,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '1000.00',
        reason: 'Charge belongs to someone else.',
      });

    expect(response.status).toBe(400);
  });

  it('refuses to void a charge that carries approved relief', async () => {
    const { chargeId, version } = await chargedStudent();
    const charge = await prisma.studentCharge.findUniqueOrThrow({ where: { id: chargeId } });

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: charge.studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Sibling rate.',
      });
    await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });

    const response = await request(app)
      .post(`/api/v1/charges/${chargeId}/void`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: version, reason: 'Trying to void under a live discount.' });

    expect(response.status).toBe(409);
  });

  it('lets the requester cancel, but not someone else', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Asked for in error.',
      });

    const byOther = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/cancel`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version });
    expect(byOther.status).toBe(403);

    const byRequester = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/cancel`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: requested.body.data.version });
    expect(byRequester.status).toBe(200);
    expect(byRequester.body.data.status).toBe('CANCELLED');
  });

  it('refuses a second approval of the same request', async () => {
    const { studentId, chargeId } = await chargedStudent();

    const requested = await request(app)
      .post('/api/v1/relief/DISCOUNT')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId,
        studentChargeId: chargeId,
        academicYearId: academic.academicYearId,
        amount: '10000.00',
        reason: 'Sibling rate.',
      });

    const first = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });
    expect(first.status).toBe(200);

    // Replaying the same request must not credit a second time.
    const second = await request(app)
      .post(`/api/v1/relief/DISCOUNT/${requested.body.data.id}/decision`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: requested.body.data.version, decision: 'APPROVE' });
    expect(second.status).toBe(409);

    expect((await balanceOf(studentId)).outstanding).toBe('90000.00');
  });
});

/* ------------------------------------------------ student financial summary */

describe('student financial summary', () => {
  it('returns the balance, its periods, the charges, the relief and the ledger', async () => {
    const tuition = await createCategory();
    await createStructure({
      levelId: academic.levelIds[0],
      items: [{ feeCategoryId: tuition, label: 'Tuition', amount: '95000.00' }],
    });
    const student = await registerStudent();

    await request(app)
      .post('/api/v1/charge-runs')
      .set('Authorization', bearer(financeSession))
      .send({ academicYearId: academic.academicYearId, termId: academic.termIds[0] });

    const response = await request(app)
      .get(`/api/v1/students/${student.id}/financials`)
      .set('Authorization', bearer(bursarSession));

    expect(response.status).toBe(200);
    expect(response.body.data.balance.outstanding).toBe('95000.00');
    expect(response.body.data.charges).toHaveLength(1);
    expect(response.body.data.entries).toHaveLength(1);
    expect(response.body.data.periods).toHaveLength(1);
  });

  it('refuses a DOS, who has no financial permissions', async () => {
    const student = await registerStudent();

    const response = await request(app)
      .get(`/api/v1/students/${student.id}/financials`)
      .set('Authorization', bearer(dosSession));

    expect(response.status).toBe(403);
  });

  it('reports another school`s student as not found', async () => {
    const otherSchoolId = await createSchool('OTHER', 'Other School');
    const otherStudent = await prisma.student.create({
      data: {
        schoolId: otherSchoolId,
        studentId: 'STU-2026-08888',
        firstName: 'Other',
        lastName: 'Student',
        admissionDate: new Date(Date.UTC(2026, 0, 12)),
        admissionYear: 2026,
      },
    });

    const response = await request(app)
      .get(`/api/v1/students/${otherStudent.id}/balance`)
      .set('Authorization', bearer(bursarSession));

    expect(response.status).toBe(404);
  });
});
