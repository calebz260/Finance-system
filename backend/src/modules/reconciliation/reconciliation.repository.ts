/**
 * Reconciliation data access: imported statements, their lines, and the payments a line
 * might belong to.
 *
 * Two things here carry the weight.
 *
 * **`lockLine` takes a row lock.** Matching reads a line, checks it is unattributed,
 * checks the payment is free, and then writes. Two bursars working the same statement can
 * interleave in that gap, and the loser must be told rather than allowed to overwrite the
 * winner's decision.
 *
 * **`attributeLine` is a conditional UPDATE.** The permitted source statuses and the
 * expected version both go in the `WHERE`, so a decision made against a stale screen
 * matches zero rows and is reported as a conflict. The same technique as payment
 * finalisation, for the same reason (Section 33).
 *
 * Money is selected as `Decimal` and converted through `Money` by the service. Nothing in
 * this file does arithmetic beyond the aggregate sums PostgreSQL performs itself.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  BankStatementDirection,
  PaymentProviderKey,
  StatementLineMatchStatus,
} from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

const ACTOR_NAME = { select: { firstName: true, lastName: true } } as const;

const IMPORT_PROJECTION = {
  id: true,
  schoolId: true,
  provider: true,
  accountLabel: true,
  fileName: true,
  checksum: true,
  periodStart: true,
  periodEnd: true,
  lineCount: true,
  totalIn: true,
  totalOut: true,
  currency: true,
  importedAt: true,
  notes: true,
  importedBy: ACTOR_NAME,
} as const satisfies Prisma.BankStatementImportSelect;

const LINE_PROJECTION = {
  id: true,
  schoolId: true,
  importId: true,
  lineNumber: true,
  valueDate: true,
  narrative: true,
  reference: true,
  amount: true,
  currency: true,
  direction: true,
  matchStatus: true,
  matchedPaymentId: true,
  matchedAt: true,
  matchNote: true,
  version: true,
  matchedBy: ACTOR_NAME,
  matchedPayment: {
    select: {
      reference: true,
      student: { select: { firstName: true, lastName: true } },
    },
  },
} as const satisfies Prisma.BankStatementLineSelect;

/** A live payment, as the matcher and the suggestion list need it. */
const CANDIDATE_PROJECTION = {
  id: true,
  schoolId: true,
  reference: true,
  amount: true,
  currency: true,
  status: true,
  payerName: true,
  externalReference: true,
  providerKey: true,
  initiatedAt: true,
  initiatedByUserId: true,
  studentId: true,
  student: { select: { studentId: true, firstName: true, lastName: true } },
} as const satisfies Prisma.PaymentSelect;

export type StatementImportRecord = Prisma.BankStatementImportGetPayload<{
  select: typeof IMPORT_PROJECTION;
}>;
export type StatementLineRecord = Prisma.BankStatementLineGetPayload<{
  select: typeof LINE_PROJECTION;
}>;
export type CandidatePaymentRecord = Prisma.PaymentGetPayload<{
  select: typeof CANDIDATE_PROJECTION;
}>;

/** A line under a row lock. Deliberately narrow: only what a decision depends on. */
export interface LockedStatementLine {
  readonly id: string;
  readonly schoolId: string;
  readonly importId: string;
  readonly lineNumber: number;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankStatementDirection;
  readonly matchStatus: StatementLineMatchStatus;
  readonly matchedPaymentId: string | null;
  readonly narrative: string;
  readonly reference: string | null;
  readonly version: number;
}

interface LockedLineRow {
  readonly id: string;
  readonly school_id: string;
  readonly import_id: string;
  readonly line_number: number;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankStatementDirection;
  readonly match_status: StatementLineMatchStatus;
  readonly matched_payment_id: string | null;
  readonly narrative: string;
  readonly reference: string | null;
  readonly version: number;
}

export interface StatementLineFilters {
  readonly importId?: string | undefined;
  readonly matchStatus?: StatementLineMatchStatus | undefined;
  readonly direction?: BankStatementDirection | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

function buildLineWhere(
  scope: AccessScope,
  filters: StatementLineFilters,
): Prisma.BankStatementLineWhereInput {
  const where: Prisma.BankStatementLineWhereInput = { ...scope.filter };

  if (filters.importId !== undefined) where.importId = filters.importId;
  if (filters.matchStatus !== undefined) where.matchStatus = filters.matchStatus;
  if (filters.direction !== undefined) where.direction = filters.direction;
  if (filters.from !== undefined || filters.to !== undefined) {
    where.valueDate = {
      ...(filters.from !== undefined ? { gte: filters.from } : {}),
      ...(filters.to !== undefined ? { lte: filters.to } : {}),
    };
  }

  return where;
}

export const reconciliationRepository = {
  /* ------------------------------------------------------------- statements */

  async findImportByChecksum(
    schoolId: string,
    checksum: string,
  ): Promise<StatementImportRecord | null> {
    return prisma.bankStatementImport.findFirst({
      where: { schoolId, checksum },
      select: IMPORT_PROJECTION,
    });
  },

  async findImportById(id: string): Promise<StatementImportRecord | null> {
    return prisma.bankStatementImport.findUnique({ where: { id }, select: IMPORT_PROJECTION });
  },

  async listImports(
    scope: AccessScope,
    pagination: ResolvedPagination,
  ): Promise<{ items: StatementImportRecord[]; totalItems: number }> {
    const where: Prisma.BankStatementImportWhereInput = { ...scope.filter };

    const [items, totalItems] = await Promise.all([
      prisma.bankStatementImport.findMany({
        where,
        select: IMPORT_PROJECTION,
        orderBy: [{ importedAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.bankStatementImport.count({ where }),
    ]);

    return { items, totalItems };
  },

  /**
   * Insert a statement and all of its lines in one transaction.
   *
   * All or nothing, like the student import: half a statement is worse than none, because
   * the missing half is invisible — a bursar would reconcile what is there and conclude
   * the rest never arrived (ADR-015).
   */
  async createImportWithLines(
    args: {
      readonly statement: Prisma.BankStatementImportUncheckedCreateInput;
      readonly lines: ReadonlyArray<Omit<Prisma.BankStatementLineCreateManyInput, 'importId'>>;
    },
    client: PrismaTransactionClient,
  ): Promise<{ id: string }> {
    const created = await client.bankStatementImport.create({
      data: args.statement,
      select: { id: true },
    });

    if (args.lines.length > 0) {
      await client.bankStatementLine.createMany({
        data: args.lines.map((line) => ({ ...line, importId: created.id })),
      });
    }

    return created;
  },

  /* ------------------------------------------------------------------ lines */

  async listLines(
    scope: AccessScope,
    filters: StatementLineFilters,
    pagination: ResolvedPagination,
  ): Promise<{ items: StatementLineRecord[]; totalItems: number }> {
    const where = buildLineWhere(scope, filters);

    const [items, totalItems] = await Promise.all([
      prisma.bankStatementLine.findMany({
        where,
        select: LINE_PROJECTION,
        // Oldest first: a statement is worked down the page, and the oldest unattributed
        // line is the one that has been waiting longest.
        orderBy: [{ valueDate: 'asc' }, { lineNumber: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.bankStatementLine.count({ where }),
    ]);

    return { items, totalItems };
  },

  async findLineById(id: string): Promise<StatementLineRecord | null> {
    return prisma.bankStatementLine.findUnique({ where: { id }, select: LINE_PROJECTION });
  },

  /** Load a line under a row lock, inside the caller's transaction. */
  async lockLine(
    lineId: string,
    client: PrismaTransactionClient,
  ): Promise<LockedStatementLine | null> {
    const rows = await client.$queryRaw<LockedLineRow[]>`
      SELECT
        id::text                  AS id,
        school_id::text           AS school_id,
        import_id::text           AS import_id,
        line_number,
        amount::text              AS amount,
        currency,
        direction,
        match_status,
        matched_payment_id::text  AS matched_payment_id,
        narrative,
        reference,
        version
      FROM bank_statement_lines
      WHERE id = ${lineId}::uuid
      FOR UPDATE
    `;

    const row = rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      schoolId: row.school_id,
      importId: row.import_id,
      lineNumber: row.line_number,
      amount: row.amount,
      currency: row.currency,
      direction: row.direction,
      matchStatus: row.match_status,
      matchedPaymentId: row.matched_payment_id,
      narrative: row.narrative,
      reference: row.reference,
      version: row.version,
    };
  },

  /**
   * Record a decision about a line, but only from one of `fromStatuses`.
   *
   * Returns the number of rows changed. Zero means somebody else decided it first, and the
   * caller must treat its own view as stale rather than retry blindly.
   */
  async attributeLine(
    args: {
      readonly lineId: string;
      readonly fromStatuses: readonly StatementLineMatchStatus[];
      readonly expectedVersion?: number | undefined;
    },
    data: {
      readonly matchStatus: StatementLineMatchStatus;
      readonly matchedPaymentId?: string | null;
      readonly matchedByUserId?: string | null;
      readonly matchedAt?: Date | null;
      readonly matchNote?: string | null;
    },
    client: PrismaTransactionClient,
  ): Promise<number> {
    const result = await client.bankStatementLine.updateMany({
      where: {
        id: args.lineId,
        matchStatus: { in: [...args.fromStatuses] },
        ...(args.expectedVersion !== undefined ? { version: args.expectedVersion } : {}),
      },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count;
  },

  /** The statement line already attributed to a payment, if any. */
  async findLineForPayment(paymentId: string): Promise<StatementLineRecord | null> {
    return prisma.bankStatementLine.findFirst({
      where: { matchedPaymentId: paymentId },
      select: LINE_PROJECTION,
    });
  },

  /* -------------------------------------------------------------- candidates */

  /**
   * Payments a statement line could belong to.
   *
   * Scoped to payments that have not been cancelled or failed and are not already
   * attributed to another line. A cancelled payment cannot be what arrived, and a payment
   * already matched elsewhere would be a double credit waiting to happen.
   */
  async findCandidatePayments(
    scope: AccessScope,
    args: {
      readonly currency: string;
      readonly provider?: PaymentProviderKey | undefined;
      /** Widen or narrow the window around the value date, in days. */
      readonly from?: Date | undefined;
      readonly to?: Date | undefined;
    },
  ): Promise<CandidatePaymentRecord[]> {
    return prisma.payment.findMany({
      where: {
        ...scope.filter,
        currency: args.currency,
        status: { in: ['PENDING', 'PROCESSING', 'REQUIRES_REVIEW', 'SUCCESSFUL'] },
        statementLines: { none: {} },
        ...(args.from !== undefined || args.to !== undefined
          ? {
              initiatedAt: {
                ...(args.from !== undefined ? { gte: args.from } : {}),
                ...(args.to !== undefined ? { lte: args.to } : {}),
              },
            }
          : {}),
      },
      select: CANDIDATE_PROJECTION,
      orderBy: [{ initiatedAt: 'desc' }],
      // A statement line has a handful of plausible candidates, not hundreds. The cap
      // keeps a mis-specified filter from loading a term's payments into memory.
      take: 200,
    });
  },

  async findPaymentForMatch(paymentId: string): Promise<CandidatePaymentRecord | null> {
    return prisma.payment.findUnique({ where: { id: paymentId }, select: CANDIDATE_PROJECTION });
  },

  /* ---------------------------------------------------------------- summary */

  /** Line counts and totals by decision, computed by the database. */
  async summariseLines(
    scope: AccessScope,
    filters: StatementLineFilters,
  ): Promise<
    Array<{ matchStatus: StatementLineMatchStatus; count: number; total: string; currency: string }>
  > {
    const grouped = await prisma.bankStatementLine.groupBy({
      by: ['matchStatus', 'currency'],
      where: { ...buildLineWhere(scope, filters), direction: 'MONEY_IN' },
      _count: { _all: true },
      _sum: { amount: true },
    });

    return grouped.map((row) => ({
      matchStatus: row.matchStatus,
      count: row._count._all,
      total: (row._sum.amount ?? 0).toString(),
      currency: row.currency,
    }));
  },

  /**
   * Payments still awaiting verification that no statement line has been matched to.
   *
   * The other half of reconciliation. A school that only looked at unattributed statement
   * lines would never notice a claim the bank has no record of, which is the shape a
   * forged or mistaken claim takes.
   */
  async summariseUnreconciledPayments(
    scope: AccessScope,
    args: { from?: Date | undefined; to?: Date | undefined },
  ): Promise<{ count: number; total: string }> {
    const where: Prisma.PaymentWhereInput = {
      ...scope.filter,
      status: { in: ['PENDING', 'PROCESSING', 'REQUIRES_REVIEW'] },
      statementLines: { none: {} },
      ...(args.from !== undefined || args.to !== undefined
        ? {
            initiatedAt: {
              ...(args.from !== undefined ? { gte: args.from } : {}),
              ...(args.to !== undefined ? { lte: args.to } : {}),
            },
          }
        : {}),
    };

    const [count, sum] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.aggregate({ where, _sum: { amount: true } }),
    ]);

    return { count, total: (sum._sum.amount ?? 0).toString() };
  },

  async countLinesByStatus(importId: string): Promise<Record<StatementLineMatchStatus, number>> {
    const grouped = await prisma.bankStatementLine.groupBy({
      by: ['matchStatus'],
      where: { importId },
      _count: { _all: true },
    });

    const counts: Record<StatementLineMatchStatus, number> = {
      UNMATCHED: 0,
      MATCHED: 0,
      IGNORED: 0,
      AMBIGUOUS: 0,
    };
    for (const row of grouped) counts[row.matchStatus] = row._count._all;
    return counts;
  },
} as const;

export type ReconciliationRepository = typeof reconciliationRepository;
