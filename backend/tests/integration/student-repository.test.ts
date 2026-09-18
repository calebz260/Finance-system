/**
 * The repository contract: tenant scoping and optimistic locking, against a real
 * database.
 *
 * These are the two guarantees the rest of the system is entitled to assume. If scoping
 * is only applied in some queries, a bursar can read another school's students; if the
 * version check is not atomic, two staff members silently overwrite each other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AccessScope } from '../../src/lib/access-scope.js';
import { RecordModifiedError } from '../../src/lib/errors.js';
import { resolvePagination } from '../../src/lib/http.js';
import { prisma } from '../../src/lib/prisma.js';
import { StudentRepository } from '../../src/modules/students/student.repository.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';

const repository = new StudentRepository();

let schoolA = '';
let schoolB = '';
let scopeA: AccessScope;
let scopeB: AccessScope;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();

  const [a, b] = await Promise.all([
    prisma.school.create({ data: { code: 'SCHOOLA', name: 'School A' } }),
    prisma.school.create({ data: { code: 'SCHOOLB', name: 'School B' } }),
  ]);
  schoolA = a.id;
  schoolB = b.id;
  scopeA = AccessScope.forSchool(schoolA);
  scopeB = AccessScope.forSchool(schoolB);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const admissionDate = new Date('2026-01-15T00:00:00.000Z');

describe('create', () => {
  it('allocates a Student ID and stamps the school from the scope', async () => {
    const student = await repository.create(scopeA, {
      firstName: 'Aline',
      lastName: 'Mutesi',
      admissionDate,
    });

    expect(student.studentId).toBe('STU-2026-00001');
    expect(student.schoolId).toBe(schoolA);
    expect(student.admissionYear).toBe(2026);
    expect(student.version).toBe(0);
  });

  it('refuses to create under system scope, which names no school', async () => {
    await expect(
      repository.create(AccessScope.system(), {
        firstName: 'No',
        lastName: 'School',
        admissionDate,
      }),
    ).rejects.toThrow(/must be performed within a specific school/);
  });

  it('numbers each school independently', async () => {
    const [a, b] = await Promise.all([
      repository.create(scopeA, { firstName: 'A', lastName: 'One', admissionDate }),
      repository.create(scopeB, { firstName: 'B', lastName: 'One', admissionDate }),
    ]);

    expect(a.studentId).toBe('STU-2026-00001');
    expect(b.studentId).toBe('STU-2026-00001');
    expect(a.id).not.toBe(b.id);
  });
});

describe('tenant scoping', () => {
  let studentInA = '';

  beforeEach(async () => {
    const student = await repository.create(scopeA, {
      firstName: 'Diane',
      lastName: 'Ingabire',
      admissionDate,
    });
    studentInA = student.id;
    await repository.create(scopeB, {
      firstName: 'Other',
      lastName: 'School',
      admissionDate,
    });
  });

  it('finds a student within its own school', async () => {
    await expect(repository.findById(scopeA, studentInA)).resolves.toMatchObject({
      id: studentInA,
      firstName: 'Diane',
    });
  });

  it('does not find a student from another school, even by exact id', async () => {
    // The whole point of Section 5: the backend must refuse, not merely hide it in the UI.
    await expect(repository.findById(scopeB, studentInA)).resolves.toBeNull();
  });

  it('does not find another school’s student by Student ID either', async () => {
    await expect(repository.findByStudentId(scopeB, 'STU-2026-00001')).resolves.toMatchObject({
      firstName: 'Other',
    });
    // Same identifier string, different school: each sees only its own.
    await expect(repository.findByStudentId(scopeA, 'STU-2026-00001')).resolves.toMatchObject({
      firstName: 'Diane',
    });
  });

  it('lists only the scoped school’s students', async () => {
    const listA = await repository.list(scopeA, {}, resolvePagination({}));
    const listB = await repository.list(scopeB, {}, resolvePagination({}));

    expect(listA.totalItems).toBe(1);
    expect(listA.items[0]?.firstName).toBe('Diane');
    expect(listB.totalItems).toBe(1);
    expect(listB.items[0]?.firstName).toBe('Other');
  });

  it('sees both schools under system scope, which is the only way that happens', async () => {
    const all = await repository.list(AccessScope.system(), {}, resolvePagination({}));
    expect(all.totalItems).toBe(2);
  });

  it('refuses to update a student in another school', async () => {
    await expect(
      repository.update(scopeB, {
        id: studentInA,
        expectedVersion: 0,
        changes: { firstName: 'Hijacked' },
      }),
    ).rejects.toThrow(RecordModifiedError);

    const unchanged = await repository.findById(scopeA, studentInA);
    expect(unchanged?.firstName).toBe('Diane');
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    for (let index = 1; index <= 7; index += 1) {
      await repository.create(scopeA, {
        firstName: `Student${String(index)}`,
        lastName: `Surname${String(index).padStart(2, '0')}`,
        admissionDate,
      });
    }
  });

  it('returns a page plus the full total, so the footer can be rendered', async () => {
    const page = await repository.list(scopeA, {}, resolvePagination({ page: 1, pageSize: 3 }));
    expect(page.items).toHaveLength(3);
    expect(page.totalItems).toBe(7);
  });

  it('pages through without repeating or skipping a student', async () => {
    const pagination = (page: number) => resolvePagination({ page, pageSize: 3 });
    const [first, second, third] = await Promise.all([
      repository.list(scopeA, {}, pagination(1)),
      repository.list(scopeA, {}, pagination(2)),
      repository.list(scopeA, {}, pagination(3)),
    ]);

    const ids = [...first.items, ...second.items, ...third.items].map((s) => s.id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await repository.create(scopeA, {
      firstName: 'Jean',
      lastName: 'Bizimana',
      admissionDate,
    });
    await repository.create(scopeA, {
      firstName: 'Jeanette',
      lastName: 'Mukamana',
      admissionDate,
    });
  });

  it('matches on the Student ID, which is what staff actually type', async () => {
    const result = await repository.list(
      scopeA,
      { search: 'STU-2026-00002' },
      resolvePagination({}),
    );
    expect(result.totalItems).toBe(1);
    expect(result.items[0]?.firstName).toBe('Jeanette');
  });

  it('matches on either name, case-insensitively', async () => {
    const byLast = await repository.list(scopeA, { search: 'mukamana' }, resolvePagination({}));
    expect(byLast.totalItems).toBe(1);

    // Names are not unique identifiers (Section 7): a partial match returning two
    // students is correct, and the caller must disambiguate by Student ID.
    const byFirst = await repository.list(scopeA, { search: 'jean' }, resolvePagination({}));
    expect(byFirst.totalItems).toBe(2);
  });

  it('ignores a blank search rather than matching nothing', async () => {
    const result = await repository.list(scopeA, { search: '   ' }, resolvePagination({}));
    expect(result.totalItems).toBe(2);
  });
});

describe('optimistic locking', () => {
  let studentId = '';

  beforeEach(async () => {
    const student = await repository.create(scopeA, {
      firstName: 'Olivier',
      lastName: 'Rwigema',
      admissionDate,
    });
    studentId = student.id;
  });

  it('applies an update at the expected version and increments it', async () => {
    const updated = await repository.update(scopeA, {
      id: studentId,
      expectedVersion: 0,
      changes: { phone: '+250780000099' },
    });

    expect(updated.phone).toBe('+250780000099');
    expect(updated.version).toBe(1);
  });

  it('rejects a stale write instead of silently overwriting', async () => {
    // Two bursars opened the same record. The first saves; the second must be told to
    // reload rather than having their edit applied over the first.
    await repository.update(scopeA, {
      id: studentId,
      expectedVersion: 0,
      changes: { phone: '+250780000001' },
    });

    await expect(
      repository.update(scopeA, {
        id: studentId,
        expectedVersion: 0,
        changes: { phone: '+250780000002' },
      }),
    ).rejects.toThrow(RecordModifiedError);

    const current = await repository.findById(scopeA, studentId);
    expect(current?.phone).toBe('+250780000001');
    expect(current?.version).toBe(1);
  });

  it('reports a retryable conflict the client can act on', async () => {
    let caught: unknown;
    try {
      await repository.update(scopeA, {
        id: studentId,
        expectedVersion: 99,
        changes: { phone: '+250780000003' },
      });
    } catch (error) {
      caught = error;
    }

    const error = caught as RecordModifiedError;
    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe('RECORD_MODIFIED');
    expect(error.message).toMatch(/Reload and try again/);
  });

  it('lets exactly one of two concurrent updates win', async () => {
    const attempts = await Promise.allSettled([
      repository.update(scopeA, {
        id: studentId,
        expectedVersion: 0,
        changes: { phone: '+250780000010' },
      }),
      repository.update(scopeA, {
        id: studentId,
        expectedVersion: 0,
        changes: { phone: '+250780000020' },
      }),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const current = await repository.findById(scopeA, studentId);
    expect(current?.version).toBe(1);
  });
});
