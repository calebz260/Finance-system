/**
 * The bulk student import, end to end.
 *
 * This is the feature the school actually adopts the system with: roughly a thousand
 * students in a spreadsheet typed by several people over several years. The tests are
 * therefore about messy input and about trust — a preview that writes nothing, errors
 * that name the row on screen, and a commit that either applies wholly or not at all.
 */
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RoleKey } from '@sfs/shared';

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

// 'Section' rather than 'Class' for the A/B group: in Rwandan schools 'Class' names
// the level (S1), which is how the importer reads it.
const HEADER =
  'First Name,Last Name,Gender,Date of Birth,Level,Section,Guardian Name,Guardian Phone,Relationship';

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

function preview(file: Buffer, fileName = 'students.csv'): request.Test {
  return request(app)
    .post('/api/v1/students/import/preview')
    .set('Authorization', bearer(adminSession))
    .attach('file', file, fileName);
}

function commit(
  file: Buffer,
  options: { fileName?: string; allowPartial?: boolean } = {},
): request.Test {
  const call = request(app)
    .post('/api/v1/students/import')
    .set('Authorization', bearer(adminSession));

  if (options.allowPartial === true) void call.field('allowPartial', 'true');
  return call.attach('file', file, options.fileName ?? 'students.csv');
}

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
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('preview', () => {
  it('reports what would be created without writing anything', async () => {
    const response = await preview(
      csv(
        'Aline,Mutesi,F,2012-04-18,S1,B,Jean Mutesi,0788123456,Father',
        'Diane,Keza,F,2012-09-02,S1,B,Claudine Keza,0788999888,Mother',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.data.totalRows).toBe(2);
    expect(response.body.data.validRows).toBe(2);
    expect(response.body.data.rowsWithIssues).toBe(0);
    expect(response.body.data.sample).toHaveLength(2);

    // The point of a preview: nothing exists yet.
    expect(await prisma.student.count()).toBe(0);
    expect(await prisma.guardian.count()).toBe(0);
  });

  it('numbers issues by the row the registrar sees on screen', async () => {
    // Row 1 is the header, so the first bad data row is row 2 — not index 0.
    const response = await preview(csv('Aline,Mutesi,F,2012-04-18,NOPE,B,,,'));

    expect(response.body.data.issues[0].row).toBe(2);
    expect(response.body.data.issues[0].column).toBe('levelCode');
    expect(response.body.data.issues[0].value).toBe('NOPE');
  });

  it('collects every problem rather than stopping at the first', async () => {
    // A thousand-row file fixed one error per upload is unusable.
    const response = await preview(
      csv(
        ',Mutesi,F,2012-04-18,S1,B,,,',
        'Diane,,F,notadate,S1,B,,,',
        'Eric,Nkusi,X,2012-01-01,GHOST,B,,,',
      ),
    );

    expect(response.body.data.validRows).toBe(0);
    expect(response.body.data.rowsWithIssues).toBe(3);
    expect(response.body.data.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('reports a missing required column once, not once per row', async () => {
    const file = Buffer.from(
      ['Name,Level', 'Aline Mutesi,S1', 'Diane Keza,S1', 'Eric Nkusi,S1'].join('\n'),
      'utf8',
    );

    const response = await preview(file);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/missing required column/i);
    expect(response.body.error.details.missingColumns).toContain('firstName');
  });

  it('accepts the column names these spreadsheets actually use', async () => {
    const file = Buffer.from(
      ['Surname,Given Name,Class,Parent Contact,DOB', 'Mutesi,Aline,S1,0788123456,18/04/2012'].join(
        '\n',
      ),
      'utf8',
    );

    const response = await preview(file);

    expect(response.status).toBe(200);
    expect(response.body.data.validRows).toBe(1);
    expect(response.body.data.sample[0].firstName).toBe('Aline');
    expect(response.body.data.sample[0].dateOfBirth).toBe('2012-04-18');
    // 'Class' names the level here, so S1 is read as the level rather than a section.
    expect(response.body.data.sample[0].levelCode).toBe('S1');
  });

  it('does not fault every row when the file carries no guardian-name column', async () => {
    // A contact number with nowhere to put a name is a fact about the file. Reporting
    // it a thousand times would bury every real problem in it.
    const file = Buffer.from(
      [
        'First Name,Last Name,Level,Parent Contact',
        'Aline,Mutesi,S1,0788123456',
        'Diane,Keza,S1,0788999888',
      ].join('\n'),
      'utf8',
    );

    const response = await preview(file);

    expect(response.status).toBe(200);
    expect(response.body.data.validRows).toBe(2);
    expect(response.body.data.issues).toHaveLength(0);
    // The preview sample is where the registrar sees that no guardian is coming in.
    expect(response.body.data.sample[0].guardianName).toBeNull();
  });

  it('flags a duplicate of an earlier row in the same file', async () => {
    const response = await preview(
      csv('Aline,Mutesi,F,2012-04-18,S1,B,,,', 'Aline,Mutesi,F,2012-04-18,S1,B,,,'),
    );

    expect(response.body.data.validRows).toBe(1);
    expect(response.body.data.issues[0].message).toMatch(/same student as row 2/i);
  });

  it('flags a class that the file would overfill', async () => {
    // Class A holds two. Three rows for it is caught at preview, not at commit.
    const response = await preview(
      csv(
        'One,Student,F,2012-01-01,S1,A,,,',
        'Two,Student,F,2012-01-02,S1,A,,,',
        'Three,Student,F,2012-01-03,S1,A,,,',
      ),
    );

    expect(response.body.data.validRows).toBe(2);
    expect(response.body.data.issues[0].message).toMatch(/full/i);
    expect(response.body.data.issues[0].row).toBe(4);
  });

  it('reads an .xlsx workbook, including its dates', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Students');
    sheet.addRow(['First Name', 'Last Name', 'Gender', 'Date of Birth', 'Level', 'Class']);
    sheet.addRow(['Aline', 'Mutesi', 'F', new Date(Date.UTC(2012, 3, 18)), 'S1', 'B']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const response = await preview(buffer, 'students.xlsx');

    expect(response.status).toBe(200);
    expect(response.body.data.validRows).toBe(1);
    expect(response.body.data.sample[0].dateOfBirth).toBe('2012-04-18');
  });

  it('refuses a file type it cannot read', async () => {
    const response = await preview(Buffer.from('not a spreadsheet', 'utf8'), 'students.pdf');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/\.csv or \.xlsx/i);
  });

  it('refuses a file with a header and no rows', async () => {
    const response = await preview(csv());

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/no student rows/i);
  });

  it('lets a bursar preview, since looking writes nothing', async () => {
    const response = await request(app)
      .post('/api/v1/students/import/preview')
      .set('Authorization', bearer(bursarSession))
      .attach('file', csv('Aline,Mutesi,F,2012-04-18,S1,B,,,'), 'students.csv');

    expect(response.status).toBe(200);
  });
});

describe('commit', () => {
  it('creates students, enrolments, guardians and links in one go', async () => {
    const response = await commit(
      csv(
        'Aline,Mutesi,F,2012-04-18,S1,B,Jean Mutesi,0788123456,Father',
        'Diane,Keza,F,2012-09-02,S1,B,Claudine Keza,0788999888,Mother',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.data.studentsCreated).toBe(2);
    expect(response.body.data.guardiansCreated).toBe(2);
    expect(response.body.data.guardiansLinked).toBe(2);
    expect(response.body.data.enrollmentsCreated).toBe(2);

    expect(await prisma.student.count({ where: { schoolId } })).toBe(2);
    expect(await prisma.enrollment.count({ where: { schoolId } })).toBe(2);
  });

  it('allocates a distinct Student ID to every imported student', async () => {
    await commit(
      csv(
        'One,Student,F,2012-01-01,S1,B,,,',
        'Two,Student,F,2012-01-02,S1,B,,,',
        'Three,Student,F,2012-01-03,S1,B,,,',
      ),
    );

    const ids = (
      await prisma.student.findMany({ where: { schoolId }, select: { studentId: true } })
    ).map((student) => student.studentId);

    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('STU-2026-00001');
    expect(ids).toContain('STU-2026-00003');
  });

  it('recognises the same parent across siblings by phone number', async () => {
    // Four children of one parent must not produce four guardian records, or the
    // parent portal shows each of them one child.
    const response = await commit(
      csv(
        'Aline,Mutesi,F,2012-04-18,S1,B,Jean Mutesi,0788123456,Father',
        'Eric,Mutesi,M,2014-02-10,S1,B,Jean Mutesi,+250 788 123 456,Father',
        'Sandra,Mutesi,F,2015-06-01,S1,B,Jean Mutesi,250788123456,Father',
      ),
    );

    expect(response.body.data.studentsCreated).toBe(3);
    expect(response.body.data.guardiansCreated).toBe(1);
    expect(response.body.data.guardiansLinked).toBe(3);

    const guardian = await prisma.guardian.findFirstOrThrow({ where: { schoolId } });
    expect(guardian.phone).toBe('+250788123456');
  });

  it('links to a guardian who already exists rather than duplicating them', async () => {
    await prisma.guardian.create({
      data: { schoolId, firstName: 'Jean', lastName: 'Mutesi', phone: '+250788123456' },
    });

    const response = await commit(
      csv('Aline,Mutesi,F,2012-04-18,S1,B,Jean Mutesi,0788123456,Father'),
    );

    expect(response.body.data.guardiansCreated).toBe(0);
    expect(response.body.data.guardiansLinked).toBe(1);
    expect(await prisma.guardian.count({ where: { schoolId } })).toBe(1);
  });

  it('writes nothing at all when any row is invalid', async () => {
    // A half-applied import leaves the registrar unable to tell which rows landed.
    const response = await commit(
      csv('Aline,Mutesi,F,2012-04-18,S1,B,,,', 'Diane,Keza,F,2012-09-02,GHOST,B,,,'),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/nothing was imported/i);
    expect(await prisma.student.count()).toBe(0);
  });

  it('imports only the valid rows when that is asked for explicitly', async () => {
    const response = await commit(
      csv('Aline,Mutesi,F,2012-04-18,S1,B,,,', 'Diane,Keza,F,2012-09-02,GHOST,B,,,'),
      { allowPartial: true },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.studentsCreated).toBe(1);
    expect(response.body.data.rowsRejected).toBe(1);
    expect(response.body.data.issues).toHaveLength(1);
  });

  it('enrols every imported student into the current year', async () => {
    await commit(csv('Aline,Mutesi,F,2012-04-18,S1,B,,,'));

    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { schoolId } });
    expect(enrollment.academicYearId).toBe(academic.academicYearId);
    expect(enrollment.status).toBe('ENROLLED');
    // These students are already at the school; the import records where they are.
    expect(enrollment.enrollmentType).toBe('CONTINUING');
  });

  it('gives the imported guardian the financial rights the column implies', async () => {
    await commit(csv('Aline,Mutesi,F,2012-04-18,S1,B,Jean Mutesi,0788123456,Father'));

    const link = await prisma.studentGuardian.findFirstOrThrow({ where: { schoolId } });
    expect(link.isPrimaryContact).toBe(true);
    expect(link.isFinanciallyResponsible).toBe(true);
    expect(link.canViewFinancials).toBe(true);
  });

  it('audits the import with its counts', async () => {
    await commit(csv('Aline,Mutesi,F,2012-04-18,S1,B,,,'), { fileName: 'roll-2026.csv' });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student.imported' },
    });
    expect(entry.metadata).toMatchObject({ fileName: 'roll-2026.csv', studentsCreated: 1 });
  });

  it('requires the import permission, which a bursar does not hold', async () => {
    const response = await request(app)
      .post('/api/v1/students/import')
      .set('Authorization', bearer(bursarSession))
      .attach('file', csv('Aline,Mutesi,F,2012-04-18,S1,B,,,'), 'students.csv');

    expect(response.status).toBe(403);
    expect(await prisma.student.count()).toBe(0);
  });

  it('handles a realistically messy file', async () => {
    // Quoted address with a comma, mixed date formats, mixed phone formats, blank
    // optional columns, and trailing blank rows.
    const file = Buffer.from(
      [
        'First Name,Last Name,Gender,Date of Birth,Level,Section,Guardian Name,Guardian Phone,Relationship',
        'Aline,Mutesi,F,2012-04-18,S1,B,Jean Mutesi,0788123456,Father',
        'Eric,"Nkusi, Jr",M,02/09/2013,S1,B,,,',
        'Sandra,Uwase,,,S1,,Claudine Uwase,+250788999888,mum',
        ',,,,,,,,',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const response = await commit(file);

    expect(response.status).toBe(200);
    expect(response.body.data.studentsCreated).toBe(3);

    const nkusi = await prisma.student.findFirstOrThrow({ where: { firstName: 'Eric' } });
    expect(nkusi.lastName).toBe('Nkusi, Jr');
    expect(nkusi.dateOfBirth?.toISOString().slice(0, 10)).toBe('2013-09-02');

    const sandra = await prisma.student.findFirstOrThrow({ where: { firstName: 'Sandra' } });
    expect(sandra.gender).toBe('UNDISCLOSED');
    expect(sandra.dateOfBirth).toBeNull();
  });

  it('imports a thousand rows in one transaction', async () => {
    // The actual job this feature exists for. Also the case where a per-row query
    // pattern or a default transaction timeout would show up.
    const rows = Array.from(
      { length: 1000 },
      (_, index) =>
        `Student${String(index)},Family${String(index % 50)},F,2012-01-01,S1,,Parent${String(index % 50)} Family,07880${String(10000 + (index % 50))},Mother`,
    );

    const response = await commit(csv(...rows));

    expect(response.status).toBe(200);
    expect(response.body.data.studentsCreated).toBe(1000);
    // Fifty distinct parents across a thousand children.
    expect(response.body.data.guardiansCreated).toBe(50);
    expect(response.body.data.guardiansLinked).toBe(1000);

    expect(await prisma.student.count({ where: { schoolId } })).toBe(1000);
    expect(await prisma.enrollment.count({ where: { schoolId } })).toBe(1000);

    const ids = await prisma.student.findMany({ where: { schoolId }, select: { studentId: true } });
    expect(new Set(ids.map((item) => item.studentId)).size).toBe(1000);
  }, 180_000);
});
