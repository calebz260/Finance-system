/**
 * Bank statement import and reconciliation, over real HTTP.
 *
 * The cases that matter are the ones about attributing money correctly and about refusing
 * to guess:
 *
 *  - importing a statement attributes what is unambiguous and **credits nothing**;
 *  - the same file cannot be imported twice;
 *  - a line and a payment of different amounts cannot be matched at all;
 *  - matching with confirmation credits the ledger exactly once, through the same
 *    verification path a bursar uses by hand;
 *  - a line that has already credited a payment cannot be quietly detached from it;
 *  - the summary reports both sides: money the school cannot explain, and claims the bank
 *    has no record of.
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
let secondBursarSession: Session;
let financeSession: Session;
let dosSession: Session;
let student: { id: string; studentId: string };

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

  secondBursarSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'bursar2@gskicukiro.invalid',
      roleKeys: [RoleKey.BURSAR],
      schoolId,
    }),
  );

  financeSession = await signIn(
    app,
    await createTestUser(roleIds, {
      email: 'finance@gskicukiro.invalid',
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

  student = await registerStudent();
  await chargeStudent(student.id, '120000.00');
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ fixtures */

async function registerStudent(): Promise<{ id: string; studentId: string }> {
  const response = await request(app)
    .post('/api/v1/students')
    .set('Authorization', bearer(adminSession))
    .send({
      firstName: 'Aline',
      lastName: 'Uwase',
      gender: 'FEMALE',
      dateOfBirth: '2010-05-14',
      admissionDate: '2026-01-12',
      enrolment: {
        levelId: academic.levelIds[0],
        classSectionId: academic.spareClassSectionId,
        residency: 'DAY',
      },
    });

  expect(response.status).toBe(201);
  return { id: response.body.data.id as string, studentId: response.body.data.studentId as string };
}

async function chargeStudent(studentId: string, amount: string): Promise<void> {
  const category = await request(app)
    .post('/api/v1/fee-categories')
    .set('Authorization', bearer(adminSession))
    .send({ code: `FEE${String(Math.floor(Math.random() * 100_000))}`, name: 'Tuition' });
  expect(category.status).toBe(201);

  const charge = await request(app)
    .post('/api/v1/charges')
    .set('Authorization', bearer(bursarSession))
    .send({
      studentId,
      feeCategoryId: category.body.data.id,
      academicYearId: academic.academicYearId,
      termId: academic.termIds[0],
      description: 'Tuition, Term 1',
      amount,
      notes: 'Raised by the reconciliation suite so there is a balance to pay.',
    });

  expect(charge.status).toBe(201);
}

/** Record a manual claim, which is what a statement line is later matched to. */
async function recordClaim(
  overrides: { amount?: string; session?: Session } = {},
): Promise<{ id: string; reference: string; version: number; amount: string }> {
  const response = await request(app)
    .post('/api/v1/payments/manual-claims')
    .set('Authorization', bearer(overrides.session ?? bursarSession))
    .send({
      studentId: student.id,
      amount: overrides.amount ?? '50000.00',
      payerName: 'Jean Uwase',
      method: 'BANK_TRANSFER',
      providerKey: 'BANK_OF_KIGALI',
    });

  expect(response.status).toBe(201);
  return {
    id: response.body.data.id as string,
    reference: response.body.data.reference as string,
    version: response.body.data.version as number,
    amount: response.body.data.amount as string,
  };
}

interface StatementRow {
  readonly date?: string;
  readonly narrative: string;
  readonly reference?: string;
  readonly credit?: string;
  readonly debit?: string;
}

/**
 * A statement in the shape a Rwandan bank exports: date, details, reference, credit, debit.
 *
 * Amounts are quoted, because a real export quotes any cell containing a thousands
 * separator — and an unquoted `50,000.00` is two columns, not one figure. Getting that
 * wrong in the fixture would test the harness rather than the parser.
 */
function statementCsv(rows: readonly StatementRow[]): Buffer {
  const lines = ['Date,Narrative,Reference,Credit,Debit'];
  for (const row of rows) {
    lines.push(
      [
        row.date ?? '2026-09-21',
        `"${row.narrative}"`,
        row.reference ?? '',
        `"${row.credit ?? ''}"`,
        `"${row.debit ?? ''}"`,
      ].join(','),
    );
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

async function preview(
  file: Buffer,
  session: Session = bursarSession,
  fileName = 'statement.csv',
): Promise<request.Response> {
  return request(app)
    .post('/api/v1/reconciliation/statements/preview')
    .set('Authorization', bearer(session))
    .attach('file', file, fileName);
}

async function importStatement(
  file: Buffer,
  options: { session?: Session; fileName?: string; provider?: string } = {},
): Promise<request.Response> {
  return request(app)
    .post('/api/v1/reconciliation/statements')
    .set('Authorization', bearer(options.session ?? bursarSession))
    .field('provider', options.provider ?? 'BANK_OF_KIGALI')
    .field('accountLabel', 'BK collection account 000123')
    .attach('file', file, options.fileName ?? 'statement.csv');
}

async function lines(
  query = '',
  session: Session = bursarSession,
): Promise<{
  lines: Array<Record<string, unknown>>;
  suggestions: Record<string, Array<Record<string, unknown>>>;
}> {
  const response = await request(app)
    .get(`/api/v1/reconciliation/lines${query}`)
    .set('Authorization', bearer(session));

  expect(response.status).toBe(200);
  return response.body.data as {
    lines: Array<Record<string, unknown>>;
    suggestions: Record<string, Array<Record<string, unknown>>>;
  };
}

async function balanceOf(studentId: string): Promise<Record<string, string>> {
  const response = await request(app)
    .get(`/api/v1/students/${studentId}/balance`)
    .set('Authorization', bearer(bursarSession));

  expect(response.status).toBe(200);
  return response.body.data as Record<string, string>;
}

/* ------------------------------------------------------------------ preview */

describe('previewing a statement', () => {
  it('reports the file’s own totals so they can be checked against the paper', async () => {
    const response = await preview(
      statementCsv([
        { narrative: 'TRANSFER PAY-2026-000000001', credit: '50,000.00' },
        { narrative: 'LEDGER FEE', debit: '2,500.00' },
      ]),
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      moneyInCount: 1,
      moneyOutCount: 1,
      totalIn: '50000.00',
      totalOut: '2500.00',
      alreadyImported: false,
    });
  });

  it('writes nothing', async () => {
    await preview(statementCsv([{ narrative: 'FEES', credit: '50000' }]));

    expect(await prisma.bankStatementImport.count()).toBe(0);
    expect(await prisma.bankStatementLine.count()).toBe(0);
  });

  it('reports a bad row against the row number in the file', async () => {
    const response = await preview(
      statementCsv([
        { narrative: 'GOOD', credit: '1000' },
        { date: 'last tuesday', narrative: 'BAD', credit: '1000' },
      ]),
    );

    expect(response.status).toBe(200);
    expect(response.body.data.invalidRows).toBe(1);
    const bad = (response.body.data.lines as Array<Record<string, unknown>>).find(
      (line) => line.lineNumber === 3,
    );
    expect((bad?.errors as string[]).join(' ')).toContain('not a date');
  });

  it('refuses a file with no recognisable columns, and says what is missing', async () => {
    const response = await preview(Buffer.from('Column A,Column B\n1,2\n', 'utf8'));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('missing');
  });

  it('refuses a file that is not a spreadsheet at all', async () => {
    const response = await preview(Buffer.from('%PDF-1.7\n', 'utf8'), bursarSession, 'bank.pdf');

    expect(response.status).toBe(400);
  });
});

/* ------------------------------------------------------------------- import */

describe('importing a statement', () => {
  it('stores the lines and attributes the unambiguous one, crediting nothing', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    const response = await importStatement(
      statementCsv([
        { narrative: `MOBILE TRANSFER ${claim.reference}`, credit: '50000.00' },
        { narrative: 'UNIDENTIFIED DEPOSIT', credit: '17000.00' },
        { narrative: 'MONTHLY LEDGER FEE', debit: '2500.00' },
      ]),
    );

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ automaticallyMatched: 1, ambiguous: 0 });
    expect(response.body.data.statement).toMatchObject({
      lineCount: 3,
      totalIn: '67000.00',
      totalOut: '2500.00',
      matchedCount: 1,
      unmatchedCount: 2,
    });

    // Attributed, not credited. Importing a statement moves no money: the payment is
    // still awaiting verification.
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: claim.id } });
    expect(payment.status).toBe('PENDING');
  });

  it('records who matched an automatic line as nobody, because nobody did', async () => {
    const claim = await recordClaim();
    await importStatement(
      statementCsv([{ narrative: `TRANSFER ${claim.reference}`, credit: claim.amount }]),
    );

    const line = await prisma.bankStatementLine.findFirstOrThrow({
      where: { matchStatus: 'MATCHED' },
    });
    expect(line.matchedByUserId).toBeNull();
    expect(line.matchedAt).not.toBeNull();
  });

  it('does not attribute a quoted reference whose amount disagrees', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    const response = await importStatement(
      statementCsv([{ narrative: `TRANSFER ${claim.reference}`, credit: '45000.00' }]),
    );

    expect(response.body.data.automaticallyMatched).toBe(0);

    // But it is the first suggestion, which is the useful half.
    const worklist = await lines('?matchStatus=UNMATCHED');
    const lineId = worklist.lines[0]?.id as string;
    expect(worklist.suggestions[lineId]?.[0]).toMatchObject({
      reference: claim.reference,
      amountMatches: false,
    });
  });

  it('refuses the same file twice', async () => {
    const file = statementCsv([{ narrative: 'FEES', credit: '50000' }]);

    expect((await importStatement(file)).status).toBe(201);

    const second = await importStatement(file);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
    expect(await prisma.bankStatementImport.count()).toBe(1);
  });

  it('refuses a file with any unreadable row, and stores nothing', async () => {
    const response = await importStatement(
      statementCsv([
        { narrative: 'GOOD', credit: '1000' },
        { date: 'whenever', narrative: 'BAD', credit: '1000' },
      ]),
    );

    expect(response.status).toBe(400);
    expect(await prisma.bankStatementImport.count()).toBe(0);
    expect(await prisma.bankStatementLine.count()).toBe(0);
  });

  it('refuses a bursar without the import permission from importing', async () => {
    const response = await importStatement(statementCsv([{ narrative: 'FEES', credit: '1000' }]), {
      session: dosSession,
    });

    expect(response.status).toBe(403);
  });

  it('lets a Director of Studies neither look nor decide', async () => {
    const listed = await request(app)
      .get('/api/v1/reconciliation/lines')
      .set('Authorization', bearer(dosSession));

    expect(listed.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ matching */

describe('matching a line to a payment', () => {
  async function importedUnmatchedLine(
    amount = '50000.00',
  ): Promise<{ lineId: string; version: number }> {
    await importStatement(
      statementCsv([{ narrative: 'RTGS INWARD FROM JEAN UWASE', credit: amount }]),
    );
    const worklist = await lines('?matchStatus=UNMATCHED');
    return {
      lineId: worklist.lines[0]?.id as string,
      version: worklist.lines[0]?.version as number,
    };
  }

  async function match(
    lineId: string,
    body: Record<string, unknown>,
    session: Session = secondBursarSession,
  ): Promise<request.Response> {
    return request(app)
      .post(`/api/v1/reconciliation/lines/${lineId}/match`)
      .set('Authorization', bearer(session))
      .send(body);
  }

  it('attributes a line without crediting, when confirmation is not asked for', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    const line = await importedUnmatchedLine('50000.00');

    const response = await match(line.lineId, {
      expectedVersion: line.version,
      paymentId: claim.id,
      note: 'Same amount, same day, payer’s name on the line.',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.credited).toBe(false);
    expect(response.body.data.line.matchStatus).toBe('MATCHED');
    expect(response.body.data.line.matchedPaymentReference).toBe(claim.reference);
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('credits the ledger once when the match is confirmed', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    const line = await importedUnmatchedLine('50000.00');

    const response = await match(line.lineId, {
      expectedVersion: line.version,
      paymentId: claim.id,
      confirmPayment: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.credited).toBe(true);
    expect(response.body.data.payment.status).toBe('SUCCESSFUL');

    const balance = await balanceOf(student.id);
    expect(balance.totalPaid).toBe('50000.00');
    expect(balance.outstanding).toBe('70000.00');

    expect(
      await prisma.financialEntry.count({ where: { source: 'PAYMENT', reversalOfEntryId: null } }),
    ).toBe(1);
  });

  it('refuses to match amounts that are not the same money', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    const line = await importedUnmatchedLine('45000.00');

    const response = await match(line.lineId, {
      expectedVersion: line.version,
      paymentId: claim.id,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toMatchObject({
      lineAmount: '45000.00',
      paymentAmount: '50000.00',
    });
    expect(await prisma.bankStatementLine.count({ where: { matchStatus: 'MATCHED' } })).toBe(0);
  });

  it('refuses a payment that another statement line already claims', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    // Two separate statements, each with a line for the same amount.
    await importStatement(statementCsv([{ narrative: 'FIRST DEPOSIT', credit: '50000.00' }]), {
      fileName: 'august.csv',
    });
    await importStatement(statementCsv([{ narrative: 'SECOND DEPOSIT', credit: '50000.00' }]), {
      fileName: 'september.csv',
    });

    const worklist = await lines('?matchStatus=UNMATCHED');
    const first = worklist.lines[0]!;
    const second = worklist.lines[1]!;

    expect(
      (
        await match(first.id as string, {
          expectedVersion: first.version,
          paymentId: claim.id,
        })
      ).status,
    ).toBe(200);

    const conflict = await match(second.id as string, {
      expectedVersion: second.version,
      paymentId: claim.id,
    });

    // Two lines for one payment would mean the money arrived twice.
    expect(conflict.status).toBe(409);
  });

  it('refuses to attribute money leaving the account', async () => {
    const claim = await recordClaim({ amount: '2500.00' });
    await importStatement(statementCsv([{ narrative: 'LEDGER FEE', debit: '2500.00' }]));

    const worklist = await lines('?direction=MONEY_OUT');
    const line = worklist.lines[0]!;

    const response = await match(line.id as string, {
      expectedVersion: line.version,
      paymentId: claim.id,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('refuses a stale version, so two bursars cannot overwrite each other', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    const line = await importedUnmatchedLine('50000.00');

    expect(
      (await match(line.lineId, { expectedVersion: line.version, paymentId: claim.id })).status,
    ).toBe(200);

    const stale = await match(line.lineId, {
      expectedVersion: line.version,
      paymentId: claim.id,
    });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe(ErrorCode.RECORD_MODIFIED);
  });

  it('refuses the bursar who recorded the claim from confirming it', async () => {
    const claim = await recordClaim({ amount: '50000.00', session: bursarSession });
    const line = await importedUnmatchedLine('50000.00');

    const response = await match(
      line.lineId,
      { expectedVersion: line.version, paymentId: claim.id, confirmPayment: true },
      // The same bursar who recorded the claim.
      bursarSession,
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.AUTHORISATION_REQUIRED);
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('refuses a cancelled payment', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    await request(app)
      .post(`/api/v1/payments/${claim.id}/cancel`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: claim.version, reason: 'Recorded in error.' })
      .expect(200);

    const line = await importedUnmatchedLine('50000.00');
    const response = await match(line.lineId, {
      expectedVersion: line.version,
      paymentId: claim.id,
    });

    expect(response.status).toBe(400);
  });
});

/* ----------------------------------------------------- unmatching and ignoring */

describe('changing a decision', () => {
  it('lets an attribution be withdrawn while nothing has been credited', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    await importStatement(
      statementCsv([{ narrative: `TRANSFER ${claim.reference}`, credit: '50000.00' }]),
    );

    const matched = await lines('?matchStatus=MATCHED');
    const line = matched.lines[0]!;

    const response = await request(app)
      .post(`/api/v1/reconciliation/lines/${line.id as string}/unmatch`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: line.version, reason: 'The reference was quoted by mistake.' });

    expect(response.status).toBe(200);
    expect(response.body.data.matchStatus).toBe('UNMATCHED');
    expect(response.body.data.matchedPaymentId).toBeNull();
  });

  it('refuses to detach a line that has already credited a payment', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    await importStatement(
      statementCsv([{ narrative: `TRANSFER ${claim.reference}`, credit: '50000.00' }]),
    );

    const matched = await lines('?matchStatus=MATCHED');
    const line = matched.lines[0]!;

    // Confirm it, which credits the ledger.
    await request(app)
      .post(`/api/v1/reconciliation/lines/${line.id as string}/match`)
      .set('Authorization', bearer(secondBursarSession))
      .send({ expectedVersion: line.version, paymentId: claim.id, confirmPayment: true })
      .expect(200);

    const reloaded = await lines('?matchStatus=MATCHED');
    const response = await request(app)
      .post(`/api/v1/reconciliation/lines/${line.id as string}/unmatch`)
      .set('Authorization', bearer(bursarSession))
      .send({
        expectedVersion: reloaded.lines[0]?.version,
        reason: 'Trying to detach a credited line.',
      });

    // Detaching it would leave the credit with nothing behind it. Reverse the payment
    // instead, which is a decision with its own permission.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('sets a line aside with a reason, and keeps the reason', async () => {
    await importStatement(statementCsv([{ narrative: 'MONTHLY LEDGER FEE', debit: '2500.00' }]));

    const worklist = await lines('?direction=MONEY_OUT');
    const line = worklist.lines[0]!;

    const response = await request(app)
      .post(`/api/v1/reconciliation/lines/${line.id as string}/ignore`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: line.version, reason: 'Bank charge, not a student payment.' });

    expect(response.status).toBe(200);
    expect(response.body.data.matchStatus).toBe('IGNORED');
    expect(response.body.data.matchNote).toContain('Bank charge');
  });

  it('will not set a line aside without a reason', async () => {
    await importStatement(statementCsv([{ narrative: 'LEDGER FEE', debit: '2500.00' }]));
    const worklist = await lines('?direction=MONEY_OUT');
    const line = worklist.lines[0]!;

    const response = await request(app)
      .post(`/api/v1/reconciliation/lines/${line.id as string}/ignore`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: line.version });

    expect(response.status).toBe(400);
  });

  it('refuses to set aside a line that is attributed to a payment', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    await importStatement(
      statementCsv([{ narrative: `TRANSFER ${claim.reference}`, credit: '50000.00' }]),
    );

    const matched = await lines('?matchStatus=MATCHED');
    const line = matched.lines[0]!;

    const response = await request(app)
      .post(`/api/v1/reconciliation/lines/${line.id as string}/ignore`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: line.version, reason: 'Changed my mind about this one.' });

    expect(response.status).toBe(409);
  });
});

/* ------------------------------------------------------------------ summary */

describe('where reconciliation stands', () => {
  it('reports both sides: unexplained money, and claims the bank has not confirmed', async () => {
    const matchedClaim = await recordClaim({ amount: '50000.00' });
    // A second claim that no statement line will account for.
    await recordClaim({ amount: '31000.00' });

    await importStatement(
      statementCsv([
        { narrative: `TRANSFER ${matchedClaim.reference}`, credit: '50000.00' },
        { narrative: 'UNIDENTIFIED DEPOSIT', credit: '17000.00' },
        { narrative: 'LEDGER FEE', debit: '2500.00' },
      ]),
    );

    const response = await request(app)
      .get('/api/v1/reconciliation/summary')
      .set('Authorization', bearer(financeSession));

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      matchedLines: 1,
      matchedTotal: '50000.00',
      // The deposit nobody has attributed: money the school holds and cannot explain.
      unmatchedLines: 1,
      unmatchedTotal: '17000.00',
      // The claim with no statement line behind it.
      unreconciledPayments: 1,
      unreconciledPaymentTotal: '31000.00',
    });
  });

  it('shows a statement with its lines and the candidates for each open one', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    const imported = await importStatement(
      statementCsv([
        { narrative: 'RTGS INWARD FROM JEAN UWASE', credit: '50000.00' },
        { narrative: 'LEDGER FEE', debit: '2500.00' },
      ]),
    );

    const statementId = imported.body.data.statement.id as string;
    const response = await request(app)
      .get(`/api/v1/reconciliation/statements/${statementId}`)
      .set('Authorization', bearer(bursarSession));

    expect(response.status).toBe(200);
    expect(response.body.data.lines).toHaveLength(2);

    const moneyIn = (response.body.data.lines as Array<Record<string, unknown>>).find(
      (line) => line.direction === 'MONEY_IN',
    );
    const suggestions = response.body.data.suggestions as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(suggestions[moneyIn?.id as string]?.[0]).toMatchObject({
      paymentId: claim.id,
      amountMatches: true,
    });

    // Money out is never offered a payment.
    const moneyOut = (response.body.data.lines as Array<Record<string, unknown>>).find(
      (line) => line.direction === 'MONEY_OUT',
    );
    expect(suggestions[moneyOut?.id as string]).toBeUndefined();
  });

  it('refuses a statement from another school as not found', async () => {
    const imported = await importStatement(
      statementCsv([{ narrative: 'FEES', credit: '50000.00' }]),
    );
    const statementId = imported.body.data.statement.id as string;

    const otherSchoolId = await createSchool('GSN', 'GS Nyamirambo');
    const outsiderSession = await signIn(
      app,
      await createTestUser(roleIds, {
        email: 'bursar@gsnyamirambo.invalid',
        roleKeys: [RoleKey.BURSAR],
        schoolId: otherSchoolId,
      }),
    );

    const response = await request(app)
      .get(`/api/v1/reconciliation/statements/${statementId}`)
      .set('Authorization', bearer(outsiderSession));

    expect(response.status).toBe(404);
  });
});
