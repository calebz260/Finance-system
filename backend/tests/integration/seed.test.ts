/**
 * The seed is tested because developers and later phases depend on it being a usable,
 * repeatable dataset (Section 37). The properties that matter:
 *
 *  - running it twice changes nothing;
 *  - the current population excludes former students;
 *  - the role/permission matrix reaches the database intact;
 *  - the identifier counters are left in a state where the next real registration works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Money, PERMISSIONS, PermissionKey, ROLE_DEFINITIONS, RoleKey } from '@sfs/shared';

import { seedDatabase, type SeedSummary } from '../../prisma/seed/index.js';
import { AccessScope } from '../../src/lib/access-scope.js';
import { prisma } from '../../src/lib/prisma.js';
import { verifyPassword } from '../../src/lib/password.js';
import { StudentRepository } from '../../src/modules/students/student.repository.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';

let summary: SeedSummary;

beforeAll(async () => {
  await assertTestDatabase();
  await resetDatabase();
  summary = await seedDatabase();
}, 60_000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('seed shape', () => {
  it('creates one school with settings', async () => {
    expect(await prisma.school.count()).toBe(1);
    const settings = await prisma.schoolSetting.findUniqueOrThrow({
      where: { schoolId: summary.schoolId },
    });
    expect(settings.currency).toBe('RWF');
    expect(settings.timeZone).toBe('Africa/Kigali');
    // Read back through Money, never via the raw Decimal -- see the dedicated test below.
    expect(Money.fromDatabase(settings.minimumPaymentAmount).toString()).toBe('1000.00');
    // Policy defaults documented in docs/OPEN-QUESTIONS.md.
    expect(settings.midPeriodChargePolicy).toBe('FULL_TERM_CHARGE');
    expect(settings.enforceVerificationSeparationOfDuties).toBe(true);
  });

  it('creates two academic years with exactly one current, and three terms each', async () => {
    const years = await prisma.academicYear.findMany({ orderBy: { name: 'asc' } });
    expect(years).toHaveLength(2);
    expect(years.filter((year) => year.isCurrent)).toHaveLength(1);

    for (const year of years) {
      const terms = await prisma.term.count({ where: { academicYearId: year.id } });
      expect(terms).toBe(3);
    }

    // Exactly one current term, so "this term" is never ambiguous.
    expect(await prisma.term.count({ where: { isCurrent: true } })).toBe(1);
  });

  it('chains levels so promotion is a data lookup, not a rule in code', async () => {
    const s1 = await prisma.level.findFirstOrThrow({
      where: { code: 'S1' },
      include: { nextLevel: true },
    });
    expect(s1.nextLevel?.code).toBe('S2');

    // S3 ends O'Level: moving to A'Level is a fresh enrolment in another programme, not
    // an automatic promotion, so the chain must stop here.
    const s3 = await prisma.level.findFirstOrThrow({ where: { code: 'S3' } });
    expect(s3.isTerminal).toBe(true);
    expect(s3.nextLevelId).toBeNull();
  });

  it('creates class sections per academic year, not shared across years', async () => {
    const years = await prisma.academicYear.findMany();
    for (const year of years) {
      const sections = await prisma.classSection.count({ where: { academicYearId: year.id } });
      expect(sections).toBeGreaterThan(0);
    }
  });
});

describe('access control reaches the database intact', () => {
  it('seeds every permission and role from the shared catalogue', async () => {
    expect(await prisma.permission.count()).toBe(PERMISSIONS.length);
    expect(await prisma.role.count()).toBe(ROLE_DEFINITIONS.length);
  });

  it('grants each role exactly the permissions the catalogue declares', async () => {
    for (const definition of ROLE_DEFINITIONS) {
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: definition.key },
        include: { permissions: { include: { permission: true } } },
      });
      const granted = new Set(role.permissions.map((row) => row.permission.key));
      expect(granted, `role ${definition.key}`).toEqual(new Set(definition.permissions));
    }
  });

  it('marks the financially sensitive roles as requiring MFA', async () => {
    const roles = await prisma.role.findMany({ where: { requiresMfa: true } });
    expect(new Set(roles.map((role) => role.key))).toEqual(
      new Set([RoleKey.SUPER_ADMIN, RoleKey.SCHOOL_ADMIN, RoleKey.FINANCE_MANAGER, RoleKey.BURSAR]),
    );
  });

  it('does not grant a bursar the approval permissions', async () => {
    const bursar = await prisma.role.findUniqueOrThrow({
      where: { key: RoleKey.BURSAR },
      include: { permissions: { include: { permission: true } } },
    });
    const granted = new Set(bursar.permissions.map((row) => row.permission.key));

    expect(granted.has(PermissionKey.PAYMENT_VERIFY_MANUAL)).toBe(true);
    expect(granted.has(PermissionKey.ADJUSTMENT_APPROVE)).toBe(false);
    expect(granted.has(PermissionKey.PAYMENT_REVERSE)).toBe(false);
  });
});

describe('seeded accounts', () => {
  it('creates one usable account per role', async () => {
    const users = await prisma.user.findMany({ include: { roleAssignments: true } });
    expect(users.length).toBeGreaterThanOrEqual(ROLE_DEFINITIONS.length);

    for (const user of users) {
      expect(user.status).toBe('ACTIVE');
      // A development credential must never survive into anything real.
      expect(user.mustChangePassword).toBe(true);
      expect(user.roleAssignments.length).toBeGreaterThan(0);
    }
  });

  it('stores an Argon2id hash, never the password', async () => {
    const bursar = await prisma.user.findUniqueOrThrow({
      where: { email: 'bursar@gskicukiro.invalid' },
    });

    expect(bursar.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword('SfsDev!Password2026', bursar.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', bursar.passwordHash)).resolves.toBe(false);
  });

  it('scopes the super administrator to no school, and everyone else to the school', async () => {
    const superAdmin = await prisma.user.findUniqueOrThrow({
      where: { email: 'superadmin@sfs.invalid' },
    });
    expect(superAdmin.isSystemAdministrator).toBe(true);
    expect(superAdmin.schoolId).toBeNull();

    const others = await prisma.user.findMany({ where: { isSystemAdministrator: false } });
    expect(others.length).toBeGreaterThan(0);
    for (const user of others) {
      expect(user.schoolId).toBe(summary.schoolId);
    }
  });

  it('creates a second bursar, so separation of duties is testable', async () => {
    const bursars = await prisma.userRole.count({
      where: { role: { key: RoleKey.BURSAR } },
    });
    expect(bursars).toBeGreaterThanOrEqual(2);
  });
});

describe('students, guardians and enrolment history', () => {
  it('counts the current population without counting former students', async () => {
    // Section 11: a historical student must never inflate the current enrolment figure.
    const totalStudents = await prisma.student.count();
    const currentEnrollments = await prisma.enrollment.count({
      where: { academicYearId: summary.currentAcademicYearId, status: 'ENROLLED' },
    });
    const formerStudents = await prisma.student.count({
      where: { status: { in: ['WITHDRAWN', 'TRANSFERRED'] } },
    });

    expect(formerStudents).toBeGreaterThan(0);
    expect(currentEnrollments).toBe(totalStudents - formerStudents);
  });

  it('keeps former students searchable, with their history intact', async () => {
    const former = await prisma.student.findFirstOrThrow({
      where: { status: { in: ['WITHDRAWN', 'TRANSFERRED'] } },
      include: { enrollments: true },
    });

    // No current enrolment, but the prior year is still there for clearance checks.
    expect(former.enrollments.length).toBeGreaterThan(0);
    expect(
      former.enrollments.some(
        (enrollment) => enrollment.academicYearId === summary.currentAcademicYearId,
      ),
    ).toBe(false);
  });

  it('records a closed enrolment with an end date and an exit reason where relevant', async () => {
    const withdrawn = await prisma.enrollment.findFirstOrThrow({ where: { status: 'WITHDRAWN' } });
    expect(withdrawn.endDate).not.toBeNull();
    expect(withdrawn.exitReason).toBeTruthy();
  });

  it('exercises the lifecycle: promotion, repetition, completion and re-admission', async () => {
    const types = await prisma.enrollment.groupBy({
      by: ['enrollmentType'],
      _count: { _all: true },
    });
    const byType = new Map(types.map((row) => [row.enrollmentType, row._count._all]));

    expect(byType.get('NEW') ?? 0).toBeGreaterThan(0);
    expect(byType.get('CONTINUING') ?? 0).toBeGreaterThan(0);
    expect(byType.get('REPEAT') ?? 0).toBeGreaterThan(0);
    expect(byType.get('RE_ADMISSION') ?? 0).toBeGreaterThan(0);
  });

  it('preserves prior-year enrolment alongside the current one', async () => {
    const continuing = await prisma.student.findFirstOrThrow({
      where: { enrollments: { some: { enrollmentType: 'CONTINUING' } } },
      include: { enrollments: { orderBy: { startDate: 'asc' } } },
    });

    expect(continuing.enrollments.length).toBeGreaterThanOrEqual(2);
    // History is appended, never overwritten (Section 8).
    const years = new Set(continuing.enrollments.map((e) => e.academicYearId));
    expect(years.size).toBeGreaterThanOrEqual(2);
  });

  it('links one guardian to more than one student, as a real parent portal must', async () => {
    const guardians = await prisma.guardian.findMany({ include: { students: true } });
    expect(guardians.some((guardian) => guardian.students.length >= 2)).toBe(true);
  });

  it('gives each student a financially responsible primary contact', async () => {
    const students = await prisma.student.findMany({ include: { guardians: true } });
    for (const student of students) {
      expect(student.guardians.length).toBeGreaterThan(0);
      expect(student.guardians.some((link) => link.isPrimaryContact)).toBe(true);
      expect(student.guardians.some((link) => link.isFinanciallyResponsible)).toBe(true);
    }
  });

  it('links the parent portal account to a guardian record', async () => {
    const guardian = await prisma.guardian.findFirstOrThrow({
      where: { user: { email: 'parent@gskicukiro.invalid' } },
      include: { students: true },
    });
    expect(guardian.students.length).toBeGreaterThanOrEqual(2);
  });

  it('issues Student IDs in the documented format', async () => {
    const students = await prisma.student.findMany({ select: { studentId: true } });
    for (const student of students) {
      expect(student.studentId).toMatch(/^STU-\d{4}-\d{5}$/);
    }
  });
});

describe('identifier counters are left usable', () => {
  it('lets the next real registration continue the sequence without colliding', async () => {
    // Seeded Student IDs are computed rather than allocated, so if the counters were not
    // advanced past them the first real registration would hit the unique constraint.
    const scope = AccessScope.forSchool(summary.schoolId);
    const repository = new StudentRepository();

    const highestSeeded = await prisma.student.findFirstOrThrow({
      where: { admissionYear: 2026 },
      orderBy: { studentId: 'desc' },
      select: { studentId: true },
    });

    const created = await repository.create(scope, {
      firstName: 'Newly',
      lastName: 'Registered',
      admissionDate: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(created.studentId > highestSeeded.studentId).toBe(true);
  });
});

describe('idempotency', () => {
  it('changes nothing when run a second time', async () => {
    // A seed that duplicates on a second run is a seed nobody re-runs.
    const before = await countEverything();
    await seedDatabase();
    const after = await countEverything();

    expect(after).toEqual(before);
  }, 60_000);
});

async function countEverything(): Promise<Record<string, number>> {
  const [
    schools,
    users,
    roles,
    permissions,
    rolePermissions,
    userRoles,
    departments,
    programs,
    levels,
    academicYears,
    terms,
    classSections,
    students,
    guardians,
    studentGuardians,
    enrollments,
  ] = await Promise.all([
    prisma.school.count(),
    prisma.user.count(),
    prisma.role.count(),
    prisma.permission.count(),
    prisma.rolePermission.count(),
    prisma.userRole.count(),
    prisma.department.count(),
    prisma.program.count(),
    prisma.level.count(),
    prisma.academicYear.count(),
    prisma.term.count(),
    prisma.classSection.count(),
    prisma.student.count(),
    prisma.guardian.count(),
    prisma.studentGuardian.count(),
    prisma.enrollment.count(),
  ]);

  return {
    schools,
    users,
    roles,
    permissions,
    rolePermissions,
    userRoles,
    departments,
    programs,
    levels,
    academicYears,
    terms,
    classSections,
    students,
    guardians,
    studentGuardians,
    enrollments,
  };
}
