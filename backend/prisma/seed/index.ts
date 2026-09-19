/**
 * Development seed (Section 37).
 *
 * Properties that make this useful rather than decorative:
 *
 *  - **Idempotent.** Everything is upserted on a natural key, so running it twice
 *    changes nothing. A seed that duplicates on a second run is a seed nobody re-runs.
 *  - **Deterministic.** Student IDs are computed rather than allocated, so the same
 *    student always has the same identifier across machines — which makes screenshots,
 *    bug reports and test fixtures comparable. The identifier counters are then advanced
 *    past the seeded values, so a later real registration continues the sequence
 *    correctly instead of colliding.
 *  - **Realistic.** Two academic years with three terms each, a promotion, a repeat, a
 *    completion followed by re-enrolment, a withdrawal and a transfer out. The lifecycle
 *    in Section 8 can be exercised without inventing data by hand.
 *  - **Fictional.** No real personal information, ever.
 *
 * It refuses to run against a production database.
 */
import { PERMISSIONS, ROLE_DEFINITIONS, formatStudentId, getRoleDefinition } from '@sfs/shared';

import {
  EnrollmentStatus,
  EnrollmentType,
  SequenceKind,
  StudentStatus,
} from '../../src/generated/prisma/enums.js';
import { config } from '../../src/config/env.js';
import { logger } from '../../src/lib/logger.js';
import { hashPassword } from '../../src/lib/password.js';
import { prisma } from '../../src/lib/prisma.js';
import {
  ACADEMIC_YEARS,
  CLASS_SECTION_CAPACITY,
  CLASS_SECTION_CODES,
  DEFAULT_SEED_PASSWORD,
  DEPARTMENTS,
  FORMER_STUDENTS,
  GUARDIANS,
  PROGRAMS,
  SCHOOL,
  STUDENTS,
  USERS,
  type StudentFixture,
} from './fixtures.js';

const log = logger.child({ module: 'seed' });

/** A date-only value. Stored in a `date` column, so the time component is irrelevant. */
function isoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export interface SeedSummary {
  readonly schoolId: string;
  readonly currentAcademicYearId: string;
  readonly currentTermId: string;
  readonly counts: Readonly<Record<string, number>>;
}

export async function seedDatabase(): Promise<SeedSummary> {
  if (config.isProduction) {
    throw new Error(
      'Refusing to seed: NODE_ENV is "production". Seed data is for development and test only.',
    );
  }

  const seedPassword = process.env.SEED_PASSWORD ?? DEFAULT_SEED_PASSWORD;
  // Hashed once and reused: Argon2id is deliberately slow, and hashing it per account
  // would make the seed take tens of seconds for no benefit in a dev dataset.
  const passwordHash = await hashPassword(seedPassword);

  /* ------------------------------------------------ access control (global catalogue) */

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
        isSensitive: permission.isSensitive,
      },
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
        isSensitive: permission.isSensitive,
      },
    });
  }

  const permissionIdByKey = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((row) => [
      row.key,
      row.id,
    ]),
  );

  const roleIdByKey = new Map<string, string>();
  for (const role of ROLE_DEFINITIONS) {
    const record = await prisma.role.upsert({
      where: { key: role.key },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        rank: role.rank,
        isSystem: true,
        requiresMfa: role.requiresMfa,
      },
      update: {
        name: role.name,
        description: role.description,
        rank: role.rank,
        requiresMfa: role.requiresMfa,
      },
    });
    roleIdByKey.set(role.key, record.id);

    // Replace the grant set wholesale, so a permission removed from the catalogue is
    // actually revoked rather than lingering in the database.
    const permissionIds = role.permissions
      .map((key) => permissionIdByKey.get(key))
      .filter((id): id is string => id !== undefined);

    await prisma.rolePermission.deleteMany({
      where: { roleId: record.id, permissionId: { notIn: permissionIds } },
    });
    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId: record.id, permissionId })),
      skipDuplicates: true,
    });
  }

  /* ------------------------------------------------------------------------- school */

  const school = await prisma.school.upsert({
    where: { code: SCHOOL.code },
    create: { ...SCHOOL },
    update: { ...SCHOOL },
  });

  await prisma.schoolSetting.upsert({
    where: { schoolId: school.id },
    create: {
      schoolId: school.id,
      // A minimum keeps the payments table free of RWF 100 transfers that cost more to
      // reconcile than they collect. Pending confirmation with the school.
      minimumPaymentAmount: '1000.00',
    },
    update: {},
  });

  /* -------------------------------------------------------------------------- users */

  const userIdByEmail = new Map<string, string>();
  for (const fixture of USERS) {
    const isSystem = fixture.isSystemAdministrator === true;
    const user = await prisma.user.upsert({
      where: { email: fixture.email },
      create: {
        email: fixture.email,
        firstName: fixture.firstName,
        lastName: fixture.lastName,
        phone: fixture.phone,
        passwordHash,
        // Every seeded account must be changed on first use, so a development credential
        // can never survive into anything real.
        mustChangePassword: true,
        status: 'ACTIVE',
        isSystemAdministrator: isSystem,
        schoolId: isSystem ? null : school.id,
      },
      update: {
        firstName: fixture.firstName,
        lastName: fixture.lastName,
        phone: fixture.phone,
        status: 'ACTIVE',
        isSystemAdministrator: isSystem,
        schoolId: isSystem ? null : school.id,
      },
    });
    userIdByEmail.set(fixture.email, user.id);

    const roleId = roleIdByKey.get(fixture.roleKey);
    if (roleId === undefined) throw new Error(`Role ${fixture.roleKey} was not seeded`);

    const assignmentSchoolId = isSystem ? null : school.id;
    const existing = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId, schoolId: assignmentSchoolId },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.userRole.create({
        data: { userId: user.id, roleId, schoolId: assignmentSchoolId },
      });
    }
  }

  /* -------------------------------------------------------------------- departments */

  const departmentIdByCode = new Map<string, string>();
  for (const fixture of DEPARTMENTS) {
    const record = await prisma.department.upsert({
      where: { schoolId_code: { schoolId: school.id, code: fixture.code } },
      create: { schoolId: school.id, ...fixture },
      update: { name: fixture.name, description: fixture.description },
    });
    departmentIdByCode.set(fixture.code, record.id);
  }

  /* --------------------------------------------------------- programmes and levels */

  const programIdByCode = new Map<string, string>();
  const levelIdByCode = new Map<string, string>();

  for (const [index, fixture] of PROGRAMS.entries()) {
    const program = await prisma.program.upsert({
      where: { schoolId_code: { schoolId: school.id, code: fixture.code } },
      create: {
        schoolId: school.id,
        code: fixture.code,
        name: fixture.name,
        durationYears: fixture.durationYears,
        sortOrder: index,
        departmentId:
          fixture.departmentCode === null
            ? null
            : (departmentIdByCode.get(fixture.departmentCode) ?? null),
      },
      update: {
        name: fixture.name,
        durationYears: fixture.durationYears,
        sortOrder: index,
      },
    });
    programIdByCode.set(fixture.code, program.id);

    // Levels are created before being chained, because `nextLevelId` needs the next
    // level's id to already exist.
    for (const level of fixture.levels) {
      const record = await prisma.level.upsert({
        where: {
          schoolId_programId_code: {
            schoolId: school.id,
            programId: program.id,
            code: level.code,
          },
        },
        create: {
          schoolId: school.id,
          programId: program.id,
          code: level.code,
          name: level.name,
          sequence: level.sequence,
          isTerminal: level.isTerminal,
        },
        update: { name: level.name, sequence: level.sequence, isTerminal: level.isTerminal },
      });
      levelIdByCode.set(level.code, record.id);
    }

    for (const level of fixture.levels) {
      if (level.isTerminal) continue;
      const next = fixture.levels.find((candidate) => candidate.sequence === level.sequence + 1);
      if (next === undefined) continue;
      await prisma.level.update({
        where: { id: levelIdByCode.get(level.code) },
        data: { nextLevelId: levelIdByCode.get(next.code) },
      });
    }
  }

  /* ------------------------------------------- academic years, terms, class sections */

  const academicYearIdByName = new Map<string, string>();
  const termIdByYearAndSequence = new Map<string, string>();
  const classSectionIdByKey = new Map<string, string>();

  let currentAcademicYearId = '';
  let currentTermId = '';

  for (const yearFixture of ACADEMIC_YEARS) {
    const year = await prisma.academicYear.upsert({
      where: { schoolId_name: { schoolId: school.id, name: yearFixture.name } },
      create: {
        schoolId: school.id,
        name: yearFixture.name,
        startDate: isoDate(yearFixture.startDate),
        endDate: isoDate(yearFixture.endDate),
        status: yearFixture.isCurrent ? 'ACTIVE' : 'CLOSED',
        isCurrent: yearFixture.isCurrent,
      },
      update: {
        startDate: isoDate(yearFixture.startDate),
        endDate: isoDate(yearFixture.endDate),
        status: yearFixture.isCurrent ? 'ACTIVE' : 'CLOSED',
        isCurrent: yearFixture.isCurrent,
      },
    });
    academicYearIdByName.set(yearFixture.name, year.id);
    if (yearFixture.isCurrent) currentAcademicYearId = year.id;

    for (const termFixture of yearFixture.terms) {
      const isCurrentTerm =
        yearFixture.isCurrent && yearFixture.currentTermSequence === termFixture.sequence;
      const status = yearFixture.isCurrent
        ? isCurrentTerm
          ? 'ACTIVE'
          : termFixture.sequence < (yearFixture.currentTermSequence ?? 0)
            ? 'CLOSED'
            : 'UPCOMING'
        : 'CLOSED';

      const term = await prisma.term.upsert({
        where: {
          schoolId_academicYearId_sequence: {
            schoolId: school.id,
            academicYearId: year.id,
            sequence: termFixture.sequence,
          },
        },
        create: {
          schoolId: school.id,
          academicYearId: year.id,
          name: termFixture.name,
          sequence: termFixture.sequence,
          startDate: isoDate(termFixture.startDate),
          endDate: isoDate(termFixture.endDate),
          status,
          isCurrent: isCurrentTerm,
        },
        update: {
          name: termFixture.name,
          startDate: isoDate(termFixture.startDate),
          endDate: isoDate(termFixture.endDate),
          status,
          isCurrent: isCurrentTerm,
        },
      });
      termIdByYearAndSequence.set(`${yearFixture.name}:${String(termFixture.sequence)}`, term.id);
      if (isCurrentTerm) currentTermId = term.id;
    }

    // One set of class sections per year, because sections and capacities are set afresh
    // each year (and current-class counts must be answerable for one year alone).
    for (const program of PROGRAMS) {
      for (const level of program.levels) {
        for (const code of CLASS_SECTION_CODES[level.code] ?? []) {
          const levelId = levelIdByCode.get(level.code);
          if (levelId === undefined) continue;

          const section = await prisma.classSection.upsert({
            where: {
              schoolId_academicYearId_levelId_code: {
                schoolId: school.id,
                academicYearId: year.id,
                levelId,
                code,
              },
            },
            create: {
              schoolId: school.id,
              academicYearId: year.id,
              levelId,
              code,
              name: `${level.code} ${code}`,
              capacity: CLASS_SECTION_CAPACITY,
            },
            update: { name: `${level.code} ${code}`, capacity: CLASS_SECTION_CAPACITY },
          });
          classSectionIdByKey.set(`${yearFixture.name}:${level.code}:${code}`, section.id);
        }
      }
    }
  }

  if (currentAcademicYearId === '' || currentTermId === '') {
    throw new Error('Seed fixtures must define exactly one current academic year and term');
  }

  /* ---------------------------------------------------------------------- guardians */

  const guardianIds: string[] = [];
  for (const fixture of GUARDIANS) {
    const linkedUserId =
      fixture.userEmail === undefined ? null : (userIdByEmail.get(fixture.userEmail) ?? null);

    // No natural unique key on guardians (people share phone numbers), so the seed looks
    // one up by its fixture identity before creating it.
    const existing = await prisma.guardian.findFirst({
      where: {
        schoolId: school.id,
        firstName: fixture.firstName,
        lastName: fixture.lastName,
        phone: fixture.phone,
      },
      select: { id: true },
    });

    const data = {
      schoolId: school.id,
      firstName: fixture.firstName,
      lastName: fixture.lastName,
      phone: fixture.phone,
      email: fixture.email,
      occupation: fixture.occupation,
      district: SCHOOL.district,
      userId: linkedUserId,
    };

    const guardian =
      existing === null
        ? await prisma.guardian.create({ data })
        : await prisma.guardian.update({ where: { id: existing.id }, data });

    guardianIds.push(guardian.id);
  }

  /* ----------------------------------------------------- students and enrolments */

  const currentYearName = ACADEMIC_YEARS.find((year) => year.isCurrent)?.name ?? '';
  const priorYearName = ACADEMIC_YEARS.find((year) => !year.isCurrent)?.name ?? '';
  const priorYearId = academicYearIdByName.get(priorYearName);

  /** Per-admission-year counter, so Student IDs are stable and gapless. */
  const sequenceByYear = new Map<number, number>();
  const nextStudentId = (admissionYear: number): string => {
    const next = (sequenceByYear.get(admissionYear) ?? 0) + 1;
    sequenceByYear.set(admissionYear, next);
    return formatStudentId(admissionYear, next);
  };

  const seedStudent = async (
    fixture: StudentFixture,
    options: { isFormer: boolean },
  ): Promise<void> => {
    const studentId = nextStudentId(fixture.admissionYear);

    const student = await prisma.student.upsert({
      where: { schoolId_studentId: { schoolId: school.id, studentId } },
      create: {
        schoolId: school.id,
        studentId,
        firstName: fixture.firstName,
        lastName: fixture.lastName,
        gender: fixture.gender,
        dateOfBirth: isoDate(`${String(fixture.birthYear)}-06-15`),
        admissionDate: isoDate(`${String(fixture.admissionYear)}-01-15`),
        admissionYear: fixture.admissionYear,
        district: SCHOOL.district,
        status: options.isFormer
          ? fixture.priorYear?.outcome === 'TRANSFERRED_OUT'
            ? StudentStatus.TRANSFERRED
            : StudentStatus.WITHDRAWN
          : StudentStatus.ACTIVE,
      },
      update: {
        firstName: fixture.firstName,
        lastName: fixture.lastName,
        gender: fixture.gender,
      },
    });

    // --- guardian links
    for (const [position, guardianIndex] of fixture.guardianIndexes.entries()) {
      const guardianId = guardianIds[guardianIndex];
      if (guardianId === undefined) continue;
      const relationship = GUARDIANS[guardianIndex]?.relationship ?? 'GUARDIAN';

      await prisma.studentGuardian.upsert({
        where: { studentId_guardianId: { studentId: student.id, guardianId } },
        create: {
          schoolId: school.id,
          studentId: student.id,
          guardianId,
          relationship,
          isPrimaryContact: position === 0,
          isFinanciallyResponsible: position === 0,
        },
        update: {},
      });
    }

    // --- prior-year enrolment, closed with the outcome that actually happened
    if (fixture.priorYear !== null && priorYearId !== undefined) {
      const priorLevelId = levelIdByCode.get(fixture.priorYear.levelCode);
      const priorProgramId = programIdByCode.get(fixture.priorYear.programCode);
      const priorSectionId = classSectionIdByKey.get(
        `${priorYearName}:${fixture.priorYear.levelCode}:A`,
      );

      if (priorLevelId !== undefined && priorProgramId !== undefined) {
        const existing = await prisma.enrollment.findFirst({
          where: { studentId: student.id, academicYearId: priorYearId },
          select: { id: true },
        });

        const priorYearFixture = ACADEMIC_YEARS.find((year) => year.name === priorYearName);
        const data = {
          schoolId: school.id,
          studentId: student.id,
          academicYearId: priorYearId,
          programId: priorProgramId,
          levelId: priorLevelId,
          classSectionId: priorSectionId ?? null,
          status: fixture.priorYear.outcome as EnrollmentStatus,
          enrollmentType: EnrollmentType.CONTINUING,
          residency: fixture.residency,
          startDate: isoDate(priorYearFixture?.startDate ?? '2025-01-13'),
          // A closed enrolment must carry an end date: a check constraint enforces it,
          // because "ended" without a date makes any date-range report wrong.
          endDate: isoDate(
            fixture.priorYear.outcome === 'WITHDRAWN' ||
              fixture.priorYear.outcome === 'TRANSFERRED_OUT'
              ? '2025-05-30'
              : (priorYearFixture?.endDate ?? '2025-11-07'),
          ),
          ...(fixture.priorYear.outcome === 'WITHDRAWN'
            ? { exitReason: 'Family relocated (seed data)' }
            : {}),
          ...(fixture.priorYear.outcome === 'TRANSFERRED_OUT'
            ? { exitReason: 'Transferred to another school (seed data)' }
            : {}),
        };

        if (existing === null) {
          await prisma.enrollment.create({ data });
        } else {
          await prisma.enrollment.update({ where: { id: existing.id }, data });
        }
      }
    }

    // --- current-year enrolment. Former students deliberately have none, so they are
    //     excluded from the current population (Section 11).
    if (options.isFormer) return;

    const levelId = levelIdByCode.get(fixture.levelCode);
    const programId = programIdByCode.get(fixture.programCode);
    const sectionId = classSectionIdByKey.get(
      `${currentYearName}:${fixture.levelCode}:${fixture.classSectionCode}`,
    );
    if (levelId === undefined || programId === undefined) return;

    const enrollmentType: EnrollmentType =
      fixture.priorYear === null
        ? EnrollmentType.NEW
        : fixture.priorYear.outcome === 'REPEATED'
          ? EnrollmentType.REPEAT
          : fixture.priorYear.outcome === 'COMPLETED'
            ? EnrollmentType.RE_ADMISSION
            : EnrollmentType.CONTINUING;

    const existingCurrent = await prisma.enrollment.findFirst({
      where: { studentId: student.id, academicYearId: currentAcademicYearId },
      select: { id: true },
    });

    const currentData = {
      schoolId: school.id,
      studentId: student.id,
      academicYearId: currentAcademicYearId,
      programId,
      levelId,
      classSectionId: sectionId ?? null,
      status: EnrollmentStatus.ENROLLED,
      enrollmentType,
      residency: fixture.residency,
      startDate: isoDate(ACADEMIC_YEARS.find((y) => y.isCurrent)?.startDate ?? '2026-01-12'),
      endDate: null,
    };

    if (existingCurrent === null) {
      await prisma.enrollment.create({ data: currentData });
    } else {
      await prisma.enrollment.update({ where: { id: existingCurrent.id }, data: currentData });
    }
  };

  for (const fixture of STUDENTS) {
    await seedStudent(fixture, { isFormer: false });
  }
  for (const fixture of FORMER_STUDENTS) {
    await seedStudent(fixture, { isFormer: true });
  }

  /* ------------------------------------------------------- advance the ID counters */

  // Seeded Student IDs were computed, not allocated, so the counters must be moved past
  // them. Without this, the first real registration would try to reuse a seeded
  // identifier and hit the unique constraint.
  for (const [year, lastValue] of sequenceByYear) {
    await prisma.identifierSequence.upsert({
      where: { schoolId_kind_year: { schoolId: school.id, kind: SequenceKind.STUDENT, year } },
      create: { schoolId: school.id, kind: SequenceKind.STUDENT, year, lastValue },
      // Never move a counter backwards: a lower value would reissue an identifier.
      update: { lastValue: { set: lastValue } },
    });
  }

  /* -------------------------------------------------------------------- summary */

  const counts = {
    permissions: await prisma.permission.count(),
    roles: await prisma.role.count(),
    users: await prisma.user.count(),
    departments: await prisma.department.count(),
    programs: await prisma.program.count(),
    levels: await prisma.level.count(),
    academicYears: await prisma.academicYear.count(),
    terms: await prisma.term.count(),
    classSections: await prisma.classSection.count(),
    students: await prisma.student.count(),
    activeStudents: await prisma.student.count({ where: { status: StudentStatus.ACTIVE } }),
    guardians: await prisma.guardian.count(),
    studentGuardianLinks: await prisma.studentGuardian.count(),
    enrollments: await prisma.enrollment.count(),
    currentEnrollments: await prisma.enrollment.count({
      where: { academicYearId: currentAcademicYearId, status: EnrollmentStatus.ENROLLED },
    }),
  };

  log.info({ counts }, 'Seed complete');

  return { schoolId: school.id, currentAcademicYearId, currentTermId, counts };
}

/** Human-readable account list, printed after seeding so the accounts are discoverable. */
export function describeSeedAccounts(): string {
  const password = process.env.SEED_PASSWORD ?? DEFAULT_SEED_PASSWORD;
  const rows = USERS.map((user) => {
    const role = getRoleDefinition(user.roleKey);
    const mfa = role.requiresMfa ? ' (two-factor authentication required)' : '';
    return `  ${user.email.padEnd(38)} ${role.name}${mfa}`;
  });
  return [
    'Seeded accounts -- all share one development password and must change it on first sign-in:',
    ...rows,
    '',
    `  password: ${password}`,
  ].join('\n');
}
