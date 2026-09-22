/**
 * Payment data access.
 *
 * Two things in here are load-bearing and everything else is ordinary querying.
 *
 * **`lockPayment` takes a real row lock.** Finalisation reads a payment, checks its
 * status, compares amounts and then writes — and between the read and the write a second
 * webhook delivery can arrive. `SELECT ... FOR UPDATE` inside the caller's transaction
 * makes the second finaliser wait rather than interleave, so its checks run against the
 * state the first one left behind instead of the state both of them saw.
 *
 * **`transitionPayment` is a conditional UPDATE, not a read-then-write.** The permitted
 * source statuses go in the `WHERE`, so if a concurrent transaction got there first the
 * update matches zero rows and the caller is told it lost. This is the same technique
 * Phase 4 uses for relief approval, and for the same reason: a check that passed a
 * moment ago is not a guarantee (Section 33).
 *
 * Money is selected as text and never as a JavaScript number. Nothing in this file does
 * arithmetic.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  ContentScanState,
  PaymentEvidenceKind,
  PaymentMethod,
  PaymentProviderKey,
  PaymentStatus,
  PaymentVerificationMethod,
  WebhookVerificationResult,
} from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

/* --------------------------------------------------------------- projections */

const ACTOR_NAME = { select: { firstName: true, lastName: true } } as const;

const PAYMENT_PROJECTION = {
  id: true,
  schoolId: true,
  studentId: true,
  accountId: true,
  academicYearId: true,
  termId: true,
  reference: true,
  amount: true,
  currency: true,
  method: true,
  verificationMethod: true,
  status: true,
  providerKey: true,
  payerName: true,
  payerPhone: true,
  payerEmail: true,
  externalReference: true,
  idempotencyKey: true,
  idempotencyFingerprint: true,
  notes: true,
  failureReason: true,
  initiatedByUserId: true,
  initiatedAt: true,
  completedAt: true,
  verifiedByUserId: true,
  verifiedAt: true,
  verificationNote: true,
  reversedByUserId: true,
  reversedAt: true,
  reversalReason: true,
  version: true,
  student: { select: { studentId: true, firstName: true, lastName: true } },
  academicYear: { select: { name: true } },
  term: { select: { name: true } },
  initiatedBy: ACTOR_NAME,
  verifiedBy: ACTOR_NAME,
  reversedBy: ACTOR_NAME,
  // The opening ledger credit, if this payment has posted one. Selected alongside the
  // payment rather than fetched per row, so a page of fifty payments is one query and
  // not fifty-one. The filter is the same one `findOpeningPaymentEntry` uses, because
  // two definitions of "the credit this payment posted" is one too many.
  entries: {
    where: { source: 'PAYMENT', reversalOfEntryId: null },
    select: { id: true },
    take: 1,
  },
  _count: { select: { evidence: true } },
} as const satisfies Prisma.PaymentSelect;

const TRANSACTION_PROJECTION = {
  id: true,
  schoolId: true,
  paymentId: true,
  providerKey: true,
  internalReference: true,
  providerTransactionId: true,
  requestedAmount: true,
  confirmedAmount: true,
  currency: true,
  status: true,
  failureCode: true,
  failureMessage: true,
  initiatedAt: true,
  completedAt: true,
} as const satisfies Prisma.PaymentTransactionSelect;

const STATUS_HISTORY_PROJECTION = {
  id: true,
  fromStatus: true,
  toStatus: true,
  source: true,
  reason: true,
  occurredAt: true,
  actor: ACTOR_NAME,
} as const satisfies Prisma.PaymentStatusHistorySelect;

const EVIDENCE_PROJECTION = {
  id: true,
  schoolId: true,
  paymentId: true,
  kind: true,
  storageKey: true,
  fileName: true,
  contentType: true,
  byteSize: true,
  checksum: true,
  scanState: true,
  uploadedAt: true,
  isCurrent: true,
  uploadedBy: ACTOR_NAME,
} as const satisfies Prisma.PaymentEvidenceSelect;

/**
 * The ledger lines a payment produced: its credit, and any compensating entry.
 *
 * `source` is selected rather than assumed to be `PAYMENT`, even though the query filters
 * on the payment id, so the shape stays truthful if a later phase allocates a payment
 * across several entries.
 */
const PAYMENT_ENTRY_PROJECTION = {
  id: true,
  entryType: true,
  amount: true,
  source: true,
  description: true,
  reversalOfEntryId: true,
  postedAt: true,
  academicYearId: true,
  termId: true,
  studentChargeId: true,
  term: { select: { name: true } },
  postedBy: ACTOR_NAME,
} as const satisfies Prisma.FinancialEntrySelect;

export type PaymentRecord = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_PROJECTION }>;
export type PaymentLedgerEntryRecord = Prisma.FinancialEntryGetPayload<{
  select: typeof PAYMENT_ENTRY_PROJECTION;
}>;
export type PaymentTransactionRecord = Prisma.PaymentTransactionGetPayload<{
  select: typeof TRANSACTION_PROJECTION;
}>;
export type PaymentStatusHistoryRecord = Prisma.PaymentStatusHistoryGetPayload<{
  select: typeof STATUS_HISTORY_PROJECTION;
}>;
export type PaymentEvidenceRecord = Prisma.PaymentEvidenceGetPayload<{
  select: typeof EVIDENCE_PROJECTION;
}>;

/* ------------------------------------------------------------------- inputs */

export interface PaymentFilters {
  readonly studentId?: string | undefined;
  readonly status?: PaymentStatus | undefined;
  readonly method?: PaymentMethod | undefined;
  readonly verificationMethod?: PaymentVerificationMethod | undefined;
  readonly providerKey?: PaymentProviderKey | undefined;
  readonly academicYearId?: string | undefined;
  readonly termId?: string | undefined;
  /** Free-text over the payment reference, the payer name and the external reference. */
  readonly search?: string | undefined;
  readonly initiatedFrom?: Date | undefined;
  readonly initiatedTo?: Date | undefined;
  /** Restricts the result to these students. Used to scope a parent to their children. */
  readonly studentIds?: readonly string[] | undefined;
}

/**
 * A payment as the finalisation path needs it: locked, with money as text.
 *
 * Deliberately not the full projection. Finalisation must not depend on joined display
 * data, because the row it acts on has to be the row it locked.
 */
export interface LockedPayment {
  readonly id: string;
  readonly schoolId: string;
  readonly studentId: string;
  readonly accountId: string;
  readonly academicYearId: string;
  readonly termId: string | null;
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly method: PaymentMethod;
  readonly verificationMethod: PaymentVerificationMethod;
  readonly providerKey: PaymentProviderKey | null;
  readonly initiatedByUserId: string;
  readonly version: number;
}

interface LockedPaymentRow {
  readonly id: string;
  readonly school_id: string;
  readonly student_id: string;
  readonly account_id: string;
  readonly academic_year_id: string;
  readonly term_id: string | null;
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly method: PaymentMethod;
  readonly verification_method: PaymentVerificationMethod;
  readonly provider_key: PaymentProviderKey | null;
  readonly initiated_by_user_id: string;
  readonly version: number;
}

export interface PaymentTransitionData {
  readonly status: PaymentStatus;
  readonly completedAt?: Date | null;
  readonly failureReason?: string | null;
  readonly verifiedByUserId?: string | null;
  readonly verifiedAt?: Date | null;
  readonly verificationNote?: string | null;
  readonly reversedByUserId?: string | null;
  readonly reversedAt?: Date | null;
  readonly reversalReason?: string | null;
  readonly externalReference?: string | null;
}

export interface GuardianFinancialLink {
  readonly studentId: string;
  readonly schoolId: string;
  readonly relationship: string;
  readonly canViewFinancials: boolean;
  readonly canInitiatePayments: boolean;
  readonly studentNumber: string;
  readonly studentFirstName: string;
  readonly studentLastName: string;
}

function buildPaymentWhere(scope: AccessScope, filters: PaymentFilters): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = { ...scope.filter };

  if (filters.studentId !== undefined) where.studentId = filters.studentId;
  if (filters.studentIds !== undefined) where.studentId = { in: [...filters.studentIds] };
  if (filters.status !== undefined) where.status = filters.status;
  if (filters.method !== undefined) where.method = filters.method;
  if (filters.verificationMethod !== undefined) {
    where.verificationMethod = filters.verificationMethod;
  }
  if (filters.providerKey !== undefined) where.providerKey = filters.providerKey;
  if (filters.academicYearId !== undefined) where.academicYearId = filters.academicYearId;
  if (filters.termId !== undefined) where.termId = filters.termId;

  if (filters.initiatedFrom !== undefined || filters.initiatedTo !== undefined) {
    where.initiatedAt = {
      ...(filters.initiatedFrom !== undefined ? { gte: filters.initiatedFrom } : {}),
      ...(filters.initiatedTo !== undefined ? { lte: filters.initiatedTo } : {}),
    };
  }

  const term = filters.search?.trim();
  if (term !== undefined && term !== '') {
    // Three fields because a bursar searching for a payment has one of three things in
    // hand: the reference from the parent, the name on the statement line, or the bank's
    // own reference.
    where.OR = [
      { reference: { contains: term, mode: 'insensitive' } },
      { payerName: { contains: term, mode: 'insensitive' } },
      { externalReference: { contains: term, mode: 'insensitive' } },
    ];
  }

  return where;
}

export const paymentRepository = {
  /* --------------------------------------------------------------- payments */

  async listPayments(
    scope: AccessScope,
    filters: PaymentFilters,
    pagination: ResolvedPagination,
  ): Promise<{ items: PaymentRecord[]; totalItems: number }> {
    const where = buildPaymentWhere(scope, filters);

    const [items, totalItems] = await Promise.all([
      prisma.payment.findMany({
        where,
        select: PAYMENT_PROJECTION,
        // Newest first: a payments table is read from the most recent activity back.
        // `id` breaks ties so pagination is stable when two payments share a timestamp.
        orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.payment.count({ where }),
    ]);

    return { items, totalItems };
  },

  async findPaymentById(id: string): Promise<PaymentRecord | null> {
    return prisma.payment.findUnique({ where: { id }, select: PAYMENT_PROJECTION });
  },

  /**
   * The payment an idempotency key already produced, if any.
   *
   * Read before creating, and the unique index is what makes the read safe: two requests
   * racing with the same key both miss here, then one insert wins and the other is told
   * by the constraint. The read is the fast path, not the guarantee.
   */
  async findPaymentByIdempotencyKey(
    schoolId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | null> {
    return prisma.payment.findFirst({
      where: { schoolId, idempotencyKey },
      select: PAYMENT_PROJECTION,
    });
  },

  async createPayment(
    data: Prisma.PaymentUncheckedCreateInput,
    client: PrismaTransactionClient,
  ): Promise<{ id: string; reference: string }> {
    return client.payment.create({ data, select: { id: true, reference: true } });
  },

  /**
   * Load a payment under a row lock, inside the caller's transaction.
   *
   * Raw SQL because `FOR UPDATE` has no expression in the Prisma query API. Money is cast
   * to text in the query so it arrives as the exact decimal string the column holds and
   * never as a float.
   */
  async lockPayment(
    paymentId: string,
    client: PrismaTransactionClient,
  ): Promise<LockedPayment | null> {
    const rows = await client.$queryRaw<LockedPaymentRow[]>`
      SELECT
        id::text                 AS id,
        school_id::text          AS school_id,
        student_id::text         AS student_id,
        account_id::text         AS account_id,
        academic_year_id::text   AS academic_year_id,
        term_id::text            AS term_id,
        reference,
        amount::text             AS amount,
        currency,
        status,
        method,
        verification_method,
        provider_key,
        initiated_by_user_id::text AS initiated_by_user_id,
        version
      FROM payments
      WHERE id = ${paymentId}::uuid
      FOR UPDATE
    `;

    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      schoolId: row.school_id,
      studentId: row.student_id,
      accountId: row.account_id,
      academicYearId: row.academic_year_id,
      termId: row.term_id,
      reference: row.reference,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      method: row.method,
      verificationMethod: row.verification_method,
      providerKey: row.provider_key,
      initiatedByUserId: row.initiated_by_user_id,
      version: row.version,
    };
  },

  /**
   * Move a payment to a new status, but only from one of `fromStatuses`.
   *
   * Returns the number of rows changed: zero means a concurrent transaction moved it
   * first, and the caller must treat its own decision as stale. Never returns success
   * for a write that did not happen.
   */
  async transitionPayment(
    args: {
      readonly paymentId: string;
      readonly fromStatuses: readonly PaymentStatus[];
      readonly expectedVersion?: number | undefined;
    },
    data: PaymentTransitionData,
    client: PrismaTransactionClient,
  ): Promise<number> {
    const result = await client.payment.updateMany({
      where: {
        id: args.paymentId,
        status: { in: [...args.fromStatuses] },
        ...(args.expectedVersion !== undefined ? { version: args.expectedVersion } : {}),
      },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count;
  },

  /* ----------------------------------------------------------- transactions */

  async createTransaction(
    data: Prisma.PaymentTransactionUncheckedCreateInput,
    client: PrismaTransactionClient,
  ): Promise<PaymentTransactionRecord> {
    return client.paymentTransaction.create({ data, select: TRANSACTION_PROJECTION });
  },

  async updateTransaction(
    id: string,
    data: Prisma.PaymentTransactionUncheckedUpdateInput,
    client: PrismaTransactionClient,
  ): Promise<void> {
    await client.paymentTransaction.update({ where: { id }, data, select: { id: true } });
  },

  async listTransactionsForPayment(paymentId: string): Promise<PaymentTransactionRecord[]> {
    return prisma.paymentTransaction.findMany({
      where: { paymentId },
      select: TRANSACTION_PROJECTION,
      orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The attempt a callback's reference names.
   *
   * Scoped by provider as well as by reference: a reference is unique per school, and
   * accepting one quoted by a different provider than the one that was asked to collect
   * would let a compromised secret for one channel confirm another channel's payment.
   */
  async findTransactionByInternalReference(args: {
    providerKey: PaymentProviderKey;
    internalReference: string;
  }): Promise<PaymentTransactionRecord | null> {
    return prisma.paymentTransaction.findFirst({
      where: {
        providerKey: args.providerKey,
        internalReference: args.internalReference,
      },
      select: TRANSACTION_PROJECTION,
    });
  },

  async findTransactionByProviderId(args: {
    providerKey: PaymentProviderKey;
    providerTransactionId: string;
  }): Promise<PaymentTransactionRecord | null> {
    return prisma.paymentTransaction.findUnique({
      where: {
        providerKey_providerTransactionId: {
          providerKey: args.providerKey,
          providerTransactionId: args.providerTransactionId,
        },
      },
      select: TRANSACTION_PROJECTION,
    });
  },

  /* -------------------------------------------------------- status history */

  /**
   * Record a transition. Insert-only, and always inside the transaction that made the
   * transition, so the history cannot claim something the payment did not do.
   */
  async appendStatusHistory(
    data: Prisma.PaymentStatusHistoryUncheckedCreateInput,
    client: PrismaTransactionClient,
  ): Promise<void> {
    await client.paymentStatusHistory.create({ data, select: { id: true } });
  },

  async listStatusHistory(paymentId: string): Promise<PaymentStatusHistoryRecord[]> {
    return prisma.paymentStatusHistory.findMany({
      where: { paymentId },
      select: STATUS_HISTORY_PROJECTION,
      // Chronological: the history is read as a narrative, oldest first.
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  },

  /* --------------------------------------------------------------- evidence */

  async createEvidence(
    data: Prisma.PaymentEvidenceUncheckedCreateInput,
    client: PrismaTransactionClient,
  ): Promise<PaymentEvidenceRecord> {
    return client.paymentEvidence.create({ data, select: EVIDENCE_PROJECTION });
  },

  /**
   * Mark the current evidence of a kind as superseded.
   *
   * An update of a flag rather than a delete: the superseded row, its checksum and its
   * uploader stay readable, so "the slip was swapped after the bursar looked at it" is a
   * visible fact (Section 23).
   */
  async supersedeEvidence(
    args: { paymentId: string; kind: PaymentEvidenceKind },
    client: PrismaTransactionClient,
  ): Promise<number> {
    const result = await client.paymentEvidence.updateMany({
      where: { paymentId: args.paymentId, kind: args.kind, isCurrent: true },
      data: { isCurrent: false },
    });
    return result.count;
  },

  async listEvidenceForPayment(paymentId: string): Promise<PaymentEvidenceRecord[]> {
    return prisma.paymentEvidence.findMany({
      where: { paymentId },
      select: EVIDENCE_PROJECTION,
      orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
    });
  },

  async findEvidenceById(id: string): Promise<PaymentEvidenceRecord | null> {
    return prisma.paymentEvidence.findUnique({ where: { id }, select: EVIDENCE_PROJECTION });
  },

  async setEvidenceScanState(
    id: string,
    scanState: ContentScanState,
    client: PrismaTransactionClient,
  ): Promise<void> {
    await client.paymentEvidence.update({
      where: { id },
      data: { scanState },
      select: { id: true },
    });
  },

  /* -------------------------------------------------------- webhook events */

  /**
   * Record an inbound callback, refusing a duplicate.
   *
   * Returns null when `(providerKey, eventId)` is already present, which is the whole
   * mechanism behind idempotent webhook handling: the insert is attempted *before* the
   * callback is acted on, so a re-delivery loses the race here and is answered from the
   * first delivery's record rather than processed again.
   *
   * P2002 is caught rather than pre-checked with a read, because a read followed by an
   * insert has a window between them and two simultaneous deliveries fit inside it.
   */
  async recordWebhookEvent(
    data: Prisma.PaymentWebhookEventUncheckedCreateInput,
  ): Promise<{ id: string } | null> {
    try {
      return await prisma.paymentWebhookEvent.create({ data, select: { id: true } });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  },

  async findWebhookEvent(args: { providerKey: PaymentProviderKey; eventId: string }): Promise<{
    id: string;
    verification: WebhookVerificationResult;
    paymentId: string | null;
    resultingStatus: PaymentStatus | null;
    receivedAt: Date;
  } | null> {
    return prisma.paymentWebhookEvent.findUnique({
      where: {
        providerKey_eventId: { providerKey: args.providerKey, eventId: args.eventId },
      },
      select: {
        id: true,
        verification: true,
        paymentId: true,
        resultingStatus: true,
        receivedAt: true,
      },
    });
  },

  async completeWebhookEvent(
    id: string,
    data: {
      schoolId?: string | null;
      paymentId?: string | null;
      paymentTransactionId?: string | null;
      verification?: WebhookVerificationResult;
      resultingStatus?: PaymentStatus | null;
      processedAt?: Date;
    },
  ): Promise<void> {
    await prisma.paymentWebhookEvent.update({ where: { id }, data, select: { id: true } });
  },

  /* -------------------------------------------------- self-service access */

  /**
   * The financial rights a signed-in user holds over one student.
   *
   * Resolved from `student_guardians` through the guardian profile attached to the user,
   * which is the only path by which a parent account reaches a student. Returns null when
   * there is no link — and the caller turns that into the same 404 a missing student
   * gets, so a parent cannot use payment endpoints to discover which student ids exist.
   */
  async findGuardianFinancialLink(args: {
    userId: string;
    studentId: string;
  }): Promise<GuardianFinancialLink | null> {
    const link = await prisma.studentGuardian.findFirst({
      where: { studentId: args.studentId, guardian: { userId: args.userId } },
      select: {
        schoolId: true,
        studentId: true,
        relationship: true,
        canViewFinancials: true,
        canInitiatePayments: true,
        student: { select: { studentId: true, firstName: true, lastName: true } },
      },
    });

    if (link === null) return null;

    return {
      studentId: link.studentId,
      schoolId: link.schoolId,
      relationship: link.relationship,
      canViewFinancials: link.canViewFinancials,
      canInitiatePayments: link.canInitiatePayments,
      studentNumber: link.student.studentId,
      studentFirstName: link.student.firstName,
      studentLastName: link.student.lastName,
    };
  },

  /** Every student a signed-in guardian is linked to, whatever their rights over it. */
  async listGuardianFinancialLinks(
    scope: AccessScope,
    userId: string,
  ): Promise<readonly GuardianFinancialLink[]> {
    const links = await prisma.studentGuardian.findMany({
      where: { ...scope.filter, guardian: { userId } },
      select: {
        schoolId: true,
        studentId: true,
        relationship: true,
        canViewFinancials: true,
        canInitiatePayments: true,
        student: { select: { studentId: true, firstName: true, lastName: true } },
      },
      orderBy: [{ student: { firstName: 'asc' } }, { student: { lastName: 'asc' } }],
    });

    return links.map((link) => ({
      studentId: link.studentId,
      schoolId: link.schoolId,
      relationship: link.relationship,
      canViewFinancials: link.canViewFinancials,
      canInitiatePayments: link.canInitiatePayments,
      studentNumber: link.student.studentId,
      studentFirstName: link.student.firstName,
      studentLastName: link.student.lastName,
    }));
  },

  /* ------------------------------------------------------------- the ledger */

  /**
   * The ledger lines a payment produced.
   *
   * Read for the payment detail screen, and by a reversal before it posts: the
   * compensating entry has to attach to the credit it actually undoes rather than to a
   * guess about which one that is.
   */
  async listEntriesForPayment(paymentId: string): Promise<PaymentLedgerEntryRecord[]> {
    // The amount is returned as the Prisma Decimal the column holds, not stringified
    // here. Every other read of the ledger normalises through `Money`, which pads to the
    // storage scale — and a payment screen reporting `40000` where the student financial
    // screen reports `40000.00` is the kind of inconsistency that makes somebody check
    // the figure by hand.
    return prisma.financialEntry.findMany({
      where: { paymentId },
      select: PAYMENT_ENTRY_PROJECTION,
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** The opening credit a payment posted, if it has one. */
  async findOpeningPaymentEntry(
    paymentId: string,
    client: PrismaTransactionClient = prisma,
  ): Promise<{ id: string } | null> {
    return client.financialEntry.findFirst({
      where: { paymentId, source: 'PAYMENT', reversalOfEntryId: null },
      select: { id: true },
    });
  },

  /* ------------------------------------------------------------ supporting */

  async findSchoolPaymentPolicy(schoolId: string): Promise<{
    currency: string;
    allowPartialPayments: boolean;
    minimumPaymentAmount: string;
    enforceVerificationSeparationOfDuties: boolean;
  }> {
    const settings = await prisma.schoolSetting.findUnique({
      where: { schoolId },
      select: {
        currency: true,
        allowPartialPayments: true,
        minimumPaymentAmount: true,
        enforceVerificationSeparationOfDuties: true,
      },
    });

    // Column defaults, for a school with no settings row. The seed always creates one;
    // this keeps a half-configured tenant from crediting payments under no policy at all.
    return {
      currency: settings?.currency ?? 'RWF',
      allowPartialPayments: settings?.allowPartialPayments ?? true,
      minimumPaymentAmount: (settings?.minimumPaymentAmount ?? 0).toString(),
      enforceVerificationSeparationOfDuties:
        settings?.enforceVerificationSeparationOfDuties ?? true,
    };
  },

  async countPayments(scope: AccessScope, filters: PaymentFilters): Promise<number> {
    return prisma.payment.count({ where: buildPaymentWhere(scope, filters) });
  },
} as const;

export type PaymentRepository = typeof paymentRepository;

/**
 * True for a PostgreSQL unique-constraint violation, however it reaches us.
 *
 * Matched on the code rather than with `instanceof`: Prisma's error classes are exported
 * from the generated client, and a duck-typed check keeps this file from depending on
 * which of the several generated entry points that class came from.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** The payment status values a transition may legally start from, as Prisma enums. */
export type { PaymentStatus };
