/**
 * Identifier allocation.
 *
 * The property under test is the one that matters: an identifier is never issued twice,
 * even under concurrency. Two students sharing `STU-2026-00125` would corrupt every
 * receipt, ledger entry and report that references it, and the damage would only surface
 * later, in a reconciliation that does not balance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isValidReceiptNumber, isValidStudentId } from '@sfs/shared';

import {
  SequenceKind,
  allocateReceiptNumber,
  allocateStudentId,
  nextSequenceValue,
} from '../../src/lib/identifier-sequence.js';
import { prisma } from '../../src/lib/prisma.js';
import { assertTestDatabase, resetDatabase } from './helpers/database.js';

let schoolId = '';
let otherSchoolId = '';

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  const [school, other] = await Promise.all([
    prisma.school.create({ data: { code: 'SEQSCHOOL', name: 'Sequence School' } }),
    prisma.school.create({ data: { code: 'SEQOTHER', name: 'Other Sequence School' } }),
  ]);
  schoolId = school.id;
  otherSchoolId = other.id;
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('nextSequenceValue', () => {
  it('starts at 1 and increments', async () => {
    const first = await nextSequenceValue(prisma, {
      schoolId,
      kind: SequenceKind.STUDENT,
      year: 2026,
    });
    const second = await nextSequenceValue(prisma, {
      schoolId,
      kind: SequenceKind.STUDENT,
      year: 2026,
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('keeps separate counters per school, per kind and per year', async () => {
    await nextSequenceValue(prisma, { schoolId, kind: SequenceKind.STUDENT, year: 2026 });
    await nextSequenceValue(prisma, { schoolId, kind: SequenceKind.STUDENT, year: 2026 });

    // Another school starts from scratch.
    await expect(
      nextSequenceValue(prisma, {
        schoolId: otherSchoolId,
        kind: SequenceKind.STUDENT,
        year: 2026,
      }),
    ).resolves.toBe(1);
    // A different kind has its own counter.
    await expect(
      nextSequenceValue(prisma, { schoolId, kind: SequenceKind.RECEIPT, year: 2026 }),
    ).resolves.toBe(1);
    // A new year restarts.
    await expect(
      nextSequenceValue(prisma, { schoolId, kind: SequenceKind.STUDENT, year: 2027 }),
    ).resolves.toBe(1);
  });

  it('issues distinct values under concurrency', async () => {
    // The scenario `MAX(id) + 1` gets wrong: two registrations, or a bulk import racing a
    // registration, reading the same maximum and both writing it.
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        nextSequenceValue(prisma, { schoolId, kind: SequenceKind.STUDENT, year: 2026 }),
      ),
    );

    expect(new Set(results).size).toBe(25);
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it('is race-safe on the create-if-missing path too', async () => {
    // Two callers arriving at once for a brand-new year must not both insert; the unique
    // constraint turns the loser into an update.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        nextSequenceValue(prisma, { schoolId, kind: SequenceKind.RECEIPT, year: 2030 }),
      ),
    );

    expect(new Set(results).size).toBe(10);
    const counters = await prisma.identifierSequence.count({
      where: { schoolId, kind: SequenceKind.RECEIPT, year: 2030 },
    });
    expect(counters).toBe(1);
  });
});

describe('allocateStudentId', () => {
  it('produces identifiers in the documented format', async () => {
    const first = await allocateStudentId(prisma, { schoolId, admissionYear: 2026 });
    const second = await allocateStudentId(prisma, { schoolId, admissionYear: 2026 });

    expect(first).toBe('STU-2026-00001');
    expect(second).toBe('STU-2026-00002');
    expect(isValidStudentId(first)).toBe(true);
  });

  it('honours a school-specific prefix', async () => {
    const identifier = await allocateStudentId(prisma, {
      schoolId,
      admissionYear: 2026,
      prefix: 'GSK',
    });
    expect(identifier).toBe('GSK-2026-00001');
  });

  it('never issues the same identifier twice under concurrent registration', async () => {
    const identifiers = await Promise.all(
      Array.from({ length: 20 }, () =>
        allocateStudentId(prisma, { schoolId, admissionYear: 2026 }),
      ),
    );
    expect(new Set(identifiers).size).toBe(20);
  });

  it('allocates independently for two schools, so both can number from one', async () => {
    const [a, b] = await Promise.all([
      allocateStudentId(prisma, { schoolId, admissionYear: 2026 }),
      allocateStudentId(prisma, { schoolId: otherSchoolId, admissionYear: 2026 }),
    ]);
    expect(a).toBe('STU-2026-00001');
    expect(b).toBe('STU-2026-00001');
  });
});

describe('allocateReceiptNumber', () => {
  it('produces receipt numbers in the documented format', async () => {
    const number = await allocateReceiptNumber(prisma, { schoolId, year: 2026 });
    expect(number).toBe('RCP-2026-000000001');
    expect(isValidReceiptNumber(number)).toBe(true);
  });
});

describe('allocation inside a transaction', () => {
  it('does not consume an identifier when the surrounding transaction rolls back', async () => {
    // A failed registration must not leave a gap in the sequence: to an auditor, a gap
    // looks like a deleted student.
    await expect(
      prisma.$transaction(async (tx) => {
        await allocateStudentId(tx, { schoolId, admissionYear: 2026 });
        throw new Error('registration failed');
      }),
    ).rejects.toThrow('registration failed');

    const afterRollback = await allocateStudentId(prisma, { schoolId, admissionYear: 2026 });
    expect(afterRollback).toBe('STU-2026-00001');
  });
});
