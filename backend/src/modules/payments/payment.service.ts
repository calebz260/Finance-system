/**
 * Payment initiation, manual claims, cancellation and the payment reads.
 *
 * The verification that credits the ledger is not here — it is in `payment.finalize.ts`,
 * reached from `verification.service.ts` when a bursar confirms and from
 * `webhook.service.ts` when a provider does. This file is everything that happens
 * *before* money is believed to have arrived, and its whole job is to create a record
 * that is honest about what is known: a PENDING payment is a statement of intent, and it
 * moves nothing.
 *
 * ## What is decided here, and why not in the schema
 *
 * The request schema validates shape. These are the questions only the database can
 * answer, so they are answered here, on every path, against the school's own records:
 *
 *  - **May this caller pay for this student?** Resolved through `payment.access.ts` from
 *    the guardian link — never from the student id in the URL (Section 26).
 *  - **Is the currency the one the school accepts?** A mismatch is refused, never
 *    converted. Converting would mean inventing an exchange rate inside a fee system
 *    (Section 21).
 *  - **Does the amount clear the school's minimum, and does the school take part
 *    payments?** Both are settings, both are read per payment, and a refusal names the
 *    figure the payer needs in order to fix the request.
 *  - **Is the period open?** A payment credits a period's ledger, and a period that has
 *    been signed off does not silently acquire new credits (Section 8).
 *
 * ## Idempotency
 *
 * `Idempotency-Key` makes initiation safe to retry, which matters most exactly when it is
 * least convenient: a parent on a dropped connection tapping Pay again. The key is stored
 * on the payment together with a **fingerprint of the request it was first used for**, so
 * a genuine retry replays the original payment, while the same key sent with a different
 * student or amount is refused rather than answered with somebody else's payment
 * (Section 14).
 *
 * The unique index on `(school_id, idempotency_key)` is what makes that safe under
 * concurrency. The read below is the fast path, not the guarantee: two simultaneous
 * retries end with one insert and one loser, and the loser replays.
 *
 * ## The provider call happens outside the transaction
 *
 * A network call inside a database transaction holds a row lock open for as long as the
 * provider takes to answer, which on a bad day is thirty seconds per payment. So the
 * payment and its attempt row are committed first and the provider is called after. The
 * consequence is deliberate: a crash between the two leaves a PENDING payment with an
 * INITIATED attempt and nothing collected — which is the truth, and is recoverable —
 * rather than a payment that was collected and never recorded.
 */
import { createHash } from 'node:crypto';

import {
  type CurrencyCode,
  ErrorCode,
  type FinancialEntrySummary,
  type GuardianRelation,
  Money,
  type PayableStudent,
  type PaymentDetail,
  type PaymentInitiationResult,
  type PaymentMethodOption,
  type PaymentProviderKeyValue,
  type PaymentSummary,
  type PaymentTransactionSummary,
  PermissionKey,
} from '@sfs/shared';

import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../lib/errors.js';
import type { PaymentStatus } from '../../generated/prisma/enums.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { allocatePaymentReference } from '../../lib/identifier-sequence.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { academicRepository } from '../academic/academic.repository.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { getStudentBalance } from '../fees/balance.service.js';
import { ensureAccount } from '../fees/ledger.service.js';
import {
  isStaffReader,
  resolveStudentFinancialAccess,
  resolveVisibleStudentIds,
  type StudentFinancialAccess,
} from './payment.access.js';
import { failPayment } from './payment.finalize.js';
import { toPaymentDetail, toPaymentSummary, toTransactionSummary } from './payment.presenter.js';
import { isUniqueViolation, paymentRepository, type PaymentRecord } from './payment.repository.js';
import type {
  CancelPaymentBody,
  InitiatePaymentBody,
  ListPaymentsQuery,
  RecordManualClaimBody,
} from './payment.schema.js';
import { assertTransition } from './payment.status.js';
import type {
  PaymentProviderAdapter,
  ProviderInitiationResult,
} from './providers/provider.port.js';
import {
  channelFor,
  listPaymentMethodOptions,
  providerIsValidForChannel,
  resolveInitiationProvider,
} from './providers/provider.registry.js';

const log = createLogger('payments.service');

/** The fields initiation and a manual claim share. */
interface PaymentRequestBase {
  readonly studentId: string;
  readonly amount: string;
  readonly currency?: string | undefined;
  readonly payerName: string;
  readonly payerPhone?: string | undefined;
  readonly payerEmail?: string | undefined;
  readonly academicYearId?: string | undefined;
  readonly termId?: string | null | undefined;
  readonly notes?: string | undefined;
  readonly method: InitiatePaymentBody['method'];
  readonly providerKey?: PaymentProviderKeyValue | undefined;
}

/**
 * Everything resolved from the database before a payment row is written.
 *
 * Assembled once and passed down, so initiation and a manual claim cannot end up
 * applying different rules to the same money.
 */
interface PaymentContext {
  readonly access: StudentFinancialAccess;
  readonly schoolId: string;
  readonly currency: CurrencyCode;
  readonly amount: Money;
  readonly academicYearId: string;
  readonly termId: string | null;
}

/* ------------------------------------------------------------------- reads */

/** The channels the school offers, and which of them can collect today. */
export function listPaymentMethods(): readonly PaymentMethodOption[] {
  return listPaymentMethodOptions();
}

/**
 * The students a signed-in guardian may pay for, with what each of them owes.
 *
 * The outstanding figure comes from the ledger through `getStudentBalance` rather than
 * from a cached column, so the amount a parent is offered to pay is the amount the system
 * believes is owed at the moment they are looking at it (ADR-022).
 */
export async function listPayableStudents(
  principal: Principal,
): Promise<readonly PayableStudent[]> {
  if (!principal.permissions.has(PermissionKey.OWN_FINANCIALS_READ)) {
    throw new ForbiddenError(
      'This view is for a parent or guardian signed in to their own account.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      { logContext: { userId: principal.userId } },
    );
  }

  const links = await paymentRepository.listGuardianFinancialLinks(
    principal.scope,
    principal.userId,
  );

  const payable: PayableStudent[] = [];

  for (const link of links) {
    // A guardian the school records as a contact but not as a payer gets the student
    // listed with no figures rather than omitted: they were told they are a contact, and
    // a missing child looks like an error in the roll rather than a deliberate rule.
    if (!link.canViewFinancials) {
      payable.push({
        studentId: link.studentId,
        studentNumber: link.studentNumber,
        studentName: `${link.studentFirstName} ${link.studentLastName}`,
        relationship: link.relationship as GuardianRelation,
        currency: '',
        outstanding: '0.00',
        creditBalance: '0.00',
        canViewFinancials: false,
        canInitiatePayments: link.canInitiatePayments,
      });
      continue;
    }

    const balance = await getStudentBalance(principal.scope, link.studentId);
    payable.push({
      studentId: link.studentId,
      studentNumber: link.studentNumber,
      studentName: `${link.studentFirstName} ${link.studentLastName}`,
      relationship: link.relationship as GuardianRelation,
      currency: balance.currency,
      outstanding: balance.outstanding,
      creditBalance: balance.creditBalance,
      canViewFinancials: true,
      canInitiatePayments: link.canInitiatePayments,
    });
  }

  return payable;
}

/**
 * The payments the caller may see.
 *
 * A guardian is scoped to the students they are linked to, resolved from the database —
 * never to a `studentId` in the query string, which is a request and not a right. An
 * empty link set produces an empty page rather than the school's payments.
 */
export async function listPayments(
  principal: Principal,
  query: ListPaymentsQuery,
  pagination: ResolvedPagination,
): Promise<{ items: readonly PaymentSummary[]; totalItems: number }> {
  const visibleStudentIds = await resolveVisibleStudentIds(principal);

  if (visibleStudentIds !== null && visibleStudentIds.length === 0) {
    return { items: [], totalItems: 0 };
  }

  // A self-service caller asking for one of their own students narrows the set; asking
  // for anyone else's narrows it to nothing, which is the same answer as "no payments".
  let studentIds = visibleStudentIds;
  if (visibleStudentIds !== null && query.studentId !== undefined) {
    if (!visibleStudentIds.includes(query.studentId)) return { items: [], totalItems: 0 };
    studentIds = [query.studentId];
  }

  const result = await paymentRepository.listPayments(
    principal.scope,
    {
      ...(studentIds !== null ? { studentIds } : {}),
      ...(studentIds === null && query.studentId !== undefined
        ? { studentId: query.studentId }
        : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.method !== undefined ? { method: query.method } : {}),
      ...(query.verificationMethod !== undefined
        ? { verificationMethod: query.verificationMethod }
        : {}),
      ...(query.providerKey !== undefined ? { providerKey: query.providerKey } : {}),
      ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
      ...(query.termId !== undefined ? { termId: query.termId } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.initiatedFrom !== undefined
        ? { initiatedFrom: new Date(`${query.initiatedFrom}T00:00:00.000Z`) }
        : {}),
      // Inclusive of the whole closing day: a bursar filtering "to the 30th" means the
      // 30th, not midnight at the start of it.
      ...(query.initiatedTo !== undefined
        ? { initiatedTo: new Date(`${query.initiatedTo}T23:59:59.999Z`) }
        : {}),
    },
    pagination,
  );

  return { items: result.items.map(toPaymentSummary), totalItems: result.totalItems };
}

/**
 * One payment, with everything a reviewer needs in a single response.
 *
 * Assembled server-side rather than by four client calls, for the same reason the student
 * financial screen is: the figures on a payment screen must be guaranteed to belong to
 * the same read of the database.
 */
export async function getPayment(principal: Principal, paymentId: string): Promise<PaymentDetail> {
  const payment = await loadReadablePayment(principal, paymentId);
  const asStaff = isStaffReader(principal);

  const [transactions, statusHistory, evidence, entries] = await Promise.all([
    asStaff ? paymentRepository.listTransactionsForPayment(payment.id) : Promise.resolve([]),
    paymentRepository.listStatusHistory(payment.id),
    paymentRepository.listEvidenceForPayment(payment.id),
    listPaymentEntries(payment.id, payment.currency as CurrencyCode),
  ]);

  return toPaymentDetail({ payment, transactions, statusHistory, evidence, entries, asStaff });
}

/**
 * The ledger lines a payment produced, in the shared entry shape.
 *
 * The amount goes through `Money`, like every other read of the ledger, so the payment
 * screen and the student financial screen cannot disagree about how a figure is written.
 */
export async function listPaymentEntries(
  paymentId: string,
  currency: CurrencyCode,
): Promise<readonly FinancialEntrySummary[]> {
  const entries = await paymentRepository.listEntriesForPayment(paymentId);

  return entries.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    amount: Money.fromDatabase(entry.amount, currency).toString(),
    source: entry.source,
    description: entry.description,
    academicYearId: entry.academicYearId,
    termId: entry.termId,
    termName: entry.term?.name ?? null,
    studentChargeId: entry.studentChargeId,
    reversalOfEntryId: entry.reversalOfEntryId,
    postedByName: `${entry.postedBy.firstName} ${entry.postedBy.lastName}`,
    postedAt: entry.postedAt.toISOString(),
  }));
}

/**
 * Load a payment the caller is allowed to read, or refuse with a 404.
 *
 * Exported for the sibling services: verification and evidence have to answer the same
 * question, and three implementations of "may you see this payment?" would be two too
 * many.
 */
export async function loadReadablePayment(
  principal: Principal,
  paymentId: string,
): Promise<PaymentRecord> {
  const payment = await paymentRepository.findPaymentById(paymentId);
  // Scope first: a payment belonging to another school is not found, whoever is asking.
  principal.scope.assertPermits(payment, 'payment');
  if (payment === null) throw new NotFoundError('The requested payment was not found.');

  if (!isStaffReader(principal)) {
    // Re-resolves the guardian link for the student this payment is for, and throws the
    // same 404 when there is none, so a parent cannot walk payment ids.
    await resolveStudentFinancialAccess(principal, payment.studentId, 'VIEW');
  }

  return payment;
}

/* -------------------------------------------------------------- the context */

/**
 * Resolve and validate everything a new payment needs.
 *
 * Every refusal in here happens before a row is written, and each one names the figure or
 * the period the payer needs in order to correct the request.
 */
async function resolvePaymentContext(
  principal: Principal,
  input: PaymentRequestBase,
): Promise<PaymentContext> {
  const access = await resolveStudentFinancialAccess(principal, input.studentId, 'INITIATE');
  const schoolId = access.schoolId;

  const policy = await paymentRepository.findSchoolPaymentPolicy(schoolId);
  const currency = policy.currency as CurrencyCode;

  if (input.currency !== undefined && input.currency !== currency) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `This school accepts payments in ${currency}. No conversion is applied, so a payment ` +
        `in ${input.currency} cannot be accepted.`,
    );
  }

  const { academicYearId, termId } = await resolvePeriod(principal, input);
  const amount = Money.of(input.amount, currency);

  const minimum = Money.of(policy.minimumPaymentAmount, currency);
  if (minimum.isPositive() && amount.lessThan(minimum)) {
    throw new DomainError(
      ErrorCode.AMOUNT_BELOW_MINIMUM,
      `The smallest payment this school accepts is ${minimum.format({ withCurrency: true })}.`,
      { details: { minimumPaymentAmount: minimum.toString(), currency } },
    );
  }

  if (!policy.allowPartialPayments) {
    // The rule is about the family's debt rather than one period's, because that is what
    // "we do not take part payments" means at the counter. Read from the ledger, so it is
    // the same figure the balance screen showed the payer a moment ago.
    const balance = await getStudentBalance(principal.scope, input.studentId);
    const outstanding = Money.of(balance.outstanding, currency);

    if (outstanding.isPositive() && amount.lessThan(outstanding)) {
      throw new DomainError(
        ErrorCode.INVALID_AMOUNT,
        'This school does not accept part payments. The full outstanding balance is ' +
          `${outstanding.format({ withCurrency: true })}.`,
        { details: { outstanding: outstanding.toString(), currency } },
      );
    }
  }

  return { access, schoolId, currency, amount, academicYearId, termId };
}

/**
 * The period a payment credits.
 *
 * Defaulted server-side to the school's current year and term, because the school already
 * knows and asking a parent which term they are paying for is a question they cannot
 * reliably answer. A period named explicitly is validated: it must be the school's, the
 * term must belong to the year, and neither may be closed.
 */
async function resolvePeriod(
  principal: Principal,
  input: PaymentRequestBase,
): Promise<{ academicYearId: string; termId: string | null }> {
  const year =
    input.academicYearId === undefined
      ? await academicRepository.findCurrentAcademicYear(principal.scope)
      : await academicRepository.findAcademicYear(principal.scope, input.academicYearId);

  if (year === null) {
    throw input.academicYearId === undefined
      ? new DomainError(
          ErrorCode.PRECONDITION_FAILED,
          'This school has no current academic year, so there is no period for a payment to ' +
            'be credited to. Set the current year first.',
        )
      : new NotFoundError('That academic year was not found.');
  }

  if (year.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.PERIOD_CLOSED,
      'That academic year is closed. A payment cannot be credited to a period that has been ' +
        'signed off.',
    );
  }

  // `termId: null` is a deliberate "this is an annual payment". `undefined` means "the
  // school decides", and the answer is the current term when it belongs to the chosen
  // year and is still open.
  if (input.termId === null) return { academicYearId: year.id, termId: null };

  if (input.termId === undefined) {
    const current = await academicRepository.findCurrentTerm(principal.scope);
    const usable =
      current !== null && current.academicYearId === year.id && current.status !== 'CLOSED';
    return { academicYearId: year.id, termId: usable ? current.id : null };
  }

  const term = await academicRepository.findTerm(principal.scope, input.termId);
  if (term === null) throw new NotFoundError('That term was not found.');
  if (term.academicYearId !== year.id) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'That term belongs to a different academic year.',
    );
  }
  if (term.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.PERIOD_CLOSED,
      'That term is closed. A payment cannot be credited to it.',
    );
  }

  return { academicYearId: year.id, termId: term.id };
}

/* --------------------------------------------------------------- idempotency */

/**
 * A digest of the request an idempotency key was first used for.
 *
 * Covers every field that decides where the money goes and how much of it. A genuine
 * retry reproduces the digest exactly; a different request carrying the same key does
 * not, and is refused — which is the difference between a safe retry and a key
 * accidentally reused across two payments (Section 14).
 */
function fingerprintRequest(
  input: PaymentRequestBase,
  context: PaymentContext,
  verificationMethod: 'PROVIDER' | 'MANUAL',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        context.access.studentId,
        context.amount.toString(),
        context.currency,
        input.method,
        input.providerKey ?? null,
        context.academicYearId,
        context.termId,
        verificationMethod,
      ]),
    )
    .digest('hex');
}

/**
 * What an already-used idempotency key means for this request.
 *
 * Returns the existing payment to replay, or throws when the key was used for something
 * materially different. Both outcomes are audited: the replay because it explains why no
 * new payment appeared, and the conflict because a key reused across different requests
 * is either a client bug or somebody probing.
 */
async function resolveIdempotentReplay(
  principal: Principal,
  args: {
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly schoolId: string;
    readonly studentId: string;
  },
): Promise<PaymentRecord | null> {
  const existing = await paymentRepository.findPaymentByIdempotencyKey(
    args.schoolId,
    args.idempotencyKey,
  );
  if (existing === null) return null;

  if (existing.idempotencyFingerprint === args.fingerprint) {
    await record({
      action: AuditAction.PAYMENT_INITIATION_REPLAYED,
      entityType: AuditEntity.PAYMENT,
      entityId: existing.id,
      schoolId: args.schoolId,
      actorUserId: principal.userId,
      reason: 'The idempotency key had already been used for this exact request.',
      metadata: { reference: existing.reference, status: existing.status },
    });

    log.info(
      { paymentId: existing.id, reference: existing.reference, userId: principal.userId },
      'Replayed an existing payment for a repeated idempotency key',
    );
    return existing;
  }

  await record({
    action: AuditAction.PAYMENT_IDEMPOTENCY_CONFLICT,
    entityType: AuditEntity.PAYMENT,
    entityId: existing.id,
    result: 'FAILURE',
    schoolId: args.schoolId,
    actorUserId: principal.userId,
    reason: 'The same idempotency key was presented for a different payment request.',
    metadata: { existingReference: existing.reference, requestedStudentId: args.studentId },
  });

  throw new ConflictError(
    'That idempotency key has already been used for a different payment. Use a new key, or ' +
      'check whether the first payment went through before trying again.',
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    { logContext: { existingPaymentId: existing.id } },
  );
}

/**
 * The payment that won an idempotency-key race, when this request lost it.
 *
 * Returns null for anything that is not that race — a genuine constraint violation still
 * has to surface. The key detail is that the *reference* is also unique per school, and a
 * collision there would be a counter fault rather than a retry, so the existing payment is
 * confirmed to carry this key before it is offered as the answer.
 */
async function replayLostRace(
  principal: Principal,
  error: unknown,
  idempotencyKey: string | null,
  context: PaymentContext,
): Promise<PaymentRecord | null> {
  if (idempotencyKey === null || !isUniqueViolation(error)) return null;

  const existing = await paymentRepository.findPaymentByIdempotencyKey(
    context.schoolId,
    idempotencyKey,
  );
  if (existing === null) return null;

  await record({
    action: AuditAction.PAYMENT_INITIATION_REPLAYED,
    entityType: AuditEntity.PAYMENT,
    entityId: existing.id,
    schoolId: context.schoolId,
    actorUserId: principal.userId,
    reason: 'Two requests with one idempotency key raced; this one replayed the winner.',
    metadata: { reference: existing.reference, status: existing.status },
  });

  log.info(
    { paymentId: existing.id, reference: existing.reference, userId: principal.userId },
    'Lost an idempotency-key race and replayed the existing payment',
  );

  return existing;
}

/* ------------------------------------------------------------------ creation */

/**
 * Insert the payment, its first status-history row and — for a provider payment — the
 * attempt row, in one transaction.
 *
 * The reference is allocated from the per-year counter inside that same transaction, so a
 * rolled-back initiation leaves no gap in the sequence a bursar reads down.
 */
async function createPaymentRecord(
  principal: Principal,
  args: {
    readonly context: PaymentContext;
    readonly input: PaymentRequestBase;
    readonly verificationMethod: 'PROVIDER' | 'MANUAL';
    readonly providerKey: PaymentProviderKeyValue | null;
    readonly externalReference: string | null;
    readonly idempotencyKey: string | null;
    readonly fingerprint: string | null;
    /** Create a provider attempt row alongside the payment. */
    readonly withTransaction: boolean;
  },
): Promise<{ payment: PaymentRecord; transactionId: string | null }> {
  const { context } = args;

  const created = await prisma.$transaction(async (tx) => {
    const account = await ensureAccount(
      { schoolId: context.schoolId, studentId: context.access.studentId },
      tx,
    );

    const reference = await allocatePaymentReference(tx, {
      schoolId: context.schoolId,
      // Keyed by calendar year, which is when the payment happened, and deliberately not
      // by academic year: two academic years overlap one calendar year, and a reference
      // has to be unique in the year a parent quotes it in.
      year: new Date().getUTCFullYear(),
    });

    const payment = await paymentRepository.createPayment(
      {
        schoolId: context.schoolId,
        studentId: context.access.studentId,
        accountId: account.id,
        academicYearId: context.academicYearId,
        termId: context.termId,
        reference,
        amount: context.amount.toString(),
        currency: context.currency,
        method: args.input.method,
        verificationMethod: args.verificationMethod,
        status: 'PENDING',
        providerKey: args.providerKey,
        payerName: args.input.payerName,
        payerPhone: args.input.payerPhone ?? null,
        payerEmail: args.input.payerEmail ?? null,
        externalReference: args.externalReference,
        idempotencyKey: args.idempotencyKey,
        idempotencyFingerprint: args.fingerprint,
        notes: args.input.notes ?? null,
        initiatedByUserId: principal.userId,
      },
      tx,
    );

    // The first history row has no `fromStatus`: the payment did not come from anywhere,
    // it was created. Written so the history is the whole story rather than the story
    // from the second event onwards.
    await paymentRepository.appendStatusHistory(
      {
        schoolId: context.schoolId,
        paymentId: payment.id,
        fromStatus: null,
        toStatus: 'PENDING',
        source: 'USER',
        actorUserId: principal.userId,
        reason:
          args.verificationMethod === 'MANUAL'
            ? 'Payment claim recorded, awaiting verification against a statement.'
            : 'Payment initiated, awaiting the provider.',
      },
      tx,
    );

    let transactionId: string | null = null;
    if (args.withTransaction && args.providerKey !== null) {
      const attempt = await paymentRepository.createTransaction(
        {
          schoolId: context.schoolId,
          paymentId: payment.id,
          providerKey: args.providerKey,
          // The payment reference is what the provider is asked to quote back, so a
          // callback resolves to exactly one attempt and a bursar reading a provider
          // statement sees the same string the parent is holding.
          internalReference: reference,
          requestedAmount: context.amount.toString(),
          currency: context.currency,
          status: 'INITIATED',
        },
        tx,
      );
      transactionId = attempt.id;
    }

    await record(
      {
        action:
          args.verificationMethod === 'MANUAL'
            ? AuditAction.MANUAL_CLAIM_RECORDED
            : AuditAction.PAYMENT_INITIATED,
        entityType: AuditEntity.PAYMENT,
        entityId: payment.id,
        schoolId: context.schoolId,
        actorUserId: principal.userId,
        afterState: {
          reference,
          studentId: context.access.studentId,
          amount: context.amount.toString(),
          currency: context.currency,
          method: args.input.method,
          verificationMethod: args.verificationMethod,
          providerKey: args.providerKey,
          status: 'PENDING',
          // Whether this was staff acting for the school or a parent acting for their own
          // child. The distinction matters when the same payment is questioned later.
          actedAs: context.access.kind,
          ledgerEntryPosted: false,
        },
      },
      tx,
    );

    return { paymentId: payment.id, transactionId };
  });

  const payment = await paymentRepository.findPaymentById(created.paymentId);
  if (payment === null) {
    // Unreachable: the row was committed a moment ago. Thrown rather than forced with a
    // non-null assertion, because a payment that cannot be read back must never be
    // reported as created.
    throw new NotFoundError('The payment could not be read back after being created.');
  }

  return { payment, transactionId: created.transactionId };
}

/* ---------------------------------------------------------------- initiation */

/**
 * Start a provider-collected payment.
 *
 * Refuses outright when the channel has no adapter that can collect, rather than
 * recording a payment nobody will ever confirm. `GET /payments/methods` reports the same
 * fact in advance, so a client that reads it never reaches this refusal (Section 40).
 */
export async function initiatePayment(
  principal: Principal,
  input: InitiatePaymentBody,
  idempotencyKey: string | null,
): Promise<PaymentInitiationResult> {
  const resolved = resolveInitiationProvider(input.method);
  if (!('adapter' in resolved)) {
    throw new ServiceUnavailableError(resolved.unavailableReason, ErrorCode.SERVICE_UNAVAILABLE, {
      logContext: { method: input.method },
    });
  }
  const adapter = resolved.adapter;

  if (input.providerKey !== undefined && input.providerKey !== adapter.key) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'That provider does not collect for this payment method.',
      { details: { method: input.method, providerKey: input.providerKey } },
    );
  }

  const context = await resolvePaymentContext(principal, input);
  const fingerprint = fingerprintRequest(input, context, 'PROVIDER');

  if (idempotencyKey !== null) {
    const replayed = await resolveIdempotentReplay(principal, {
      idempotencyKey,
      fingerprint,
      schoolId: context.schoolId,
      studentId: context.access.studentId,
    });

    if (replayed !== null) {
      const attempts = await paymentRepository.listTransactionsForPayment(replayed.id);
      const latest = attempts.at(-1);
      return {
        payment: toPaymentSummary(replayed),
        transaction: latest === undefined ? null : toTransactionSummary(latest),
        // Deliberately null: the instruction belonged to the first response, and
        // repeating it would tell a payer to approve a prompt that is long gone.
        providerInstruction: null,
        replayed: true,
      };
    }
  }

  let created: { payment: PaymentRecord; transactionId: string | null };
  try {
    created = await createPaymentRecord(principal, {
      context,
      input,
      verificationMethod: 'PROVIDER',
      providerKey: adapter.key,
      externalReference: null,
      idempotencyKey,
      fingerprint: idempotencyKey === null ? null : fingerprint,
      withTransaction: true,
    });
  } catch (error) {
    // The read above is the fast path; this is the guarantee. Two taps on a slow
    // connection arrive together, both miss the read, and the unique index on
    // `(school_id, idempotency_key)` refuses the second insert. Replaying the winner is
    // the whole point of the key — answering `DUPLICATE_RESOURCE` would leave the payer
    // looking at an error for a payment that was created successfully.
    const replayed = await replayLostRace(principal, error, idempotencyKey, context);
    if (replayed === null) throw error;

    const attempts = await paymentRepository.listTransactionsForPayment(replayed.id);
    const latest = attempts.at(-1);
    return {
      payment: toPaymentSummary(replayed),
      transaction: latest === undefined ? null : toTransactionSummary(latest),
      providerInstruction: null,
      replayed: true,
    };
  }

  const { payment, transactionId } = created;

  const outcome = await askProviderToCollect(adapter, {
    internalReference: payment.reference,
    amount: context.amount.toString(),
    currency: context.currency,
    method: input.method,
    payerName: input.payerName,
    payerPhone: input.payerPhone ?? null,
    // Carries the school's own reference and nothing about the student: this string
    // reaches the payer's handset and a provider's logs (Section 22).
    description: `School fees ${payment.reference}`,
  });

  const applied = await applyInitiationOutcome({
    principal,
    payment,
    transactionId,
    outcome,
  });

  return {
    payment: toPaymentSummary(applied.payment),
    transaction: applied.transaction,
    providerInstruction: outcome.instruction,
    replayed: false,
  };
}

/**
 * Ask the adapter to collect, turning a thrown fault into an `UNKNOWN` outcome.
 *
 * An adapter is not supposed to throw for an ordinary provider outcome, but "not supposed
 * to" is not a guarantee, and the failure mode matters here: an exception would 500 the
 * request after the payment was already committed, leaving the payer with no reference
 * and the school with an attempt that says INITIATED forever. `UNKNOWN` is the truthful
 * outcome — the request may or may not have taken the money — and it keeps the payment
 * live so a callback or a bursar can still resolve it.
 */
async function askProviderToCollect(
  adapter: PaymentProviderAdapter,
  request: Parameters<PaymentProviderAdapter['initiatePayment']>[0],
): Promise<ProviderInitiationResult> {
  try {
    return await adapter.initiatePayment(request);
  } catch (error) {
    log.error(
      {
        err: error,
        providerKey: adapter.key,
        internalReference: request.internalReference,
      },
      'The payment provider adapter threw; recording the attempt as UNKNOWN',
    );

    return {
      status: 'UNKNOWN',
      providerTransactionId: null,
      instruction:
        'We could not confirm whether this payment started. Do not pay again yet — check ' +
        'the payment status first, or contact the bursar with your payment reference.',
      failureCode: null,
      failureMessage: 'The provider did not give a usable answer.',
      metadata: null,
    };
  }
}

/**
 * Record what the provider said about an initiation.
 *
 * The three branches are the whole point of the function:
 *
 *  - **Accepted** — the payment moves to PROCESSING, and now waits for a callback. It has
 *    credited nothing.
 *  - **Declined** — the payment fails, with the provider's reason, through the same
 *    `failPayment` a callback would use.
 *  - **Unknown or timed out** — the payment stays PENDING and the *attempt* records that
 *    nothing is known. This is the branch that must not be collapsed into a failure: a
 *    request that timed out may still have taken the payer's money, and telling a family
 *    their payment failed when it did not is how a school ends up collecting twice.
 */
async function applyInitiationOutcome(args: {
  readonly principal: Principal;
  readonly payment: PaymentRecord;
  readonly transactionId: string | null;
  readonly outcome: ProviderInitiationResult;
}): Promise<{ payment: PaymentRecord; transaction: PaymentTransactionSummary | null }> {
  const { payment, transactionId, outcome } = args;

  await record({
    action: AuditAction.PAYMENT_PROVIDER_RESPONDED,
    entityType: AuditEntity.PAYMENT_TRANSACTION,
    entityId: transactionId,
    result: outcome.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
    schoolId: payment.schoolId,
    actorUserId: args.principal.userId,
    ...(outcome.failureMessage !== null ? { reason: outcome.failureMessage } : {}),
    metadata: {
      paymentId: payment.id,
      reference: payment.reference,
      providerKey: payment.providerKey,
      outcome: outcome.status,
      providerTransactionId: outcome.providerTransactionId,
    },
  });

  if (outcome.status === 'FAILED') {
    await failPayment(payment.id, {
      reason:
        outcome.failureMessage ??
        'The payment provider declined the request. Nothing has been collected.',
      // The provider answered the request we made, so the change is attributed to the
      // provider rather than to the person who pressed the button.
      source: 'PROVIDER_QUERY',
      actorUserId: null,
      transactionId,
      failureCode: outcome.failureCode,
    });
  } else if (transactionId !== null) {
    await prisma.$transaction(async (tx) => {
      await paymentRepository.updateTransaction(
        transactionId,
        {
          status: outcome.status === 'INITIATED' ? 'PENDING' : outcome.status,
          ...(outcome.providerTransactionId !== null
            ? { providerTransactionId: outcome.providerTransactionId }
            : {}),
          ...(outcome.failureMessage !== null ? { failureMessage: outcome.failureMessage } : {}),
          ...(outcome.metadata !== null ? { providerMetadata: outcome.metadata } : {}),
        },
        tx,
      );

      // PENDING -> PROCESSING only when the provider actually accepted the request. On an
      // unknown outcome the payment stays PENDING, because "the provider has it" is a
      // claim we are not in a position to make.
      if (outcome.status === 'PENDING' || outcome.status === 'INITIATED') {
        const moved = await paymentRepository.transitionPayment(
          { paymentId: payment.id, fromStatuses: ['PENDING'] },
          { status: 'PROCESSING' },
          tx,
        );

        if (moved > 0) {
          await paymentRepository.appendStatusHistory(
            {
              schoolId: payment.schoolId,
              paymentId: payment.id,
              fromStatus: 'PENDING',
              toStatus: 'PROCESSING',
              source: 'PROVIDER_QUERY',
              reason: 'The provider accepted the collection request.',
              metadata: { providerTransactionId: outcome.providerTransactionId },
            },
            tx,
          );
        }
      }
    });
  }

  const [reloaded, attempts] = await Promise.all([
    paymentRepository.findPaymentById(payment.id),
    paymentRepository.listTransactionsForPayment(payment.id),
  ]);

  const latest = attempts.at(-1);
  return {
    payment: reloaded ?? payment,
    transaction: latest === undefined ? null : toTransactionSummary(latest),
  };
}

/* -------------------------------------------------------------- manual claim */

/**
 * Record a payment the school has been told about but has not confirmed.
 *
 * This is the first half of the manual verification workflow, and it is a first-class
 * path rather than a fallback: for every channel the school currently has, it is the
 * *only* path (ADR-003, docs/OPEN-QUESTIONS.md #1 and #2).
 *
 * The claim is created PENDING and credits nothing. A bursar confirming it against a
 * statement is what moves money, in `verification.service.ts`.
 */
export async function recordManualClaim(
  principal: Principal,
  input: RecordManualClaimBody,
  idempotencyKey: string | null,
): Promise<PaymentSummary> {
  const channel = channelFor(input.method);
  if (channel === null) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'That payment method is not offered.');
  }

  if (channel.verificationMethod === 'PROVIDER') {
    // A channel with a live adapter must be initiated, not claimed: claiming it would
    // route money that the provider is about to confirm through a human instead, and the
    // two paths would then both be able to credit the same payment.
    const resolved = resolveInitiationProvider(input.method);
    if ('adapter' in resolved) {
      throw new DomainError(
        ErrorCode.PRECONDITION_FAILED,
        'That channel is collected online. Start the payment instead of recording a claim, ' +
          'so the provider confirms it.',
      );
    }

    // No adapter: the channel exists in the world but not as an integration, so a payment
    // made through it can only be recorded and verified by hand. There is no provider to
    // name, and a claim that named one would imply an integration that does not exist.
    if (input.providerKey !== undefined) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That channel has no connected provider, so a provider cannot be named on the claim.',
      );
    }
  } else if (!providerIsValidForChannel(input.method, input.providerKey ?? null)) {
    // A bank channel must say which institution the money went through — that is the
    // statement the bursar will read. Cash must not name one: somebody counted it, and
    // that somebody is the verifier.
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      channel.providerChoices.length === 0
        ? 'That payment method has no provider, so one cannot be named.'
        : 'Say which bank or institution the payment went through, so it can be matched ' +
            'against the right statement.',
      { details: { method: input.method, providerChoices: channel.providerChoices } },
    );
  }

  const context = await resolvePaymentContext(principal, input);
  const fingerprint = fingerprintRequest(input, context, 'MANUAL');

  if (idempotencyKey !== null) {
    const replayed = await resolveIdempotentReplay(principal, {
      idempotencyKey,
      fingerprint,
      schoolId: context.schoolId,
      studentId: context.access.studentId,
    });
    if (replayed !== null) return toPaymentSummary(replayed);
  }

  let payment: PaymentRecord;
  try {
    ({ payment } = await createPaymentRecord(principal, {
      context,
      input,
      verificationMethod: 'MANUAL',
      providerKey: input.providerKey ?? null,
      externalReference: input.externalReference ?? null,
      idempotencyKey,
      fingerprint: idempotencyKey === null ? null : fingerprint,
      withTransaction: false,
    }));
  } catch (error) {
    // Same race as initiation: two submissions of one claim, one insert, and the loser
    // answers with the winner's payment rather than with an error.
    const replayed = await replayLostRace(principal, error, idempotencyKey, context);
    if (replayed === null) throw error;
    return toPaymentSummary(replayed);
  }

  log.info(
    {
      paymentId: payment.id,
      reference: payment.reference,
      method: payment.method,
      actedAs: context.access.kind,
    },
    'Manual payment claim recorded, awaiting verification',
  );

  return toPaymentSummary(payment);
}

/* ------------------------------------------------------------- cancellation */

/**
 * Withdraw a payment that has not completed.
 *
 * Only from PENDING for a parent: a payment held for review is a question a person has to
 * answer, and letting the payer cancel it would be a way to make an amount mismatch
 * disappear from the queue. Staff may also cancel from REQUIRES_REVIEW, which is the
 * supported way to close out a claim that turned out to be nothing.
 *
 * PROCESSING is never cancellable, by the transition table: once a provider has the
 * request, the school does not get to decide the money did not move.
 */
export async function cancelPayment(
  principal: Principal,
  paymentId: string,
  input: CancelPaymentBody,
): Promise<PaymentSummary> {
  const payment = await loadReadablePayment(principal, paymentId);
  const asStaff = isStaffReader(principal);

  if (!asStaff) {
    // A parent cancelling their own payment needs the right to have started one.
    await resolveStudentFinancialAccess(principal, payment.studentId, 'INITIATE');
  }

  // Refuses an illegal move with the reason a person can act on, before anything is
  // written. The conditional update below is what makes the decision stick.
  assertTransition(payment.status, 'CANCELLED');

  const cancellableFrom: readonly PaymentStatus[] = asStaff
    ? ['PENDING', 'REQUIRES_REVIEW']
    : ['PENDING'];

  if (!cancellableFrom.includes(payment.status)) {
    throw new ConflictError(
      'A payment held for review has to be resolved by the bursar’s office. Contact them ' +
        'with your payment reference.',
      ErrorCode.INVALID_STATE_TRANSITION,
      { logContext: { paymentId, status: payment.status } },
    );
  }

  const cancelledAt = new Date();

  await prisma.$transaction(async (tx) => {
    const moved = await paymentRepository.transitionPayment(
      {
        paymentId,
        fromStatuses: [...cancellableFrom],
        expectedVersion: input.expectedVersion,
      },
      { status: 'CANCELLED', completedAt: cancelledAt, failureReason: input.reason },
      tx,
    );

    if (moved === 0) {
      throw new ConflictError(
        'This payment was changed by someone else while you were looking at it. Reload and ' +
          'check its status.',
        ErrorCode.RECORD_MODIFIED,
        { logContext: { paymentId, expectedVersion: input.expectedVersion } },
      );
    }

    await paymentRepository.appendStatusHistory(
      {
        schoolId: payment.schoolId,
        paymentId,
        fromStatus: payment.status,
        toStatus: 'CANCELLED',
        source: 'USER',
        reason: input.reason,
        actorUserId: principal.userId,
      },
      tx,
    );

    await record(
      {
        action: AuditAction.PAYMENT_CANCELLED,
        entityType: AuditEntity.PAYMENT,
        entityId: paymentId,
        reason: input.reason,
        schoolId: payment.schoolId,
        actorUserId: principal.userId,
        beforeState: { status: payment.status },
        afterState: { status: 'CANCELLED', ledgerEntryPosted: false },
      },
      tx,
    );
  });

  const reloaded = await paymentRepository.findPaymentById(paymentId);
  return toPaymentSummary(reloaded ?? payment);
}
