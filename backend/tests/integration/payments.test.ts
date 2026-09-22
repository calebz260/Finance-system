/**
 * Payments, over real HTTP and against a real database.
 *
 * The cases here are the ones that decide whether a school can trust what this system
 * says about money arriving:
 *
 *  - a payment credits the ledger **once**, however many times a provider delivers the
 *    same confirmation, and however many times a bursar presses Verify;
 *  - a forged or replayed callback credits **nothing**, and is recorded;
 *  - a confirmation that disagrees with the school's own record credits nothing and
 *    becomes somebody's job instead;
 *  - a parent reaches their own children and no one else's, and cannot mark their own
 *    payment as verified;
 *  - undoing a payment posts an opposing entry and deletes nothing.
 *
 * Authorisation is exercised inside the operations rather than in a separate block,
 * because in a payment module "may this person do this?" is part of the operation — and
 * the negative cases are the ones worth having.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ErrorCode,
  RoleKey,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@sfs/shared';

import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { prisma } from '../../src/lib/prisma.js';
import { setContentScanner } from '../../src/modules/payments/content-scanner.js';
import { signSandboxCallback } from '../../src/modules/payments/providers/sandbox.provider.js';
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
let parent: TestUser;
let parentSession: Session;
let otherParentSession: Session;
let student: { id: string; studentId: string };
let otherStudent: { id: string; studentId: string };

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  // Any scanner a previous test installed must not leak into this one.
  setContentScanner(null);

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
    firstName: 'Beata',
    lastName: 'Mukama',
  });
  bursarSession = await signIn(app, bursar);

  // A second bursar, because separation of duties on verification cannot be exercised
  // with only one person who can verify.
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

  student = await registerStudent({ firstName: 'Aline', lastName: 'Uwase' });
  otherStudent = await registerStudent({ firstName: 'Eric', lastName: 'Habimana' });

  parent = await createTestUser(roleIds, {
    email: 'parent@example.invalid',
    roleKeys: [RoleKey.PARENT],
    schoolId,
    firstName: 'Jean',
    lastName: 'Uwase',
  });
  parentSession = await signIn(app, parent);
  await linkGuardian({ user: parent, studentId: student.id });

  const otherParent = await createTestUser(roleIds, {
    email: 'other-parent@example.invalid',
    roleKeys: [RoleKey.PARENT],
    schoolId,
  });
  otherParentSession = await signIn(app, otherParent);
  await linkGuardian({ user: otherParent, studentId: otherStudent.id });
});

afterAll(async () => {
  setContentScanner(null);
  await resetDatabase();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ fixtures */

async function registerStudent(
  overrides: { firstName?: string; lastName?: string } = {},
): Promise<{ id: string; studentId: string }> {
  const response = await request(app)
    .post('/api/v1/students')
    .set('Authorization', bearer(adminSession))
    .send({
      firstName: overrides.firstName ?? 'Aline',
      lastName: overrides.lastName ?? 'Uwase',
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

/**
 * Link a signed-in parent account to a student, with the financial rights the link
 * carries.
 *
 * Written directly rather than through the guardian endpoints: what is being set up is the
 * authorisation input, and going through two more APIs to arrive at the same two rows
 * would make a failure here ambiguous.
 */
async function linkGuardian(args: {
  user: TestUser;
  studentId: string;
  canViewFinancials?: boolean;
  canInitiatePayments?: boolean;
  /** Only one guardian per student may be the primary contact, so extra links say false. */
  isPrimaryContact?: boolean;
}): Promise<void> {
  const guardian = await prisma.guardian.create({
    data: {
      schoolId,
      userId: args.user.id,
      firstName: 'Jean',
      lastName: 'Uwase',
      phone: `+25078${String(Math.floor(Math.random() * 1_000_000)).padStart(7, '0')}`,
    },
  });

  await prisma.studentGuardian.create({
    data: {
      schoolId,
      studentId: args.studentId,
      guardianId: guardian.id,
      relationship: 'FATHER',
      isPrimaryContact: args.isPrimaryContact ?? false,
      isFinanciallyResponsible: true,
      canViewFinancials: args.canViewFinancials ?? true,
      canInitiatePayments: args.canInitiatePayments ?? true,
    },
  });
}

/** Raise a charge so the student has something to pay. */
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
      notes: 'Raised by the payments suite so there is a balance to pay.',
    });

  expect(charge.status).toBe(201);
}

async function balanceOf(studentId: string): Promise<Record<string, string>> {
  const response = await request(app)
    .get(`/api/v1/students/${studentId}/balance`)
    .set('Authorization', bearer(bursarSession));

  expect(response.status).toBe(200);
  return response.body.data as Record<string, string>;
}

/** Record a manual claim as the bursar, returning the created payment. */
async function recordClaim(
  overrides: {
    studentId?: string;
    amount?: string;
    method?: string;
    providerKey?: string | null;
    externalReference?: string;
    session?: Session;
    idempotencyKey?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const agent = request(app)
    .post('/api/v1/payments/manual-claims')
    .set('Authorization', bearer(overrides.session ?? bursarSession));

  if (overrides.idempotencyKey !== undefined) {
    agent.set('Idempotency-Key', overrides.idempotencyKey);
  }

  const response = await agent.send({
    studentId: overrides.studentId ?? student.id,
    amount: overrides.amount ?? '50000.00',
    payerName: 'Jean Uwase',
    method: overrides.method ?? 'BANK_TRANSFER',
    ...(overrides.providerKey === null
      ? {}
      : { providerKey: overrides.providerKey ?? 'BANK_OF_KIGALI' }),
    ...(overrides.externalReference !== undefined
      ? { externalReference: overrides.externalReference }
      : {}),
  });

  expect(response.status).toBe(201);
  return response.body.data as Record<string, unknown>;
}

/** Start a sandbox mobile-money payment as the parent. */
async function initiateSandboxPayment(
  overrides: { amount?: string; studentId?: string; idempotencyKey?: string } = {},
): Promise<{ payment: Record<string, unknown>; status: number; body: Record<string, unknown> }> {
  const agent = request(app).post('/api/v1/payments').set('Authorization', bearer(parentSession));

  if (overrides.idempotencyKey !== undefined) {
    agent.set('Idempotency-Key', overrides.idempotencyKey);
  }

  const response = await agent.send({
    studentId: overrides.studentId ?? student.id,
    amount: overrides.amount ?? '40000.00',
    payerName: 'Jean Uwase',
    payerPhone: '+250788123456',
    method: 'MOBILE_MONEY',
  });

  return {
    status: response.status,
    body: response.body.data as Record<string, unknown>,
    payment: (response.body.data?.payment ?? {}) as Record<string, unknown>,
  };
}

interface CallbackOptions {
  readonly reference: string;
  readonly outcome?: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  readonly amount?: string | null;
  readonly currency?: string | null;
  readonly eventId?: string;
  readonly providerTransactionId?: string;
  /** Seconds to add to "now" when signing. Negative is a callback signed in the past. */
  readonly skewSeconds?: number;
  /** Sign with the wrong secret, as a forger would have to. */
  readonly secret?: string;
}

/**
 * Deliver a sandbox callback, signed the way the adapter verifies it.
 *
 * Signed with the adapter's own helper rather than with a hand-rolled HMAC: a test that
 * built the signed string independently could drift from the verifier, and the case it
 * would stop covering is the one that matters most.
 */
async function deliverCallback(options: CallbackOptions): Promise<request.Response> {
  const body: Record<string, unknown> = {
    eventId: options.eventId ?? `evt-${options.reference}`,
    reference: options.reference,
    providerTransactionId: options.providerTransactionId ?? 'SBX-TEST-TRANSACTION',
    outcome: options.outcome ?? 'SUCCEEDED',
  };
  if (options.amount !== null) body.amount = options.amount ?? '40000.00';
  if (options.currency !== null) body.currency = options.currency ?? 'RWF';

  // Sent as a string rather than as a Buffer, and signed over the same bytes. Superagent
  // treats a Buffer as a plain object and serialises its indices, which would mean the
  // signature covered different bytes than the ones delivered — the exact bug this
  // endpoint exists to catch, so it must not be introduced by the test harness.
  const rawText = JSON.stringify(body);
  const rawBody = Buffer.from(rawText, 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000) + (options.skewSeconds ?? 0));
  const signature = signSandboxCallback({
    secret: options.secret ?? config.payments.sandbox.webhookSecret ?? '',
    timestamp,
    rawBody,
  });

  return request(app)
    .post('/api/v1/payment-webhooks/SANDBOX')
    .set('Content-Type', 'application/json')
    .set(WEBHOOK_SIGNATURE_HEADER, signature)
    .set(WEBHOOK_TIMESTAMP_HEADER, timestamp)
    .send(rawText);
}

/** Verify a claim as a bursar, or as whoever is given. */
async function verify(
  paymentId: string,
  body: Record<string, unknown>,
  session: Session = secondBursarSession,
): Promise<request.Response> {
  return request(app)
    .post(`/api/v1/payments/${paymentId}/verification`)
    .set('Authorization', bearer(session))
    .send(body);
}

async function paymentDetail(paymentId: string, session: Session = bursarSession) {
  const response = await request(app)
    .get(`/api/v1/payments/${paymentId}`)
    .set('Authorization', bearer(session));

  expect(response.status).toBe(200);
  return response.body.data as {
    payment: Record<string, unknown>;
    transactions: Array<Record<string, unknown>>;
    statusHistory: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
    entries: Array<Record<string, unknown>>;
  };
}

/* ------------------------------------------------------------------ channels */

describe('payment methods', () => {
  it('reports what the school can take, and says plainly what it cannot', async () => {
    const response = await request(app)
      .get('/api/v1/payments/methods')
      .set('Authorization', bearer(parentSession));

    expect(response.status).toBe(200);
    const methods = response.body.data as Array<Record<string, unknown>>;

    // The manual channels are always available: they need a bursar, not an integration.
    const bank = methods.find((method) => method.method === 'BANK_TRANSFER');
    expect(bank?.isAvailable).toBe(true);
    expect(bank?.verificationMethod).toBe('MANUAL');
    expect(bank?.requiresEvidence).toBe(true);
    expect(bank?.instructions).toBeTruthy();

    // Mobile money is provider-verified, and available here only because the sandbox
    // simulator is enabled for the test run.
    const mobile = methods.find((method) => method.method === 'MOBILE_MONEY');
    expect(mobile?.verificationMethod).toBe('PROVIDER');
    expect(mobile?.isAvailable).toBe(true);
    expect(mobile?.providerKey).toBe('SANDBOX');
  });

  it('gives a parent their children and what each of them owes', async () => {
    await chargeStudent(student.id, '120000.00');

    const response = await request(app)
      .get('/api/v1/payments/payable-students')
      .set('Authorization', bearer(parentSession));

    expect(response.status).toBe(200);
    const payable = response.body.data as Array<Record<string, unknown>>;

    expect(payable).toHaveLength(1);
    expect(payable[0]?.studentId).toBe(student.id);
    expect(payable[0]?.outstanding).toBe('120000.00');
    expect(payable[0]?.canInitiatePayments).toBe(true);
  });
});

/* ---------------------------------------------------------------- initiation */

describe('starting a provider payment', () => {
  it('creates a pending payment with an attempt, and credits nothing yet', async () => {
    await chargeStudent(student.id, '120000.00');

    const result = await initiateSandboxPayment({ amount: '40000.00' });

    expect(result.status).toBe(201);
    expect(result.payment.status).toBe('PROCESSING');
    expect(result.payment.reference).toMatch(/^PAY-\d{4}-\d{9}$/);
    expect(result.payment.verificationMethod).toBe('PROVIDER');
    expect(result.payment.ledgerEntryId).toBeNull();
    expect(result.body.providerInstruction).toBeTruthy();

    // Nothing has been collected, so the balance has not moved.
    expect((await balanceOf(student.id)).outstanding).toBe('120000.00');
  });

  it('records the provider attempt, and shows it to staff but not to the payer', async () => {
    const result = await initiateSandboxPayment();
    const paymentId = result.payment.id as string;

    const staffView = await paymentDetail(paymentId);
    expect(staffView.transactions).toHaveLength(1);
    expect(staffView.transactions[0]?.internalReference).toBe(result.payment.reference);
    expect(staffView.transactions[0]?.status).toBe('PENDING');

    // A parent sees their payment, not the school's plumbing.
    const parentView = await paymentDetail(paymentId, parentSession);
    expect(parentView.payment.id).toBe(paymentId);
    expect(parentView.transactions).toHaveLength(0);
  });

  it('refuses a payment for a student the caller is not linked to, as not found', async () => {
    const response = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', bearer(parentSession))
      .send({
        studentId: otherStudent.id,
        amount: '10000.00',
        payerName: 'Jean Uwase',
        method: 'MOBILE_MONEY',
      });

    // 404 rather than 403: answering "forbidden" would confirm the id names a real
    // student, which is a way to enumerate the roll.
    expect(response.status).toBe(404);
  });

  it('refuses a guardian whose link does not carry the right to pay', async () => {
    const watcher = await createTestUser(roleIds, {
      email: 'watcher@example.invalid',
      roleKeys: [RoleKey.PARENT],
      schoolId,
    });
    const watcherSession = await signIn(app, watcher);
    await linkGuardian({
      user: watcher,
      studentId: student.id,
      canViewFinancials: true,
      canInitiatePayments: false,
    });

    const response = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', bearer(watcherSession))
      .send({
        studentId: student.id,
        amount: '10000.00',
        payerName: 'A Relative',
        method: 'MOBILE_MONEY',
      });

    expect(response.status).toBe(404);

    // But they can still see the balance, which is the point of two separate flags. Read
    // through `payable-students`, which resolves the guardian link — and not through
    // `/students/:id/balance`, which is a staff endpoint that scopes by school alone.
    const payable = await request(app)
      .get('/api/v1/payments/payable-students')
      .set('Authorization', bearer(watcherSession));

    expect(payable.status).toBe(200);
    const listed = (payable.body.data as Array<Record<string, unknown>>)[0];
    expect(listed?.studentId).toBe(student.id);
    expect(listed?.canViewFinancials).toBe(true);
    expect(listed?.canInitiatePayments).toBe(false);
  });

  it('refuses a currency the school does not accept, rather than converting it', async () => {
    const response = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', bearer(parentSession))
      .send({
        studentId: student.id,
        amount: '100.00',
        currency: 'USD',
        payerName: 'Jean Uwase',
        method: 'MOBILE_MONEY',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('RWF');
  });

  it('refuses an amount below the school minimum, and names the minimum', async () => {
    await prisma.schoolSetting.update({
      where: { schoolId },
      data: { minimumPaymentAmount: '5000.00' },
    });

    const response = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', bearer(parentSession))
      .send({
        studentId: student.id,
        amount: '1000.00',
        payerName: 'Jean Uwase',
        method: 'MOBILE_MONEY',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.AMOUNT_BELOW_MINIMUM);
    expect(response.body.error.details.minimumPaymentAmount).toBe('5000.00');
  });

  it('refuses a part payment at a school that does not take them', async () => {
    await chargeStudent(student.id, '120000.00');
    await prisma.schoolSetting.update({
      where: { schoolId },
      data: { allowPartialPayments: false },
    });

    const refused = await initiateSandboxPayment({ amount: '40000.00' });
    expect(refused.status).toBe(400);

    // The full balance is accepted.
    const accepted = await initiateSandboxPayment({ amount: '120000.00' });
    expect(accepted.status).toBe(201);
  });

  it('refuses to credit a closed period', async () => {
    await prisma.academicYear.update({
      where: { id: academic.academicYearId },
      data: { status: 'CLOSED' },
    });

    const response = await initiateSandboxPayment();

    expect(response.status).toBe(400);
  });
});

/* --------------------------------------------------------------- idempotency */

describe('idempotency', () => {
  it('replays the original payment when the same key repeats the same request', async () => {
    const key = 'e2b9a0c4-1f3d-4c8a-9d5e-000000000001';

    const first = await initiateSandboxPayment({ amount: '40000.00', idempotencyKey: key });
    expect(first.status).toBe(201);

    const second = await initiateSandboxPayment({ amount: '40000.00', idempotencyKey: key });

    // 200, not 201: nothing was created.
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('refuses the same key used for a materially different payment', async () => {
    const key = 'e2b9a0c4-1f3d-4c8a-9d5e-000000000002';

    await initiateSandboxPayment({ amount: '40000.00', idempotencyKey: key });
    const different = await initiateSandboxPayment({ amount: '99000.00', idempotencyKey: key });

    expect(different.status).toBe(409);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('creates one payment when two identical requests arrive together', async () => {
    const key = 'e2b9a0c4-1f3d-4c8a-9d5e-000000000003';

    // The race the key exists for: a parent on a slow connection taps Pay twice. Both
    // requests miss the read, one insert wins on the unique index, and the loser must
    // replay the winner rather than report an error for a payment that was created.
    const [first, second] = await Promise.all([
      initiateSandboxPayment({ amount: '40000.00', idempotencyKey: key }),
      initiateSandboxPayment({ amount: '40000.00', idempotencyKey: key }),
    ]);

    expect([first.status, second.status].every((status) => status === 200 || status === 201)).toBe(
      true,
    );
    expect(first.payment.id).toBe(second.payment.id);
    expect(await prisma.payment.count()).toBe(1);
    // And one attempt, not two: the loser created nothing at all.
    expect(await prisma.paymentTransaction.count()).toBe(1);
  });

  it('rejects an unusable key rather than quietly treating it as absent', async () => {
    const response = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', bearer(parentSession))
      .set('Idempotency-Key', 'short')
      .send({
        studentId: student.id,
        amount: '40000.00',
        payerName: 'Jean Uwase',
        method: 'MOBILE_MONEY',
      });

    expect(response.status).toBe(400);
    expect(await prisma.payment.count()).toBe(0);
  });
});

/* -------------------------------------------------------- provider callbacks */

describe('provider callbacks', () => {
  it('credits the ledger once, and only on a verified callback', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const reference = result.payment.reference as string;

    const callback = await deliverCallback({ reference, amount: '40000.00' });

    expect(callback.status).toBe(200);
    expect(callback.body.data.received).toBe(true);

    const detail = await paymentDetail(result.payment.id as string);
    expect(detail.payment.status).toBe('SUCCESSFUL');
    expect(detail.payment.ledgerEntryId).toBeTruthy();
    expect(detail.entries).toHaveLength(1);
    expect(detail.entries[0]?.entryType).toBe('CREDIT');
    expect(detail.entries[0]?.amount).toBe('40000.00');

    const balance = await balanceOf(student.id);
    expect(balance.totalPaid).toBe('40000.00');
    expect(balance.outstanding).toBe('80000.00');
  });

  it('ignores a re-delivered callback instead of crediting twice', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const reference = result.payment.reference as string;

    // The same event id, delivered three times, as a retrying provider would.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const callback = await deliverCallback({ reference, eventId: 'evt-duplicate' });
      expect(callback.status).toBe(200);
    }

    const entries = await prisma.financialEntry.count({
      where: { source: 'PAYMENT', reversalOfEntryId: null },
    });
    expect(entries).toBe(1);
    expect((await balanceOf(student.id)).totalPaid).toBe('40000.00');

    // One event row, because the second and third lost the unique insert.
    expect(await prisma.paymentWebhookEvent.count({ where: { eventId: 'evt-duplicate' } })).toBe(1);
  });

  it('credits once even when two distinct callbacks both report success', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const reference = result.payment.reference as string;

    await deliverCallback({ reference, eventId: 'evt-one' });
    const second = await deliverCallback({ reference, eventId: 'evt-two' });

    // Accepted, recorded, and answered from the existing credit.
    expect(second.status).toBe(200);
    expect(
      await prisma.financialEntry.count({ where: { source: 'PAYMENT', reversalOfEntryId: null } }),
    ).toBe(1);
    expect((await balanceOf(student.id)).totalPaid).toBe('40000.00');
  });

  it('refuses a forged signature, credits nothing, and records the attempt', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });

    const callback = await deliverCallback({
      reference: result.payment.reference as string,
      secret: 'not-the-shared-secret-but-long-enough-to-sign',
    });

    expect(callback.status).toBe(401);
    expect(callback.body.error.code).toBe(ErrorCode.WEBHOOK_SIGNATURE_INVALID);
    // The refusal says nothing about which check failed.
    expect(JSON.stringify(callback.body)).not.toContain('signature did not match');

    const events = await prisma.paymentWebhookEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]?.verification).toBe('SIGNATURE_INVALID');
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('refuses a correctly signed callback that is stale, as a replay', async () => {
    const result = await initiateSandboxPayment({ amount: '40000.00' });

    // Signed well outside the configured window, which is what a captured callback
    // re-sent later looks like.
    const callback = await deliverCallback({
      reference: result.payment.reference as string,
      skewSeconds: -(config.payments.webhookMaxSkewSeconds + 120),
    });

    expect(callback.status).toBe(401);
    const events = await prisma.paymentWebhookEvent.findMany();
    expect(events[0]?.verification).toBe('REPLAYED');
  });

  it('holds a payment whose confirmed amount does not match, and credits nothing', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });

    const callback = await deliverCallback({
      reference: result.payment.reference as string,
      amount: '39000.00',
    });

    expect(callback.status).toBe(200);

    const detail = await paymentDetail(result.payment.id as string);
    expect(detail.payment.status).toBe('REQUIRES_REVIEW');
    expect(detail.entries).toHaveLength(0);
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');

    // Both figures are on the record, because the difference is the whole point.
    const history = detail.statusHistory.at(-1);
    expect(history?.toStatus).toBe('REQUIRES_REVIEW');
  });

  it('holds a success that states no amount rather than assuming the requested one', async () => {
    const result = await initiateSandboxPayment({ amount: '40000.00' });

    const callback = await deliverCallback({
      reference: result.payment.reference as string,
      amount: null,
      currency: null,
    });

    expect(callback.status).toBe(200);
    const detail = await paymentDetail(result.payment.id as string);
    expect(detail.payment.status).toBe('REQUIRES_REVIEW');
    expect(detail.entries).toHaveLength(0);
  });

  it('fails a payment the provider declined, with a reason the payer can read', async () => {
    const result = await initiateSandboxPayment({ amount: '40000.00' });

    const callback = await deliverCallback({
      reference: result.payment.reference as string,
      outcome: 'FAILED',
    });

    expect(callback.status).toBe(200);
    const detail = await paymentDetail(result.payment.id as string);
    expect(detail.payment.status).toBe('FAILED');
    expect(detail.payment.failureReason).toBeTruthy();
  });

  it('cannot resurrect a failed payment with a later success', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const reference = result.payment.reference as string;

    await deliverCallback({ reference, outcome: 'FAILED', eventId: 'evt-fail' });
    const late = await deliverCallback({ reference, outcome: 'SUCCEEDED', eventId: 'evt-late' });

    // Accepted and recorded, but the status machine refuses to apply it.
    expect(late.status).toBe(200);
    const detail = await paymentDetail(result.payment.id as string);
    expect(detail.payment.status).toBe('FAILED');
    expect(detail.entries).toHaveLength(0);
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('acknowledges an unknown outcome for a payment that can no longer move', async () => {
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const reference = result.payment.reference as string;

    await deliverCallback({ reference, outcome: 'FAILED', eventId: 'evt-fail' });

    // The provider now says it does not know. The payment is terminal, so there is nothing
    // to park — but the callback must still be *acknowledged*: a 409 here reads to a
    // provider as "try again", forever, for a payment that can never change.
    const late = await deliverCallback({ reference, outcome: 'UNKNOWN', eventId: 'evt-unknown' });

    expect(late.status).toBe(200);
    const detail = await paymentDetail(result.payment.id as string);
    expect(detail.payment.status).toBe('FAILED');
    expect(detail.entries).toHaveLength(0);
  });

  it('records a signed callback naming a reference the school does not have', async () => {
    const callback = await deliverCallback({ reference: 'PAY-2026-000999999' });

    expect(callback.status).toBe(200);
    const events = await prisma.paymentWebhookEvent.findMany();
    expect(events[0]?.verification).toBe('UNKNOWN_REFERENCE');
    expect(events[0]?.paymentId).toBeNull();
  });

  it('has no callback endpoint for a provider that is not registered', async () => {
    const response = await request(app)
      .post('/api/v1/payment-webhooks/BANK_OF_KIGALI')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------- manual verification */

describe('the manual verification workflow', () => {
  it('records a claim that credits nothing until a bursar confirms it', async () => {
    await chargeStudent(student.id, '120000.00');

    const claim = await recordClaim({ amount: '50000.00', externalReference: 'BK-99881' });

    expect(claim.status).toBe('PENDING');
    expect(claim.verificationMethod).toBe('MANUAL');
    expect(claim.ledgerEntryId).toBeNull();
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('credits the ledger when the statement figure matches the claim', async () => {
    await chargeStudent(student.id, '120000.00');
    const claim = await recordClaim({ amount: '50000.00' });

    const verified = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: '50000.00',
      externalReference: 'BK-99881',
      note: 'Matched against the Bank of Kigali statement of 21 September.',
    });

    expect(verified.status).toBe(200);
    expect(verified.body.data.outcome).toBe('CREDITED');
    expect(verified.body.data.ledgerEntryId).toBeTruthy();
    expect(verified.body.data.payment.verifiedByName).toBeTruthy();

    const balance = await balanceOf(student.id);
    expect(balance.totalPaid).toBe('50000.00');
    expect(balance.outstanding).toBe('70000.00');
  });

  it('holds the payment when the statement figure disagrees, crediting neither number', async () => {
    await chargeStudent(student.id, '120000.00');
    const claim = await recordClaim({ amount: '50000.00' });

    const verified = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: '45000.00',
    });

    expect(verified.status).toBe(200);
    expect(verified.body.data.outcome).toBe('HELD_FOR_REVIEW');
    expect(verified.body.data.payment.status).toBe('REQUIRES_REVIEW');
    expect(verified.body.data.ledgerEntryId).toBeNull();
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('does not credit twice when Verify is pressed again', async () => {
    await chargeStudent(student.id, '120000.00');
    const claim = await recordClaim({ amount: '50000.00' });

    const first = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: '50000.00',
    });
    expect(first.body.data.outcome).toBe('CREDITED');

    // A second press with the version the screen still holds.
    const second = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: '50000.00',
    });

    // Refused as stale rather than applied, and either way nothing is credited twice.
    expect(second.status).toBe(409);
    expect(
      await prisma.financialEntry.count({ where: { source: 'PAYMENT', reversalOfEntryId: null } }),
    ).toBe(1);
    expect((await balanceOf(student.id)).totalPaid).toBe('50000.00');
  });

  it('refuses the bursar who recorded the claim, and audits the attempt', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    const response = await verify(
      claim.id as string,
      { expectedVersion: claim.version, decision: 'CONFIRM', confirmedAmount: '50000.00' },
      // The same bursar who recorded it.
      bursarSession,
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.AUTHORISATION_REQUIRED);

    const audited = await prisma.auditLog.count({
      where: { action: 'payment.manual_claim.self_verification_blocked' },
    });
    expect(audited).toBe(1);
  });

  it('lets the same bursar verify when the school has turned separation of duties off', async () => {
    await chargeStudent(student.id, '120000.00');
    await prisma.schoolSetting.update({
      where: { schoolId },
      data: { enforceVerificationSeparationOfDuties: false },
    });

    const claim = await recordClaim({ amount: '50000.00' });
    const response = await verify(
      claim.id as string,
      { expectedVersion: claim.version, decision: 'CONFIRM', confirmedAmount: '50000.00' },
      bursarSession,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('CREDITED');
  });

  it('rejects a claim with a reason that is kept', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    const response = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'REJECT',
      reason: 'No deposit of this amount appears on the statement for that week.',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('FAILED');
    expect(response.body.data.payment.status).toBe('FAILED');
    expect(response.body.data.payment.failureReason).toContain('No deposit');
  });

  it('holds a claim for somebody more senior, and the payment leaves the queue', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    const response = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'HOLD',
      reason: 'The slip is unreadable; the payer has been asked for a clearer photograph.',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.payment.status).toBe('REQUIRES_REVIEW');

    const pending = await request(app)
      .get('/api/v1/payments?verificationMethod=MANUAL&status=PENDING')
      .set('Authorization', bearer(bursarSession));
    expect(pending.body.data).toHaveLength(0);
  });

  it('refuses a parent trying to verify their own payment', async () => {
    const claim = await recordClaim({ amount: '50000.00', session: bursarSession });

    const response = await verify(
      claim.id as string,
      { expectedVersion: claim.version, decision: 'CONFIRM', confirmedAmount: '50000.00' },
      parentSession,
    );

    expect(response.status).toBe(403);
  });

  it('refuses a claim on a bank channel that does not say which bank', async () => {
    const response = await request(app)
      .post('/api/v1/payments/manual-claims')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        amount: '50000.00',
        payerName: 'Jean Uwase',
        method: 'BANK_TRANSFER',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('which bank');
  });

  it('refuses a provider on cash, which nobody transmits', async () => {
    const response = await request(app)
      .post('/api/v1/payments/manual-claims')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        amount: '50000.00',
        payerName: 'Jean Uwase',
        method: 'CASH',
        providerKey: 'BANK_OF_KIGALI',
      });

    expect(response.status).toBe(400);
  });

  it('refuses a claim on a channel that is collected online', async () => {
    const response = await request(app)
      .post('/api/v1/payments/manual-claims')
      .set('Authorization', bearer(bursarSession))
      .send({
        studentId: student.id,
        amount: '50000.00',
        payerName: 'Jean Uwase',
        method: 'MOBILE_MONEY',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('lets a bursar resolve a provider payment that was parked for review', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    await deliverCallback({ reference: result.payment.reference as string, amount: '39000.00' });

    const parked = await paymentDetail(result.payment.id as string);
    expect(parked.payment.status).toBe('REQUIRES_REVIEW');

    // The bank confirmed the full amount after all: a person closes it out.
    const resolved = await verify(result.payment.id as string, {
      expectedVersion: parked.payment.version,
      decision: 'CONFIRM',
      confirmedAmount: '40000.00',
      note: 'The provider under-reported; the settlement file shows the full amount.',
    });

    expect(resolved.status).toBe(200);
    expect(resolved.body.data.outcome).toBe('CREDITED');
    expect((await balanceOf(student.id)).totalPaid).toBe('40000.00');
  });

  it('lets a bursar park a provider payment whose provider has gone quiet', async () => {
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const detail = await paymentDetail(result.payment.id as string);

    // No callback is coming. Without this the payment would sit in flight forever and the
    // payer would be told it is "being processed" indefinitely.
    const held = await verify(result.payment.id as string, {
      expectedVersion: detail.payment.version,
      decision: 'HOLD',
      reason: 'The provider accepted the request three days ago and has never confirmed it.',
    });

    expect(held.status).toBe(200);
    expect(held.body.data.payment.status).toBe('REQUIRES_REVIEW');

    // And from there it can be resolved — two deliberate steps, not one.
    const parked = await paymentDetail(result.payment.id as string);
    const failed = await verify(result.payment.id as string, {
      expectedVersion: parked.payment.version,
      decision: 'REJECT',
      reason: 'The bank confirms nothing ever arrived.',
    });

    expect(failed.status).toBe(200);
    expect(failed.body.data.payment.status).toBe('FAILED');
  });

  it('refuses to hand-verify a provider payment that is simply in flight', async () => {
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    const detail = await paymentDetail(result.payment.id as string);

    const response = await verify(result.payment.id as string, {
      expectedVersion: detail.payment.version,
      decision: 'CONFIRM',
      confirmedAmount: '40000.00',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });
});

/* ------------------------------------------------------------ cancellation */

describe('cancellation', () => {
  it('lets the payer withdraw a pending claim', async () => {
    const claim = await recordClaim({ session: parentSession, providerKey: 'BANK_OF_KIGALI' });

    const response = await request(app)
      .post(`/api/v1/payments/${claim.id as string}/cancel`)
      .set('Authorization', bearer(parentSession))
      .send({ expectedVersion: claim.version, reason: 'Paid at the office instead.' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CANCELLED');
  });

  it('refuses to cancel a payment the provider already has', async () => {
    const result = await initiateSandboxPayment();
    const detail = await paymentDetail(result.payment.id as string);

    const response = await request(app)
      .post(`/api/v1/payments/${result.payment.id as string}/cancel`)
      .set('Authorization', bearer(parentSession))
      .send({ expectedVersion: detail.payment.version, reason: 'Changed my mind.' });

    expect(response.status).toBe(409);
  });

  it('refuses one family the cancellation of another family’s payment', async () => {
    const claim = await recordClaim({ session: parentSession, providerKey: 'BANK_OF_KIGALI' });

    const response = await request(app)
      .post(`/api/v1/payments/${claim.id as string}/cancel`)
      .set('Authorization', bearer(otherParentSession))
      .send({ expectedVersion: claim.version, reason: 'Not mine, but trying anyway.' });

    // 404, not 403: confirming the payment exists would itself be a disclosure.
    expect(response.status).toBe(404);
    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: claim.id as string } });
    expect(unchanged.status).toBe('PENDING');
  });

  it('refuses to cancel a credited payment', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: '50000.00',
    });

    const detail = await paymentDetail(claim.id as string);
    const response = await request(app)
      .post(`/api/v1/payments/${claim.id as string}/cancel`)
      .set('Authorization', bearer(bursarSession))
      .send({ expectedVersion: detail.payment.version, reason: 'Recorded in error.' });

    expect(response.status).toBe(409);
  });
});

/* ------------------------------------------------------ reversal and refund */

describe('undoing a credited payment', () => {
  async function creditedPayment(amount = '50000.00'): Promise<{ id: string; version: number }> {
    await chargeStudent(student.id, '120000.00');
    const claim = await recordClaim({ amount });
    const verified = await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: amount,
    });
    expect(verified.status).toBe(200);

    return {
      id: claim.id as string,
      version: verified.body.data.payment.version as number,
    };
  }

  it('posts an opposing entry and keeps the original', async () => {
    const payment = await creditedPayment();

    const response = await request(app)
      .post(`/api/v1/payments/${payment.id}/reversal`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: payment.version,
        kind: 'REVERSAL',
        reason: 'The bank reversed the transfer; the money never arrived.',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('REVERSED');
    expect(response.body.data.compensatingEntryPosted).toBe(true);

    const detail = await paymentDetail(payment.id);
    // Two entries: the credit, and the debit that undoes it. Nothing was deleted.
    expect(detail.entries).toHaveLength(2);
    expect(detail.entries[0]?.entryType).toBe('CREDIT');
    expect(detail.entries[1]?.entryType).toBe('DEBIT');
    expect(detail.entries[1]?.reversalOfEntryId).toBe(detail.entries[0]?.id);

    const balance = await balanceOf(student.id);
    expect(balance.totalPaid).toBe('0.00');
    expect(balance.outstanding).toBe('120000.00');
  });

  it('records a refund as a refund, not as a reversal', async () => {
    const payment = await creditedPayment();

    const response = await request(app)
      .post(`/api/v1/payments/${payment.id}/reversal`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: payment.version,
        kind: 'REFUND',
        reason: 'Overpayment returned to the payer at their request.',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('REFUNDED');
    expect((await balanceOf(student.id)).totalPaid).toBe('0.00');
  });

  it('refuses a bursar, who collects but does not unmake a collection', async () => {
    const payment = await creditedPayment();

    const response = await request(app)
      .post(`/api/v1/payments/${payment.id}/reversal`)
      .set('Authorization', bearer(bursarSession))
      .send({
        expectedVersion: payment.version,
        kind: 'REVERSAL',
        reason: 'Recorded against the wrong student.',
      });

    expect(response.status).toBe(403);
    expect((await balanceOf(student.id)).totalPaid).toBe('50000.00');
  });

  it('refuses to reverse a payment that was never credited', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

    const response = await request(app)
      .post(`/api/v1/payments/${claim.id as string}/reversal`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: claim.version,
        kind: 'REVERSAL',
        reason: 'Nothing to reverse, but trying anyway.',
      });

    expect(response.status).toBe(409);
  });

  it('cannot be reversed twice', async () => {
    const payment = await creditedPayment();

    const first = await request(app)
      .post(`/api/v1/payments/${payment.id}/reversal`)
      .set('Authorization', bearer(financeSession))
      .send({ expectedVersion: payment.version, kind: 'REVERSAL', reason: 'Bank reversed it.' });
    expect(first.status).toBe(200);

    const detail = await paymentDetail(payment.id);
    const second = await request(app)
      .post(`/api/v1/payments/${payment.id}/reversal`)
      .set('Authorization', bearer(financeSession))
      .send({
        expectedVersion: detail.payment.version,
        kind: 'REVERSAL',
        reason: 'Trying again.',
      });

    expect(second.status).toBe(409);
    expect(detail.entries).toHaveLength(2);
  });
});

/* -------------------------------------------------------- proof of payment */

describe('proof of payment', () => {
  const SLIP = Buffer.from('%PDF-1.7\nBank of Kigali deposit slip\n');

  /**
   * Collect a binary response body, which superagent will not parse on its own.
   *
   * The argument is typed as a response by `@types/superagent` but is the raw
   * `IncomingMessage` at this point in the pipeline, which is why it is read as a stream.
   */
  function binaryParser(
    res: request.Response,
    callback: (error: Error | null, body: Buffer) => void,
  ): void {
    const stream = res as unknown as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => {
      callback(null, Buffer.concat(chunks));
    });
  }

  async function upload(
    paymentId: string,
    options: { session?: Session; bytes?: Buffer; kind?: string; fileName?: string } = {},
  ): Promise<request.Response> {
    return request(app)
      .post(`/api/v1/payments/${paymentId}/evidence`)
      .set('Authorization', bearer(options.session ?? parentSession))
      .field('kind', options.kind ?? 'BANK_SLIP')
      .attach('file', options.bytes ?? SLIP, options.fileName ?? 'slip.pdf');
  }

  it('attaches a slip to a claim and reads the bytes back unchanged', async () => {
    const claim = await recordClaim({ session: parentSession });

    const uploaded = await upload(claim.id as string);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.contentType).toBe('application/pdf');
    expect(uploaded.body.data.isCurrent).toBe(true);
    // No URL: the file is only reachable through the authenticated endpoint.
    expect(uploaded.body.data.storageKey).toBeUndefined();

    const download = await request(app)
      .get(
        `/api/v1/payments/${claim.id as string}/evidence/${uploaded.body.data.id as string}/file`,
      )
      .set('Authorization', bearer(bursarSession))
      // Superagent has no parser for a PDF, so the bytes are collected by hand. Comparing
      // them is the point: a storage layer that quietly re-encoded a bank slip would still
      // pass every other assertion in this file.
      .buffer(true)
      .parse(binaryParser);

    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.body).toEqual(SLIP);
  });

  it('supersedes the previous document of the same kind rather than overwriting it', async () => {
    const claim = await recordClaim({ session: parentSession });

    const first = await upload(claim.id as string);
    const second = await upload(claim.id as string, {
      bytes: Buffer.from('%PDF-1.7\nA clearer photograph\n'),
      fileName: 'slip-2.pdf',
    });

    expect(second.status).toBe(201);

    const listed = await request(app)
      .get(`/api/v1/payments/${claim.id as string}/evidence`)
      .set('Authorization', bearer(bursarSession));

    const evidence = listed.body.data as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(2);
    expect(evidence.find((row) => row.id === first.body.data.id)?.isCurrent).toBe(false);
    expect(evidence.find((row) => row.id === second.body.data.id)?.isCurrent).toBe(true);
  });

  it('judges the file by its bytes, not by what the upload called it', async () => {
    const claim = await recordClaim({ session: parentSession });

    const response = await upload(claim.id as string, {
      bytes: Buffer.from('<html><script>alert(1)</script></html>'),
      fileName: 'slip.pdf',
    });

    expect(response.status).toBe(415);
  });

  it('never stores a file a scanner reports as infected', async () => {
    setContentScanner({ scan: () => Promise.resolve('INFECTED') });
    const claim = await recordClaim({ session: parentSession });

    const response = await upload(claim.id as string);

    expect(response.status).toBe(415);
    expect(await prisma.paymentEvidence.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'payment.evidence.rejected' } })).toBe(1);
  });

  it('records that an unscanned file was not scanned', async () => {
    const claim = await recordClaim({ session: parentSession });
    const uploaded = await upload(claim.id as string);

    const row = await prisma.paymentEvidence.findUniqueOrThrow({
      where: { id: uploaded.body.data.id as string },
    });
    // SKIPPED, honestly, rather than CLEAN by default.
    expect(row.scanState).toBe('SKIPPED');
  });

  it('refuses to attach a document to a payment that has been decided', async () => {
    const claim = await recordClaim({ amount: '50000.00' });
    await verify(claim.id as string, {
      expectedVersion: claim.version,
      decision: 'CONFIRM',
      confirmedAmount: '50000.00',
    });

    const response = await upload(claim.id as string, { session: bursarSession });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.PRECONDITION_FAILED);
  });

  it('refuses another family the document, and audits every download', async () => {
    const claim = await recordClaim({ session: parentSession });
    const uploaded = await upload(claim.id as string);
    const path = `/api/v1/payments/${claim.id as string}/evidence/${uploaded.body.data.id as string}/file`;

    const refused = await request(app).get(path).set('Authorization', bearer(otherParentSession));
    expect(refused.status).toBe(404);

    const allowed = await request(app).get(path).set('Authorization', bearer(parentSession));
    expect(allowed.status).toBe(200);

    expect(await prisma.auditLog.count({ where: { action: 'payment.evidence.downloaded' } })).toBe(
      1,
    );
  });
});

/* ---------------------------------------------------------------- the lists */

describe('reading payments', () => {
  it('gives a bursar the school’s payments and a parent only their own', async () => {
    await recordClaim({ studentId: student.id, amount: '50000.00' });
    await recordClaim({ studentId: otherStudent.id, amount: '60000.00' });

    const staffList = await request(app)
      .get('/api/v1/payments')
      .set('Authorization', bearer(bursarSession));
    expect(staffList.status).toBe(200);
    expect(staffList.body.data).toHaveLength(2);
    expect(staffList.body.meta.totalItems).toBe(2);

    const parentList = await request(app)
      .get('/api/v1/payments')
      .set('Authorization', bearer(parentSession));
    expect(parentList.status).toBe(200);
    expect(parentList.body.data).toHaveLength(1);
    expect(parentList.body.data[0].studentId).toBe(student.id);
  });

  it('gives a parent nothing when they ask for another family’s student', async () => {
    await recordClaim({ studentId: otherStudent.id, amount: '60000.00' });

    const response = await request(app)
      .get(`/api/v1/payments?studentId=${otherStudent.id}`)
      .set('Authorization', bearer(parentSession));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('filters the bursar’s verification queue', async () => {
    await recordClaim({ amount: '50000.00' });
    const credited = await recordClaim({ amount: '20000.00' });
    await verify(credited.id as string, {
      expectedVersion: credited.version,
      decision: 'CONFIRM',
      confirmedAmount: '20000.00',
    });

    const queue = await request(app)
      .get('/api/v1/payments?verificationMethod=MANUAL&status=PENDING')
      .set('Authorization', bearer(bursarSession));

    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0].amount).toBe('50000.00');
  });

  it('searches by reference, payer and bank reference', async () => {
    const claim = await recordClaim({ amount: '50000.00', externalReference: 'BK-778899' });

    const byReference = await request(app)
      .get(`/api/v1/payments?search=${claim.reference as string}`)
      .set('Authorization', bearer(bursarSession));
    expect(byReference.body.data).toHaveLength(1);

    const byBankReference = await request(app)
      .get('/api/v1/payments?search=778899')
      .set('Authorization', bearer(bursarSession));
    expect(byBankReference.body.data).toHaveLength(1);
  });

  it('gives a student account nothing, because nothing links it to a student record', async () => {
    await recordClaim({ studentId: student.id, amount: '50000.00' });

    const studentSession = await signIn(
      app,
      await createTestUser(roleIds, {
        email: 'learner@gskicukiro.invalid',
        roleKeys: [RoleKey.STUDENT],
        schoolId,
      }),
    );

    // The STUDENT role holds `own.financials_read`, but no column joins a User to the
    // Student they are, and guessing one inside the module that guards financial data is
    // exactly what this project does not do. Self-service resolves through the guardian
    // link only, so the role fails closed (docs/OPEN-QUESTIONS.md #10).
    const list = await request(app)
      .get('/api/v1/payments')
      .set('Authorization', bearer(studentSession));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);

    const detail = await request(app)
      .get(`/api/v1/payments?studentId=${student.id}`)
      .set('Authorization', bearer(studentSession));
    expect(detail.body.data).toHaveLength(0);
  });

  it('keeps a family out of the school’s own reconciliation entirely', async () => {
    // A parent holds `payment.record_manual_claim`, which is a staff permission by name.
    // That must not become a way into anything the school does with its bank account.
    for (const path of [
      '/api/v1/reconciliation/lines',
      '/api/v1/reconciliation/summary',
      '/api/v1/reconciliation/statements',
    ]) {
      const response = await request(app).get(path).set('Authorization', bearer(parentSession));
      expect(response.status).toBe(403);
    }
  });

  it('refuses a payment id from another school as not found', async () => {
    const claim = await recordClaim({ amount: '50000.00' });

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
      .get(`/api/v1/payments/${claim.id as string}`)
      .set('Authorization', bearer(outsiderSession));

    expect(response.status).toBe(404);
  });

  it('keeps the whole status history, so how a payment got here is answerable', async () => {
    await chargeStudent(student.id, '120000.00');
    const result = await initiateSandboxPayment({ amount: '40000.00' });
    await deliverCallback({ reference: result.payment.reference as string, amount: '39000.00' });

    const parked = await paymentDetail(result.payment.id as string);
    await verify(result.payment.id as string, {
      expectedVersion: parked.payment.version,
      decision: 'CONFIRM',
      confirmedAmount: '40000.00',
      note: 'Settlement file shows the full amount.',
    });

    const detail = await paymentDetail(result.payment.id as string);
    const statuses = detail.statusHistory.map((row) => row.toStatus);

    // Created, accepted by the provider, parked, then credited — all four still readable.
    expect(statuses).toEqual(['PENDING', 'PROCESSING', 'REQUIRES_REVIEW', 'SUCCESSFUL']);
    expect(detail.statusHistory.at(-1)?.source).toBe('USER');
    expect(detail.statusHistory[2]?.source).toBe('PROVIDER_WEBHOOK');
  });
});
