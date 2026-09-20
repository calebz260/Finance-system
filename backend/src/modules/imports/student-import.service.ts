/**
 * Bulk student import.
 *
 * This exists for one concrete job: bringing the school's existing ~1,000 students in
 * from the spreadsheet they are currently kept in. Everything about its design follows
 * from the fact that the file was typed by people over several years.
 *
 *  - **Validate everything, then decide.** A preview writes nothing and reports every
 *    problem it found, against the row and column the person is looking at. An import
 *    that stops at the first bad row means a thousand-row file is fixed one error per
 *    upload.
 *
 *  - **Commit is all-or-nothing.** A half-applied import leaves a registrar unable to
 *    tell which rows landed, and re-running it duplicates the ones that did. One
 *    transaction, or nothing.
 *
 *  - **Be generous about input, strict about meaning.** Column headings are matched
 *    case- and space-insensitively with common aliases, dates are accepted in the
 *    three formats these files actually contain, and a guardian repeated across four
 *    siblings is recognised by phone number and linked rather than duplicated. What is
 *    never guessed is which level or class a student belongs to: an unrecognised code
 *    is an error, because placing a student in the wrong class silently is worse than
 *    refusing the row.
 */
import {
  ErrorCode,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportRowIssue,
} from '@sfs/shared';

import type { Gender, GuardianRelationship, ResidencyType } from '../../generated/prisma/enums.js';
import { DomainError } from '../../lib/errors.js';
import { allocateStudentId } from '../../lib/identifier-sequence.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import { academicRepository, type AcademicRepository } from '../academic/academic.repository.js';
import { requireCurrentAcademicYear } from '../academic/academic.service.js';
import type { Principal } from '../auth/principal.js';
import { readSheet, type SheetRow } from './spreadsheet.js';

const log = createLogger('imports.students');

/** Beyond this the list stops being readable and starts being a wall. */
const MAX_REPORTED_ISSUES = 200;
const SAMPLE_SIZE = 10;

/* ------------------------------------------------------------ column mapping */

/**
 * Accepted headings per field.
 *
 * Matched after lower-casing and stripping everything that is not a letter or digit,
 * so `First Name`, `first_name` and `FIRSTNAME` are the same heading. The aliases are
 * the ones these files genuinely use.
 */
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  firstName: ['firstname', 'givenname', 'forename', 'izina', 'firstnames'],
  lastName: ['lastname', 'surname', 'familyname', 'secondname'],
  otherNames: ['othernames', 'middlename', 'middlenames', 'other'],
  gender: ['gender', 'sex'],
  dateOfBirth: ['dateofbirth', 'dob', 'birthdate', 'datedenaissance'],
  admissionDate: ['admissiondate', 'dateadmitted', 'dateofadmission', 'joined', 'enrolmentdate'],
  programCode: ['programcode', 'programmecode', 'program', 'programme', 'course', 'trade'],
  levelCode: ['levelcode', 'level', 'class', 'grade', 'form'],
  // Note that 'class' is deliberately absent: in Rwandan schools it names the level
  // (S1, S2), which is why it is an alias of levelCode. The A/B group is a stream or
  // a section.
  classSectionCode: ['classsectioncode', 'section', 'stream', 'classsection'],
  residency: ['residency', 'boarding', 'daybaording', 'dayboarding', 'accommodation'],
  district: ['district'],
  sector: ['sector'],
  address: ['address', 'residence'],
  phone: ['phone', 'phonenumber', 'studentphone', 'telephone'],
  email: ['email', 'emailaddress'],
  guardianName: ['guardianname', 'parentname', 'guardian', 'parent', 'fathername', 'mothername'],
  guardianPhone: ['guardianphone', 'parentphone', 'guardiancontact', 'parentcontact', 'contact'],
  guardianRelationship: ['guardianrelationship', 'relationship', 'relation'],
  guardianEmail: ['guardianemail', 'parentemail'],
};

/** Without these a row does not describe a student who can be placed. */
const REQUIRED_COLUMNS = ['firstName', 'lastName', 'levelCode'] as const;

type ColumnMap = Readonly<Record<string, number>>;

function normaliseHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Map the header row onto field names.
 *
 * A missing required column is reported once, as a file-level problem, rather than as
 * a thousand identical row errors — that distinction is the difference between a
 * registrar fixing one heading and scrolling through a wall of noise.
 */
export function mapColumns(header: readonly string[]): {
  columns: ColumnMap;
  missing: readonly string[];
} {
  const normalised = header.map(normaliseHeading);
  const columns: Record<string, number> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = normalised.findIndex((heading) => aliases.includes(heading));
    if (index >= 0) columns[field] = index;
  }

  const missing = REQUIRED_COLUMNS.filter((field) => columns[field] === undefined);
  return { columns, missing };
}

/* ------------------------------------------------------------ value coercion */

function cell(values: readonly string[], columns: ColumnMap, field: string): string {
  const index = columns[field];
  if (index === undefined) return '';
  return (values[index] ?? '').trim();
}

const GENDER_VALUES: Readonly<Record<string, Gender>> = {
  f: 'FEMALE',
  female: 'FEMALE',
  girl: 'FEMALE',
  m: 'MALE',
  male: 'MALE',
  boy: 'MALE',
  other: 'OTHER',
};

const RESIDENCY_VALUES: Readonly<Record<string, ResidencyType>> = {
  day: 'DAY',
  d: 'DAY',
  dayscholar: 'DAY',
  boarding: 'BOARDING',
  b: 'BOARDING',
  boarder: 'BOARDING',
  resident: 'BOARDING',
};

const RELATIONSHIP_VALUES: Readonly<Record<string, GuardianRelationship>> = {
  mother: 'MOTHER',
  mum: 'MOTHER',
  mom: 'MOTHER',
  father: 'FATHER',
  dad: 'FATHER',
  guardian: 'GUARDIAN',
  sibling: 'SIBLING',
  brother: 'SIBLING',
  sister: 'SIBLING',
  sponsor: 'SPONSOR',
  uncle: 'OTHER',
  aunt: 'OTHER',
  other: 'OTHER',
};

/**
 * Parse a date written by a human.
 *
 * Three formats are accepted, and the ambiguous one is resolved deliberately:
 * `YYYY-MM-DD` (what a spreadsheet exports), `DD/MM/YYYY` and `DD-MM-YYYY`. Slash
 * dates are read day-first, which is the Rwandan convention; a file written
 * month-first would silently misread, so any value whose first part exceeds 12 is
 * accepted as unambiguous day-first and anything else is still day-first by policy
 * rather than by guess. That decision is documented in the import template.
 */
export function parseImportDate(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso !== null) {
    return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dayFirst !== null) {
    return buildDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  }

  return null;
}

function buildDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February, which `Date.UTC` rolls forward rather than refusing.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Normalise a Rwandan mobile number so the same parent is recognised across rows.
 *
 * `0788123456`, `250788123456` and `+250 788 123 456` are one number. Without this the
 * same guardian is created four times for four siblings, and the parent portal then
 * shows each of them one child.
 */
export function normalisePhone(value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  if (digits === '') return '';
  if (digits.startsWith('250')) return `+${digits}`;
  if (digits.startsWith('0')) return `+250${digits.slice(1)}`;
  if (digits.length === 9) return `+250${digits}`;
  return `+${digits}`;
}

/* --------------------------------------------------------------- validation */

interface ValidatedRow {
  readonly row: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly otherNames: string | null;
  readonly gender: Gender;
  readonly dateOfBirth: Date | null;
  readonly admissionDate: Date;
  readonly district: string | null;
  readonly sector: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly levelId: string;
  readonly levelCode: string;
  readonly programId: string;
  readonly programCode: string;
  readonly classSectionId: string | null;
  readonly classSectionCode: string | null;
  readonly residency: ResidencyType;
  readonly guardian: {
    readonly firstName: string;
    readonly lastName: string;
    readonly phone: string;
    readonly email: string | null;
    readonly relationship: GuardianRelationship;
  } | null;
}

interface ValidationOutcome {
  readonly valid: readonly ValidatedRow[];
  readonly issues: readonly ImportRowIssue[];
  readonly totalRows: number;
}

/** A lookup of the school's structure, read once for the whole file. */
interface StructureIndex {
  readonly levelsByCode: Map<string, { id: string; programId: string; code: string }>;
  readonly programsByCode: Map<string, { id: string; code: string }>;
  readonly sectionsByKey: Map<string, { id: string; levelId: string; capacity: number | null }>;
  readonly sectionOccupancy: Map<string, number>;
  readonly academicYear: { id: string; startDate: Date; name: string };
}

async function loadStructure(
  actor: Principal,
  academic: AcademicRepository,
): Promise<StructureIndex> {
  const year = await requireCurrentAcademicYear(actor, academic);
  const [levels, programs, sections] = await Promise.all([
    academic.listLevels(actor.scope),
    academic.listPrograms(actor.scope),
    academic.listClassSections(actor.scope, { academicYearId: year.id }),
  ]);

  return {
    levelsByCode: new Map(
      levels.map((level) => [
        level.code.toUpperCase(),
        { id: level.id, programId: level.programId, code: level.code },
      ]),
    ),
    programsByCode: new Map(
      programs.map((program) => [
        program.code.toUpperCase(),
        { id: program.id, code: program.code },
      ]),
    ),
    sectionsByKey: new Map(
      sections.map((section) => [
        `${section.levelId}:${section.code.toUpperCase()}`,
        { id: section.id, levelId: section.levelId, capacity: section.capacity },
      ]),
    ),
    // Seeded from what is already enrolled, then incremented as the file is walked, so
    // a file that would overfill a class is caught at preview rather than at commit.
    sectionOccupancy: new Map(sections.map((section) => [section.id, section._count.enrollments])),
    academicYear: { id: year.id, startDate: year.startDate, name: year.name },
  };
}

function issue(
  row: number,
  column: string | null,
  message: string,
  value: string | null = null,
): ImportRowIssue {
  return { row, column, message, value: value === '' ? null : value };
}

/**
 * Validate every row, collecting problems rather than stopping at the first.
 *
 * Duplicate detection within the file is included: two rows for the same person is a
 * common copy-paste artefact, and creating both would give one student two Student IDs
 * and two sets of charges.
 */
export function validateRows(
  rows: readonly SheetRow[],
  columns: ColumnMap,
  structure: StructureIndex,
): ValidationOutcome {
  const valid: ValidatedRow[] = [];
  const issues: ImportRowIssue[] = [];
  const seen = new Map<string, number>();

  const body = rows.slice(1);

  for (const sheetRow of body) {
    const { row, values } = sheetRow;
    const before = issues.length;

    const firstName = cell(values, columns, 'firstName');
    const lastName = cell(values, columns, 'lastName');
    if (firstName === '') issues.push(issue(row, 'firstName', 'A first name is required.'));
    if (lastName === '') issues.push(issue(row, 'lastName', 'A last name is required.'));

    // Same person twice in one file: the second occurrence is reported rather than
    // created, because one student must not end up with two identifiers.
    const identity = `${firstName.toLowerCase()}|${lastName.toLowerCase()}|${cell(values, columns, 'dateOfBirth')}`;
    const firstSeenAt = seen.get(identity);
    if (firstName !== '' && lastName !== '') {
      if (firstSeenAt !== undefined) {
        issues.push(
          issue(
            row,
            null,
            `This looks like the same student as row ${String(firstSeenAt)}. Remove the duplicate or add a date of birth to tell them apart.`,
            `${firstName} ${lastName}`,
          ),
        );
      } else {
        seen.set(identity, row);
      }
    }

    const genderRaw = cell(values, columns, 'gender');
    const gender = genderRaw === '' ? 'UNDISCLOSED' : GENDER_VALUES[genderRaw.toLowerCase()];
    if (gender === undefined) {
      issues.push(issue(row, 'gender', 'Use F, M or leave it blank.', genderRaw));
    }

    const dobRaw = cell(values, columns, 'dateOfBirth');
    const dateOfBirth = dobRaw === '' ? null : parseImportDate(dobRaw);
    if (dobRaw !== '' && dateOfBirth === null) {
      issues.push(issue(row, 'dateOfBirth', 'Use YYYY-MM-DD or DD/MM/YYYY.', dobRaw));
    }

    const admissionRaw = cell(values, columns, 'admissionDate');
    const parsedAdmission = admissionRaw === '' ? null : parseImportDate(admissionRaw);
    if (admissionRaw !== '' && parsedAdmission === null) {
      issues.push(issue(row, 'admissionDate', 'Use YYYY-MM-DD or DD/MM/YYYY.', admissionRaw));
    }
    // An absent admission date means "started with this year", which is what a list of
    // existing students usually implies.
    const admissionDate = parsedAdmission ?? structure.academicYear.startDate;

    const levelCode = cell(values, columns, 'levelCode').toUpperCase();
    const level = structure.levelsByCode.get(levelCode);
    if (levelCode === '') {
      issues.push(issue(row, 'levelCode', 'A level is required.'));
    } else if (level === undefined) {
      issues.push(
        issue(
          row,
          'levelCode',
          'No level with that code exists. Add the level first, or correct the spelling.',
          levelCode,
        ),
      );
    }

    // The programme column is optional: the level already determines it, and a
    // conflicting value is worth reporting rather than silently preferring one.
    const programCode = cell(values, columns, 'programCode').toUpperCase();
    if (programCode !== '' && level !== undefined) {
      const program = structure.programsByCode.get(programCode);
      if (program === undefined) {
        issues.push(issue(row, 'programCode', 'No programme with that code exists.', programCode));
      } else if (program.id !== level.programId) {
        issues.push(
          issue(
            row,
            'programCode',
            `Level ${levelCode} does not belong to programme ${programCode}.`,
            programCode,
          ),
        );
      }
    }

    const sectionCode = cell(values, columns, 'classSectionCode').toUpperCase();
    let classSectionId: string | null = null;
    if (sectionCode !== '' && level !== undefined) {
      const section = structure.sectionsByKey.get(`${level.id}:${sectionCode}`);
      if (section === undefined) {
        issues.push(
          issue(
            row,
            'classSectionCode',
            `No class ${sectionCode} exists for level ${levelCode} in ${structure.academicYear.name}.`,
            sectionCode,
          ),
        );
      } else {
        const occupied = structure.sectionOccupancy.get(section.id) ?? 0;
        if (section.capacity !== null && occupied >= section.capacity) {
          issues.push(
            issue(
              row,
              'classSectionCode',
              `Class ${sectionCode} is full (${String(section.capacity)} places). Raise its capacity or use another class.`,
              sectionCode,
            ),
          );
        } else {
          classSectionId = section.id;
          structure.sectionOccupancy.set(section.id, occupied + 1);
        }
      }
    }

    const residencyRaw = cell(values, columns, 'residency');
    const residency = residencyRaw === '' ? 'DAY' : RESIDENCY_VALUES[residencyRaw.toLowerCase()];
    if (residency === undefined) {
      issues.push(issue(row, 'residency', 'Use Day or Boarding.', residencyRaw));
    }

    const guardianName = cell(values, columns, 'guardianName');
    const guardianPhoneRaw = cell(values, columns, 'guardianPhone');
    const guardianPhone = normalisePhone(guardianPhoneRaw);
    let guardian: ValidatedRow['guardian'] = null;

    // A file that carries no guardian-name column at all cannot produce guardians.
    // That is a fact about the file, not a fault in each of its thousand rows, so it
    // is left to show up in the preview sample as an empty guardian rather than as a
    // thousand identical errors.
    const hasGuardianNameColumn = columns.guardianName !== undefined;

    if (guardianName !== '' || (guardianPhoneRaw !== '' && hasGuardianNameColumn)) {
      // A guardian with no number is a contact the school cannot reach, and the phone
      // is also how the same parent is recognised across siblings.
      if (guardianPhone === '') {
        issues.push(
          issue(row, 'guardianPhone', 'A guardian needs a phone number.', guardianPhoneRaw),
        );
      } else if (guardianName === '') {
        issues.push(issue(row, 'guardianName', 'A guardian needs a name.'));
      } else {
        const parts = guardianName.split(/\s+/);
        const relationshipRaw = cell(values, columns, 'guardianRelationship');
        const relationship =
          relationshipRaw === ''
            ? 'GUARDIAN'
            : (RELATIONSHIP_VALUES[relationshipRaw.toLowerCase()] ?? 'OTHER');

        guardian = {
          firstName: parts[0] ?? guardianName,
          lastName: parts.slice(1).join(' ') || (parts[0] ?? guardianName),
          phone: guardianPhone,
          email: cell(values, columns, 'guardianEmail') || null,
          relationship,
        };
      }
    }

    if (issues.length !== before || level === undefined) continue;

    valid.push({
      row,
      firstName,
      lastName,
      otherNames: cell(values, columns, 'otherNames') || null,
      gender: gender ?? 'UNDISCLOSED',
      dateOfBirth,
      admissionDate,
      district: cell(values, columns, 'district') || null,
      sector: cell(values, columns, 'sector') || null,
      address: cell(values, columns, 'address') || null,
      phone: cell(values, columns, 'phone') || null,
      email: cell(values, columns, 'email') || null,
      levelId: level.id,
      levelCode: level.code,
      programId: level.programId,
      programCode,
      classSectionId,
      classSectionCode: sectionCode || null,
      residency: residency ?? 'DAY',
      guardian,
    });
  }

  return { valid, issues, totalRows: body.length };
}

/* ------------------------------------------------------------------- preview */

async function parseAndValidate(
  actor: Principal,
  file: { fileName: string; buffer: Buffer },
  academic: AcademicRepository,
): Promise<{ structure: StructureIndex; outcome: ValidationOutcome }> {
  const rows = await readSheet(file);
  const header = rows[0]?.values ?? [];

  const { columns, missing } = mapColumns(header);
  if (missing.length > 0) {
    // A file-level problem, reported as one message rather than as one per row.
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `The file is missing required column(s): ${missing.join(', ')}. The first row must be a header.`,
      { details: { missingColumns: missing, headingsFound: header } },
    );
  }

  const structure = await loadStructure(actor, academic);
  return { structure, outcome: validateRows(rows, columns, structure) };
}

function toPreviewRow(row: ValidatedRow): ImportPreviewRow {
  return {
    row: row.row,
    firstName: row.firstName,
    lastName: row.lastName,
    otherNames: row.otherNames,
    gender: row.gender,
    dateOfBirth: row.dateOfBirth === null ? null : row.dateOfBirth.toISOString().slice(0, 10),
    admissionDate: row.admissionDate.toISOString().slice(0, 10),
    levelCode: row.levelCode,
    programCode: row.programCode,
    classSectionCode: row.classSectionCode,
    residency: row.residency,
    guardianName:
      row.guardian === null ? null : `${row.guardian.firstName} ${row.guardian.lastName}`,
    guardianPhone: row.guardian?.phone ?? null,
    guardianRelationship: row.guardian?.relationship ?? null,
  };
}

/**
 * Validate an uploaded file and report what would happen. Writes nothing.
 */
export async function previewStudentImport(
  actor: Principal,
  file: { fileName: string; buffer: Buffer },
  academic: AcademicRepository = academicRepository,
): Promise<ImportPreview> {
  const { outcome } = await parseAndValidate(actor, file, academic);

  const rowsWithIssues = new Set(outcome.issues.map((item) => item.row)).size;

  return {
    fileName: file.fileName,
    totalRows: outcome.totalRows,
    validRows: outcome.valid.length,
    rowsWithIssues,
    issues: outcome.issues.slice(0, MAX_REPORTED_ISSUES),
    issuesTruncated: outcome.issues.length > MAX_REPORTED_ISSUES,
    sample: outcome.valid.slice(0, SAMPLE_SIZE).map(toPreviewRow),
  };
}

/* -------------------------------------------------------------------- commit */

export interface CommitImportOptions {
  /**
   * Import the valid rows even though some rows failed.
   *
   * Off by default, and the default is the safe one: a file with errors is usually a
   * file with a systematic problem, and importing the 900 rows that parsed leaves the
   * registrar to reconcile which 100 did not.
   */
  readonly allowPartial?: boolean;
}

/**
 * Apply an import.
 *
 * Everything happens in one transaction: students, their identifiers, their guardians
 * and their enrolments. If any row fails, nothing is written, and the file can be
 * fixed and re-uploaded without wondering what already landed.
 */
export async function commitStudentImport(
  actor: Principal,
  file: { fileName: string; buffer: Buffer },
  options: CommitImportOptions = {},
  academic: AcademicRepository = academicRepository,
): Promise<ImportResult> {
  const { structure, outcome } = await parseAndValidate(actor, file, academic);
  const schoolId = actor.scope.requireSchoolId();

  if (outcome.issues.length > 0 && options.allowPartial !== true) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `${String(outcome.issues.length)} problem(s) were found and nothing was imported. Fix the file and upload it again, or choose to import only the valid rows.`,
      {
        details: {
          totalRows: outcome.totalRows,
          validRows: outcome.valid.length,
          issues: outcome.issues.slice(0, MAX_REPORTED_ISSUES),
        },
      },
    );
  }

  if (outcome.valid.length === 0) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'No valid rows to import.');
  }

  const counters = { students: 0, guardians: 0, links: 0, enrollments: 0 };

  await prisma.$transaction(
    async (tx) => {
      // Guardians already in the database, keyed by normalised phone, so a parent who
      // already has a record is linked rather than duplicated.
      const guardianIdByPhone = new Map<string, string>();

      for (const row of outcome.valid) {
        const studentId = await allocateStudentId(tx, {
          schoolId,
          admissionYear: row.admissionDate.getUTCFullYear(),
        });

        const student = await tx.student.create({
          data: {
            schoolId,
            studentId,
            firstName: row.firstName,
            lastName: row.lastName,
            otherNames: row.otherNames,
            gender: row.gender,
            dateOfBirth: row.dateOfBirth,
            admissionDate: row.admissionDate,
            admissionYear: row.admissionDate.getUTCFullYear(),
            district: row.district,
            sector: row.sector,
            address: row.address,
            phone: row.phone,
            email: row.email,
          },
          select: { id: true },
        });
        counters.students += 1;

        await tx.enrollment.create({
          data: {
            schoolId,
            studentId: student.id,
            academicYearId: structure.academicYear.id,
            programId: row.programId,
            levelId: row.levelId,
            classSectionId: row.classSectionId,
            status: 'ENROLLED',
            // These students are already at the school; the import records where they
            // are now, not that they are joining today.
            enrollmentType: 'CONTINUING',
            residency: row.residency,
            startDate: structure.academicYear.startDate,
          },
        });
        counters.enrollments += 1;

        if (row.guardian === null) continue;

        let guardianId = guardianIdByPhone.get(row.guardian.phone);
        if (guardianId === undefined) {
          const existing = await tx.guardian.findFirst({
            where: { schoolId, phone: row.guardian.phone },
            select: { id: true },
          });

          if (existing === null) {
            const created = await tx.guardian.create({
              data: {
                schoolId,
                firstName: row.guardian.firstName,
                lastName: row.guardian.lastName,
                phone: row.guardian.phone,
                email: row.guardian.email,
              },
              select: { id: true },
            });
            guardianId = created.id;
            counters.guardians += 1;
          } else {
            guardianId = existing.id;
          }

          guardianIdByPhone.set(row.guardian.phone, guardianId);
        }

        await tx.studentGuardian.create({
          data: {
            schoolId,
            studentId: student.id,
            guardianId,
            relationship: row.guardian.relationship,
            // The imported guardian is the school's contact for this student and the
            // person expected to pay, which is what the spreadsheet column means.
            isPrimaryContact: true,
            isFinanciallyResponsible: true,
            canViewFinancials: true,
            canInitiatePayments: true,
          },
        });
        counters.links += 1;
      }
    },
    // A thousand rows, each allocating an identifier and writing three tables, is well
    // beyond the default interactive-transaction timeout.
    { timeout: 120_000, maxWait: 10_000 },
  );

  await record({
    action: AuditAction.STUDENT_IMPORTED,
    entityType: AuditEntity.STUDENT,
    actorUserId: actor.userId,
    schoolId,
    metadata: {
      fileName: file.fileName,
      academicYearId: structure.academicYear.id,
      studentsCreated: counters.students,
      guardiansCreated: counters.guardians,
      guardiansLinked: counters.links,
      enrollmentsCreated: counters.enrollments,
      rowsRejected: outcome.totalRows - outcome.valid.length,
      partial: options.allowPartial === true && outcome.issues.length > 0,
    },
  });

  log.info(
    { ...counters, fileName: file.fileName, actorUserId: actor.userId },
    'Bulk student import committed',
  );

  return {
    studentsCreated: counters.students,
    guardiansCreated: counters.guardians,
    guardiansLinked: counters.links,
    enrollmentsCreated: counters.enrollments,
    rowsRejected: outcome.totalRows - outcome.valid.length,
    issues: outcome.issues.slice(0, MAX_REPORTED_ISSUES),
    issuesTruncated: outcome.issues.length > MAX_REPORTED_ISSUES,
  };
}
