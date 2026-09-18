/**
 * Database-enforced integrity rules.
 *
 * These assert that the constraints actually reject bad data, rather than trusting that
 * the migration ran. The rules here are the ones where a violation would corrupt
 * financial history or make "the current term" ambiguous, so application-level checks
 * alone are not enough -- a bulk import or a maintenance script bypasses those.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Money } from '@sfs/shared';

import { prisma } from '../../src/lib/prisma.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';

let schoolId = '';
let otherSchoolId = '';
let academicYearId = '';
let programId = '';
let levelId = '';

beforeAll(async () => {
  await assertTestDatabase();
  await resetDatabase();

  const school = await prisma.school.create({
    data: { code: 'TESTSCHOOL', name: 'Test School' },
  });
  schoolId = school.id;

  const other = await prisma.school.create({
    data: { code: 'OTHERSCHOOL', name: 'Other School' },
  });
  otherSchoolId = other.id;

  const year = await prisma.academicYear.create({
    data: {
      schoolId,
      name: '2026',
      startDate: new Date('2026-01-12T00:00:00.000Z'),
      endDate: new Date('2026-11-06T00:00:00.000Z'),
      status: 'ACTIVE',
      isCurrent: true,
    },
  });
  academicYearId = year.id;

  const program = await prisma.program.create({
    data: { schoolId, code: 'OLEVEL', name: "O'Level" },
  });
  programId = program.id;

  const level = await prisma.level.create({
    data: { schoolId, programId, code: 'S1', name: 'Senior 1', sequence: 1 },
  });
  levelId = level.id;
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

async function createStudent(overrides: { studentId: string; schoolId?: string }) {
  return prisma.student.create({
    data: {
      schoolId: overrides.schoolId ?? schoolId,
      studentId: overrides.studentId,
      firstName: 'Test',
      lastName: 'Student',
      admissionDate: new Date('2026-01-15T00:00:00.000Z'),
      admissionYear: 2026,
    },
  });
}

describe('users must belong to a school unless they are system administrators', () => {
  it('rejects a school-less ordinary user', async () => {
    await expect(
      prisma.user.create({
        data: {
          email: 'orphan@test.invalid',
          firstName: 'No',
          lastName: 'School',
          passwordHash: 'x',
          schoolId: null,
          isSystemAdministrator: false,
        },
      }),
    ).rejects.toThrow(/users_school_scope_check/);
  });

  it('allows a school-less system administrator', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'sysadmin@test.invalid',
        firstName: 'System',
        lastName: 'Admin',
        passwordHash: 'x',
        schoolId: null,
        isSystemAdministrator: true,
      },
    });
    expect(user.schoolId).toBeNull();
  });
});

describe('Student ID uniqueness is per school', () => {
  it('rejects a duplicate Student ID within one school', async () => {
    await createStudent({ studentId: 'STU-2026-00001' });
    await expect(createStudent({ studentId: 'STU-2026-00001' })).rejects.toThrow();
  });

  it('allows the same Student ID at a different school', async () => {
    // The point of per-school uniqueness: two schools each numbering from 1 must not
    // collide, or multi-tenancy would force a shared numbering scheme on them.
    const student = await createStudent({
      studentId: 'STU-2026-00001',
      schoolId: otherSchoolId,
    });
    expect(student.studentId).toBe('STU-2026-00001');
  });

  it('rejects a Student ID that does not match the documented format', async () => {
    await expect(createStudent({ studentId: 'STU-2026-125' })).rejects.toThrow(
      /students_student_id_format_check/,
    );
    await expect(createStudent({ studentId: 'nonsense' })).rejects.toThrow(
      /students_student_id_format_check/,
    );
  });
});

describe('exactly one current academic year and term per school', () => {
  it('rejects a second current academic year', async () => {
    await expect(
      prisma.academicYear.create({
        data: {
          schoolId,
          name: '2027',
          startDate: new Date('2027-01-11T00:00:00.000Z'),
          endDate: new Date('2027-11-05T00:00:00.000Z'),
          isCurrent: true,
        },
      }),
    ).rejects.toThrow(/academic_years_one_current_per_school/);
  });

  it('allows another school to have its own current year', async () => {
    const year = await prisma.academicYear.create({
      data: {
        schoolId: otherSchoolId,
        name: '2026',
        startDate: new Date('2026-01-12T00:00:00.000Z'),
        endDate: new Date('2026-11-06T00:00:00.000Z'),
        isCurrent: true,
      },
    });
    expect(year.isCurrent).toBe(true);
  });

  it('rejects a year that ends before it starts', async () => {
    await expect(
      prisma.academicYear.create({
        data: {
          schoolId,
          name: '2028',
          startDate: new Date('2028-11-05T00:00:00.000Z'),
          endDate: new Date('2028-01-11T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/academic_years_date_order_check/);
  });

  it('rejects a second current term', async () => {
    await prisma.term.create({
      data: {
        schoolId,
        academicYearId,
        name: 'Term 1',
        sequence: 1,
        startDate: new Date('2026-01-12T00:00:00.000Z'),
        endDate: new Date('2026-04-03T00:00:00.000Z'),
        isCurrent: true,
      },
    });

    await expect(
      prisma.term.create({
        data: {
          schoolId,
          academicYearId,
          name: 'Term 2',
          sequence: 2,
          startDate: new Date('2026-04-20T00:00:00.000Z'),
          endDate: new Date('2026-07-10T00:00:00.000Z'),
          isCurrent: true,
        },
      }),
    ).rejects.toThrow(/terms_one_current_per_school/);
  });
});

describe('level chaining cannot form a trivial loop', () => {
  it('rejects a level pointing at itself', async () => {
    await expect(
      prisma.level.update({ where: { id: levelId }, data: { nextLevelId: levelId } }),
    ).rejects.toThrow(/levels_next_level_not_self_check/);
  });

  it('rejects a terminal level that also chains onward', async () => {
    const next = await prisma.level.create({
      data: { schoolId, programId, code: 'S2', name: 'Senior 2', sequence: 2 },
    });

    await expect(
      prisma.level.update({
        where: { id: levelId },
        data: { isTerminal: true, nextLevelId: next.id },
      }),
    ).rejects.toThrow(/levels_terminal_has_no_next_check/);
  });
});

describe('enrolment history is protected', () => {
  let studentId = '';

  beforeAll(async () => {
    const student = await createStudent({ studentId: 'STU-2026-00500' });
    studentId = student.id;
  });

  async function createEnrollment(overrides: {
    status?: 'ENROLLED' | 'WITHDRAWN' | 'PROMOTED';
    endDate?: Date | null;
  }) {
    return prisma.enrollment.create({
      data: {
        schoolId,
        studentId,
        academicYearId,
        programId,
        levelId,
        status: overrides.status ?? 'ENROLLED',
        startDate: new Date('2026-01-12T00:00:00.000Z'),
        endDate: overrides.endDate ?? null,
      },
    });
  }

  it('allows one active enrolment per student per year', async () => {
    const enrollment = await createEnrollment({});
    expect(enrollment.status).toBe('ENROLLED');
  });

  it('rejects a second active enrolment in the same year', async () => {
    await expect(createEnrollment({})).rejects.toThrow(/enrollments_one_active_per_student_year/);
  });

  it('permits withdrawal then re-admission within the same year', async () => {
    // A student who withdraws in Term 1 and returns in Term 3 legitimately has two rows
    // for that year, which is why the constraint is restricted to ENROLLED rows.
    const active = await prisma.enrollment.findFirstOrThrow({
      where: { studentId, academicYearId, status: 'ENROLLED' },
    });
    await prisma.enrollment.update({
      where: { id: active.id },
      data: { status: 'WITHDRAWN', endDate: new Date('2026-03-01T00:00:00.000Z') },
    });

    const readmission = await createEnrollment({});
    expect(readmission.status).toBe('ENROLLED');

    const history = await prisma.enrollment.count({ where: { studentId, academicYearId } });
    expect(history).toBe(2);
  });

  it('requires an end date once an enrolment is no longer active', async () => {
    const active = await prisma.enrollment.findFirstOrThrow({
      where: { studentId, academicYearId, status: 'ENROLLED' },
    });

    await expect(
      prisma.enrollment.update({
        where: { id: active.id },
        data: { status: 'PROMOTED' },
      }),
    ).rejects.toThrow(/enrollments_end_date_matches_status_check/);
  });

  it('rejects an active enrolment that carries an end date', async () => {
    const student = await createStudent({ studentId: 'STU-2026-00501' });
    await expect(
      prisma.enrollment.create({
        data: {
          schoolId,
          studentId: student.id,
          academicYearId,
          programId,
          levelId,
          status: 'ENROLLED',
          startDate: new Date('2026-01-12T00:00:00.000Z'),
          endDate: new Date('2026-06-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/enrollments_end_date_matches_status_check/);
  });
});

describe('school settings guard against unusable policy', () => {
  it('rejects a negative minimum payment', async () => {
    await expect(
      prisma.schoolSetting.create({
        data: { schoolId: otherSchoolId, minimumPaymentAmount: '-1.00' },
      }),
    ).rejects.toThrow(/school_settings_minimum_payment_non_negative_check/);
  });

  it('rejects a zero retention period, which would mean delete immediately', async () => {
    await expect(
      prisma.schoolSetting.create({
        data: { schoolId: otherSchoolId, financialRecordRetentionYears: 0 },
      }),
    ).rejects.toThrow(/school_settings_retention_positive_check/);
  });
});

describe('monetary columns keep exact decimal values', () => {
  it('stores and returns a minimum payment without floating-point drift', async () => {
    const setting = await prisma.schoolSetting.create({
      data: { schoolId: otherSchoolId, minimumPaymentAmount: '1234.56' },
    });
    expect(Money.fromDatabase(setting.minimumPaymentAmount).toString()).toBe('1234.56');

    const reloaded = await prisma.schoolSetting.findUniqueOrThrow({
      where: { schoolId: otherSchoolId },
    });
    expect(Money.fromDatabase(reloaded.minimumPaymentAmount).toString()).toBe('1234.56');
  });

  it('must be read back through Money, because a raw Decimal drops trailing zeros', async () => {
    // A trap worth pinning down. The column is NUMERIC(14,2) and holds 1000.00, but
    // Prisma's Decimal normalises on `toString()` and yields "1000". Serialising that
    // straight into a response would show a parent "RWF 1000" where every other amount
    // reads "1000.00", and would make string comparison of amounts unreliable.
    //
    // `Money.fromDatabase` restores the fixed scale, which is why every monetary value
    // crosses the API boundary through it.
    await prisma.schoolSetting.update({
      where: { schoolId: otherSchoolId },
      data: { minimumPaymentAmount: '1000.00' },
    });
    const row = await prisma.schoolSetting.findUniqueOrThrow({
      where: { schoolId: otherSchoolId },
    });

    expect(row.minimumPaymentAmount.toString()).toBe('1000');
    expect(Money.fromDatabase(row.minimumPaymentAmount).toString()).toBe('1000.00');
    expect(Money.fromDatabase(row.minimumPaymentAmount).format()).toBe('RWF 1,000');
  });
});
