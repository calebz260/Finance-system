/**
 * A school's academic structure, for the Phase 3 suites.
 *
 * Shaped like a real Rwandan secondary school rather than like a minimal fixture: an
 * O'Level programme with a chained level progression, a TVET trade alongside it, and
 * class sections with capacities. Tests about promotion, placement and capacity are
 * only meaningful against a structure that has those things.
 */
import { prisma } from '../../../src/lib/prisma.js';

export interface AcademicFixture {
  readonly academicYearId: string;
  readonly academicYearName: string;
  readonly termIds: readonly string[];
  readonly programId: string;
  readonly programCode: string;
  readonly tradeProgramId: string;
  readonly tradeProgramCode: string;
  /** S1, S2, S3 — chained in that order, S3 terminal. */
  readonly levelIds: readonly string[];
  readonly levelCodes: readonly string[];
  /** A section of S1, capacity 2, so capacity rules can be exercised cheaply. */
  readonly classSectionId: string;
  readonly classSectionCode: string;
  /** A second S1 section with no capacity limit. */
  readonly spareClassSectionId: string;
  readonly spareClassSectionCode: string;
}

export async function seedAcademicStructure(
  schoolId: string,
  options: { yearName?: string; isCurrent?: boolean } = {},
): Promise<AcademicFixture> {
  const yearName = options.yearName ?? '2026';

  const year = await prisma.academicYear.create({
    data: {
      schoolId,
      name: yearName,
      startDate: new Date(Date.UTC(2026, 0, 12)),
      endDate: new Date(Date.UTC(2026, 10, 6)),
      status: 'ACTIVE',
      isCurrent: options.isCurrent ?? true,
    },
  });

  const terms = [
    { name: 'Term 1', sequence: 1, start: [2026, 0, 12], end: [2026, 3, 3], isCurrent: true },
    { name: 'Term 2', sequence: 2, start: [2026, 3, 20], end: [2026, 6, 10], isCurrent: false },
    { name: 'Term 3', sequence: 3, start: [2026, 7, 3], end: [2026, 10, 6], isCurrent: false },
  ] as const;

  const termIds: string[] = [];
  for (const term of terms) {
    const created = await prisma.term.create({
      data: {
        schoolId,
        academicYearId: year.id,
        name: term.name,
        sequence: term.sequence,
        startDate: new Date(Date.UTC(term.start[0], term.start[1], term.start[2])),
        endDate: new Date(Date.UTC(term.end[0], term.end[1], term.end[2])),
        status: term.isCurrent ? 'ACTIVE' : 'UPCOMING',
        isCurrent: term.isCurrent && (options.isCurrent ?? true),
      },
    });
    termIds.push(created.id);
  }

  const program = await prisma.program.create({
    data: {
      schoolId,
      code: 'OLEVEL',
      name: 'Ordinary Level',
      durationYears: 3,
      sortOrder: 1,
    },
  });

  const tradeProgram = await prisma.program.create({
    data: {
      schoolId,
      code: 'SOD',
      name: 'Software Development',
      durationYears: 3,
      sortOrder: 2,
    },
  });

  // Created in reverse so each level can point at the one that follows it: the chain
  // is what promotion walks, and a fixture without it cannot exercise that.
  const levelSpecs = [
    { code: 'S1', name: 'Senior 1', sequence: 1 },
    { code: 'S2', name: 'Senior 2', sequence: 2 },
    { code: 'S3', name: 'Senior 3', sequence: 3 },
  ];

  const levelIds: string[] = [];
  let nextLevelId: string | null = null;
  for (const spec of [...levelSpecs].reverse()) {
    const level: { id: string } = await prisma.level.create({
      data: {
        schoolId,
        programId: program.id,
        code: spec.code,
        name: spec.name,
        sequence: spec.sequence,
        isTerminal: spec.code === 'S3',
        nextLevelId,
      },
    });
    levelIds.unshift(level.id);
    nextLevelId = level.id;
  }

  await prisma.level.create({
    data: {
      schoolId,
      programId: tradeProgram.id,
      code: 'L3',
      name: 'Level 3',
      sequence: 1,
      isTerminal: false,
    },
  });

  const section = await prisma.classSection.create({
    data: {
      schoolId,
      academicYearId: year.id,
      levelId: levelIds[0]!,
      code: 'A',
      name: 'S1 A',
      // Small on purpose: a capacity test should not need to create thirty students.
      capacity: 2,
      classTeacherName: 'Mukamana Jeanne',
    },
  });

  const spare = await prisma.classSection.create({
    data: {
      schoolId,
      academicYearId: year.id,
      levelId: levelIds[0]!,
      code: 'B',
      name: 'S1 B',
      capacity: null,
    },
  });

  return {
    academicYearId: year.id,
    academicYearName: year.name,
    termIds,
    programId: program.id,
    programCode: program.code,
    tradeProgramId: tradeProgram.id,
    tradeProgramCode: tradeProgram.code,
    levelIds,
    levelCodes: levelSpecs.map((spec) => spec.code),
    classSectionId: section.id,
    classSectionCode: section.code,
    spareClassSectionId: spare.id,
    spareClassSectionCode: spare.code,
  };
}
