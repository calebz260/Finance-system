/**
 * Reconciliation: importing what the bank says, and attributing it to what the school
 * recorded.
 *
 * Phase 4 made the ledger the only source of a balance. Phase 5's payment path made a
 * credit possible only through verification. This module closes the loop: it compares the
 * school's own record of payments against the bank's record of money arriving, and makes
 * the difference visible in both directions.
 *
 *   statement lines nobody has attributed → money the school holds and cannot explain
 *   live payments with no statement line  → claims the bank has no record of
 *
 * A system that reported only the first would never notice a payment that was claimed and
 * never made; one that reported only the second would never notice money arriving for a
 * student nobody had credited.
 *
 * ## Importing
 *
 * Preview then commit, the same two-step as the student import and for the same reason: a
 * bursar sees every unreadable row against the row number on their screen before anything
 * is stored, and the commit is all-or-nothing (ADR-015).
 *
 * The file's SHA-256 is stored and is unique per school, so the same export cannot be
 * imported twice — which would otherwise double every line of a month's work.
 *
 * ## Matching
 *
 * The automatic pass attributes a line only when the payment's own reference is quoted on
 * it *and* the amounts are exactly equal. Everything else is a suggestion for a person.
 * The reasoning is in `matching.service.ts`; the short version is that a missed match
 * costs a minute and a wrong one credits the wrong family.
 *
 * ## Matching is a verification path
 *
 * A bursar who matches a line to a pending claim may credit it in the same action, with
 * the statement as the evidence — which is exactly what ADR-003 describes as manual
 * verification. It runs through `finalisePayment`, so the amount is re-compared, the
 * credit is posted in one transaction, and the same separation of duties applies: the
 * person who recorded a claim cannot be the one who confirms it against the statement.
 */
import { createHash } from 'node:crypto';

import {
  type CurrencyCode,
  ErrorCode,
  Money,
  type ReconciliationSummary,
  type StatementImportDetail,
  type StatementImportPreview,
  type StatementImportResult,
  type StatementImportSummary,
  type StatementLineSummary,
  type StatementMatchResult,
  type StatementMatchSuggestion,
  type StatementPreviewLine,
  PermissionKey,
} from '@sfs/shared';

import type {
  BankStatementDirection,
  StatementLineMatchStatus,
} from '../../generated/prisma/enums.js';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { feeRepository } from '../fees/fee.repository.js';
import { readSheet, SpreadsheetError } from '../imports/spreadsheet.js';
import { finalisePayment } from '../payments/payment.finalize.js';
import { toPaymentSummary } from '../payments/payment.presenter.js';
import { paymentRepository } from '../payments/payment.repository.js';
import { assertSeparationOfDuties } from '../payments/verification.service.js';
import { classifyLine, type MatchableLine } from './matching.service.js';
import {
  reconciliationRepository,
  type CandidatePaymentRecord,
  type StatementImportRecord,
  type StatementLineRecord,
} from './reconciliation.repository.js';
import type {
  ImportStatementFields,
  ListLinesQuery,
  MatchLineBody,
  IgnoreLineBody,
  UnmatchLineBody,
  ReconciliationSummaryQuery,
} from './reconciliation.schema.js';
import { parseStatement, type ParsedStatementLine } from './statement.parser.js';

const log = createLogger('reconciliation');

/** How many rows the preview reports individually. */
const PREVIEW_LINE_LIMIT = 200;

/**
 * How far either side of a statement line's value date to look for a payment.
 *
 * Generous on purpose. A parent pays on Friday, the bank values it on Monday, and a
 * school that only looked at the same day would find nothing. Widening the window costs a
 * longer suggestion list; narrowing it costs a match that should have been found.
 */
const CANDIDATE_WINDOW_DAYS = 30;

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** `YYYY-MM-DD`, which is how a date-only column crosses the API. */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- presenters */

function toLineSummary(line: StatementLineRecord): StatementLineSummary {
  const currency = line.currency as CurrencyCode;

  return {
    id: line.id,
    importId: line.importId,
    lineNumber: line.lineNumber,
    valueDate: toIsoDate(line.valueDate),
    narrative: line.narrative,
    reference: line.reference,
    amount: Money.fromDatabase(line.amount, currency).toString(),
    currency: line.currency,
    direction: line.direction,
    matchStatus: line.matchStatus,
    matchedPaymentId: line.matchedPaymentId,
    matchedPaymentReference: line.matchedPayment?.reference ?? null,
    matchedStudentName:
      line.matchedPayment === null
        ? null
        : `${line.matchedPayment.student.firstName} ${line.matchedPayment.student.lastName}`,
    matchedByName:
      line.matchedBy === null ? null : `${line.matchedBy.firstName} ${line.matchedBy.lastName}`,
    matchedAt: line.matchedAt?.toISOString() ?? null,
    matchNote: line.matchNote,
    version: line.version,
  };
}

async function toImportSummary(statement: StatementImportRecord): Promise<StatementImportSummary> {
  const counts = await reconciliationRepository.countLinesByStatus(statement.id);
  const currency = statement.currency as CurrencyCode;

  return {
    id: statement.id,
    provider: statement.provider,
    accountLabel: statement.accountLabel,
    fileName: statement.fileName,
    periodStart: statement.periodStart === null ? null : toIsoDate(statement.periodStart),
    periodEnd: statement.periodEnd === null ? null : toIsoDate(statement.periodEnd),
    lineCount: statement.lineCount,
    totalIn: Money.fromDatabase(statement.totalIn, currency).toString(),
    totalOut: Money.fromDatabase(statement.totalOut, currency).toString(),
    currency: statement.currency,
    importedByName: `${statement.importedBy.firstName} ${statement.importedBy.lastName}`,
    importedAt: statement.importedAt.toISOString(),
    notes: statement.notes,
    matchedCount: counts.MATCHED,
    unmatchedCount: counts.UNMATCHED,
    ignoredCount: counts.IGNORED,
    ambiguousCount: counts.AMBIGUOUS,
  };
}

function toSuggestion(candidate: {
  payment: CandidatePaymentRecord;
  reason: string;
  amountMatches: boolean;
}): StatementMatchSuggestion {
  const payment = candidate.payment;
  return {
    paymentId: payment.id,
    reference: payment.reference,
    studentId: payment.studentId,
    studentName: `${payment.student.firstName} ${payment.student.lastName}`,
    studentNumber: payment.student.studentId,
    amount: Money.fromDatabase(payment.amount, payment.currency as CurrencyCode).toString(),
    status: payment.status,
    payerName: payment.payerName,
    initiatedAt: payment.initiatedAt.toISOString(),
    reason: candidate.reason,
    amountMatches: candidate.amountMatches,
  };
}

/* ------------------------------------------------------------------ import */

interface UploadedStatement {
  readonly fileName: string;
  readonly buffer: Buffer;
}

/** Read and validate a file without storing anything. */
async function readAndParse(
  principal: Principal,
  file: UploadedStatement,
): Promise<{
  currency: CurrencyCode;
  lines: readonly ParsedStatementLine[];
  checksum: string;
}> {
  const schoolId = principal.scope.requireSchoolId();
  const currency = (await feeRepository.findSchoolCurrency(schoolId)) as CurrencyCode;

  let rows;
  try {
    rows = await readSheet({ fileName: file.fileName, buffer: file.buffer });
  } catch (error) {
    if (error instanceof SpreadsheetError) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, error.message, {
        ...(error.row !== undefined ? { details: { row: error.row } } : {}),
      });
    }
    throw error;
  }

  const parsed = parseStatement(rows, currency);
  if ('missingColumns' in parsed) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `That file is missing ${parsed.missingColumns.join(', ')}. Export the statement with ` +
        'its column headings and upload it again.',
      { details: { missingColumns: parsed.missingColumns } },
    );
  }

  return {
    currency,
    lines: parsed.lines,
    checksum: createHash('sha256').update(file.buffer).digest('hex'),
  };
}

function totalsOf(
  lines: readonly ParsedStatementLine[],
  currency: CurrencyCode,
): { totalIn: Money; totalOut: Money; moneyIn: number; moneyOut: number } {
  let totalIn = Money.zero(currency);
  let totalOut = Money.zero(currency);
  let moneyIn = 0;
  let moneyOut = 0;

  for (const line of lines) {
    if (line.errors.length > 0 || line.amount === null || line.direction === null) continue;
    const amount = Money.of(line.amount, currency);
    if (line.direction === 'MONEY_IN') {
      totalIn = totalIn.plus(amount);
      moneyIn += 1;
    } else {
      totalOut = totalOut.plus(amount);
      moneyOut += 1;
    }
  }

  return { totalIn, totalOut, moneyIn, moneyOut };
}

function periodOf(lines: readonly ParsedStatementLine[]): {
  start: Date | null;
  end: Date | null;
} {
  const dates = lines
    .filter((line) => line.errors.length === 0)
    .map((line) => line.valueDate)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return { start: dates[0] ?? null, end: dates.at(-1) ?? null };
}

function toPreviewLine(line: ParsedStatementLine): StatementPreviewLine {
  return {
    lineNumber: line.lineNumber,
    valueDate: line.valueDate === null ? null : toIsoDate(line.valueDate),
    narrative: line.narrative,
    reference: line.reference,
    amount: line.amount,
    direction: line.direction,
    errors: line.errors,
  };
}

/**
 * What importing this file would do. Writes nothing.
 *
 * Reports the file's own totals, so a bursar can check them against the figure printed on
 * the statement before importing. If those two disagree, the file was exported wrongly and
 * no amount of reconciliation afterwards will find the difference.
 */
export async function previewStatementImport(
  principal: Principal,
  file: UploadedStatement,
): Promise<StatementImportPreview> {
  const schoolId = principal.scope.requireSchoolId();
  const { currency, lines, checksum } = await readAndParse(principal, file);

  const valid = lines.filter((line) => line.errors.length === 0);
  const totals = totalsOf(lines, currency);
  const period = periodOf(lines);
  const existing = await reconciliationRepository.findImportByChecksum(schoolId, checksum);

  return {
    fileName: file.fileName,
    currency,
    totalRows: lines.length,
    validRows: valid.length,
    invalidRows: lines.length - valid.length,
    moneyInCount: totals.moneyIn,
    moneyOutCount: totals.moneyOut,
    totalIn: totals.totalIn.toString(),
    totalOut: totals.totalOut.toString(),
    periodStart: period.start === null ? null : toIsoDate(period.start),
    periodEnd: period.end === null ? null : toIsoDate(period.end),
    alreadyImported: existing !== null,
    lines: lines.slice(0, PREVIEW_LINE_LIMIT).map(toPreviewLine),
    linesTruncated: lines.length > PREVIEW_LINE_LIMIT,
  };
}

/**
 * Import a statement and run the automatic matching pass.
 *
 * Refuses a file with any unreadable row: a statement is a single document that has to
 * reconcile to its own total, and importing the readable nine-tenths of one would produce
 * a total that silently disagrees with the paper in the bursar's hand.
 */
export async function commitStatementImport(
  principal: Principal,
  file: UploadedStatement,
  fields: ImportStatementFields,
): Promise<StatementImportResult> {
  const schoolId = principal.scope.requireSchoolId();
  const { currency, lines, checksum } = await readAndParse(principal, file);

  const invalid = lines.filter((line) => line.errors.length > 0);
  if (invalid.length > 0) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `${String(invalid.length)} row(s) could not be read, so nothing was imported. Preview ` +
        'the file to see which, correct the export, and try again.',
      {
        details: {
          rows: invalid.slice(0, 20).map((line) => ({
            lineNumber: line.lineNumber,
            errors: line.errors,
          })),
        },
      },
    );
  }

  if (lines.length === 0) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'That file has no statement lines.');
  }

  const duplicate = await reconciliationRepository.findImportByChecksum(schoolId, checksum);
  if (duplicate !== null) {
    throw new ConflictError(
      `This exact file was already imported on ${duplicate.importedAt.toISOString().slice(0, 10)}. ` +
        'Importing it again would duplicate every line.',
      ErrorCode.DUPLICATE_RESOURCE,
      { details: { statementImportId: duplicate.id } },
    );
  }

  const totals = totalsOf(lines, currency);
  const period = periodOf(lines);

  // The candidates are read once for the whole file rather than per line: a month's
  // statement against a term's payments is one query, not two hundred.
  const candidates = await reconciliationRepository.findCandidatePayments(principal.scope, {
    currency,
    ...(period.start !== null ? { from: shiftDays(period.start, -CANDIDATE_WINDOW_DAYS) } : {}),
    ...(period.end !== null ? { to: shiftDays(period.end, CANDIDATE_WINDOW_DAYS) } : {}),
  });

  // Decided before the write, so the import transaction holds no logic that could fail
  // half way through. A payment claimed by an earlier line is withdrawn from the pool, so
  // two lines quoting one reference cannot both take it.
  const claimed = new Set<string>();
  const decisions: Array<{
    lineNumber: number;
    status: StatementLineMatchStatus;
    paymentId: string | null;
  }> = [];

  for (const line of lines) {
    const matchable: MatchableLine = {
      id: `${String(line.lineNumber)}`,
      narrative: line.narrative,
      reference: line.reference,
      amount: line.amount!,
      currency,
      valueDate: line.valueDate!,
    };

    const available = candidates.filter((payment) => !claimed.has(payment.id));
    const verdict = classifyLine(matchable, line.direction!, available);

    if (verdict.kind === 'AUTOMATIC') {
      claimed.add(verdict.paymentId);
      decisions.push({
        lineNumber: line.lineNumber,
        status: 'MATCHED',
        paymentId: verdict.paymentId,
      });
      continue;
    }

    decisions.push({
      lineNumber: line.lineNumber,
      status: verdict.kind === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNMATCHED',
      paymentId: null,
    });
  }

  const decisionByLine = new Map(decisions.map((decision) => [decision.lineNumber, decision]));

  const created = await prisma.$transaction(async (tx) => {
    const statement = await reconciliationRepository.createImportWithLines(
      {
        statement: {
          schoolId,
          provider: fields.provider,
          accountLabel: fields.accountLabel ?? null,
          fileName: file.fileName,
          checksum,
          periodStart: period.start,
          periodEnd: period.end,
          lineCount: lines.length,
          totalIn: totals.totalIn.toString(),
          totalOut: totals.totalOut.toString(),
          currency,
          importedByUserId: principal.userId,
          notes: fields.notes ?? null,
        },
        lines: lines.map((line) => {
          const decision = decisionByLine.get(line.lineNumber);
          return {
            schoolId,
            lineNumber: line.lineNumber,
            valueDate: line.valueDate!,
            narrative: line.narrative,
            reference: line.reference,
            amount: line.amount!,
            currency,
            direction: line.direction! satisfies BankStatementDirection,
            matchStatus: decision?.status ?? 'UNMATCHED',
            matchedPaymentId: decision?.paymentId ?? null,
            // Null actor: the automatic pass has no person behind it.
            matchedByUserId: null,
            matchedAt: decision?.paymentId != null ? new Date() : null,
          };
        }),
      },
      tx,
    );

    await record(
      {
        action: AuditAction.STATEMENT_IMPORTED,
        entityType: AuditEntity.BANK_STATEMENT_IMPORT,
        entityId: statement.id,
        schoolId,
        actorUserId: principal.userId,
        afterState: {
          fileName: file.fileName,
          provider: fields.provider,
          checksum,
          lineCount: lines.length,
          totalIn: totals.totalIn.toString(),
          totalOut: totals.totalOut.toString(),
          currency,
          automaticallyMatched: decisions.filter((decision) => decision.paymentId !== null).length,
          // Stated explicitly: importing a statement credits nothing by itself. The
          // automatic pass attributes lines; a credit still needs verification.
          ledgerEntryPosted: false,
        },
      },
      tx,
    );

    return statement;
  });

  const automaticallyMatched = decisions.filter((decision) => decision.paymentId !== null).length;
  const ambiguous = decisions.filter((decision) => decision.status === 'AMBIGUOUS').length;

  log.info(
    {
      statementImportId: created.id,
      fileName: file.fileName,
      lineCount: lines.length,
      automaticallyMatched,
      ambiguous,
    },
    'Bank statement imported',
  );

  const statement = await reconciliationRepository.findImportById(created.id);
  if (statement === null) {
    throw new NotFoundError('The statement could not be read back after being imported.');
  }

  return {
    statement: await toImportSummary(statement),
    automaticallyMatched,
    ambiguous,
  };
}

/* ------------------------------------------------------------------- reads */

export async function listStatementImports(
  principal: Principal,
  pagination: ResolvedPagination,
): Promise<{ items: readonly StatementImportSummary[]; totalItems: number }> {
  const result = await reconciliationRepository.listImports(principal.scope, pagination);
  const items = await Promise.all(result.items.map(toImportSummary));
  return { items, totalItems: result.totalItems };
}

/**
 * One statement, its lines, and what each unattributed line might belong to.
 *
 * Suggestions are computed here rather than stored, so a line whose candidate was verified
 * or cancelled since the import no longer offers it.
 */
export async function getStatementImport(
  principal: Principal,
  importId: string,
): Promise<StatementImportDetail> {
  const statement = await reconciliationRepository.findImportById(importId);
  principal.scope.assertPermits(statement, 'statement');
  if (statement === null) throw new NotFoundError('That statement was not found.');

  // One generous page: a month's statement is a few hundred lines, and a bursar works the
  // whole document rather than a page of it.
  const lines = await reconciliationRepository.listLines(
    principal.scope,
    { importId },
    { page: 1, pageSize: 1000, skip: 0, take: 1000 },
  );

  const suggestions = await suggestionsFor(principal, lines.items);

  return {
    statement: await toImportSummary(statement),
    lines: lines.items.map(toLineSummary),
    suggestions,
  };
}

/** The reconciliation worklist across every statement. */
export async function listStatementLines(
  principal: Principal,
  query: ListLinesQuery,
  pagination: ResolvedPagination,
): Promise<{
  items: readonly StatementLineSummary[];
  totalItems: number;
  suggestions: Readonly<Record<string, readonly StatementMatchSuggestion[]>>;
}> {
  const result = await reconciliationRepository.listLines(
    principal.scope,
    {
      ...(query.importId !== undefined ? { importId: query.importId } : {}),
      ...(query.matchStatus !== undefined ? { matchStatus: query.matchStatus } : {}),
      ...(query.direction !== undefined ? { direction: query.direction } : {}),
      ...(query.from !== undefined ? { from: new Date(`${query.from}T00:00:00.000Z`) } : {}),
      ...(query.to !== undefined ? { to: new Date(`${query.to}T00:00:00.000Z`) } : {}),
    },
    pagination,
  );

  return {
    items: result.items.map(toLineSummary),
    totalItems: result.totalItems,
    suggestions: await suggestionsFor(principal, result.items),
  };
}

/**
 * Candidate payments for each line still awaiting a decision.
 *
 * One candidate query for the whole page, reused across lines, because the alternative is
 * a query per line and a reconciliation screen that takes a second per row to open.
 */
async function suggestionsFor(
  principal: Principal,
  lines: readonly StatementLineRecord[],
): Promise<Readonly<Record<string, readonly StatementMatchSuggestion[]>>> {
  const open = lines.filter(
    (line) =>
      line.direction === 'MONEY_IN' &&
      (line.matchStatus === 'UNMATCHED' || line.matchStatus === 'AMBIGUOUS'),
  );
  if (open.length === 0) return {};

  const dates = open.map((line) => line.valueDate.getTime()).sort((a, b) => a - b);
  const currency = open[0]!.currency as CurrencyCode;

  const candidates = await reconciliationRepository.findCandidatePayments(principal.scope, {
    currency,
    from: shiftDays(new Date(dates[0]!), -CANDIDATE_WINDOW_DAYS),
    to: shiftDays(new Date(dates.at(-1)!), CANDIDATE_WINDOW_DAYS),
  });

  const suggestions: Record<string, readonly StatementMatchSuggestion[]> = {};

  for (const line of open) {
    const verdict = classifyLine(
      {
        id: line.id,
        narrative: line.narrative,
        reference: line.reference,
        amount: Money.fromDatabase(line.amount, currency).toString(),
        currency: line.currency,
        valueDate: line.valueDate,
      },
      line.direction,
      candidates,
    );

    const scored = verdict.kind === 'AUTOMATIC' ? [] : verdict.candidates;
    if (scored.length > 0) {
      // Five is as many as a person will read before deciding to search instead.
      suggestions[line.id] = scored.slice(0, 5).map(toSuggestion);
    }
  }

  return suggestions;
}

/** Where reconciliation stands, from both sides. */
export async function getReconciliationSummary(
  principal: Principal,
  query: ReconciliationSummaryQuery,
): Promise<ReconciliationSummary> {
  const schoolId = principal.scope.requireSchoolId();
  const currency = (await feeRepository.findSchoolCurrency(schoolId)) as CurrencyCode;

  const window = {
    ...(query.from !== undefined ? { from: new Date(`${query.from}T00:00:00.000Z`) } : {}),
    ...(query.to !== undefined ? { to: new Date(`${query.to}T00:00:00.000Z`) } : {}),
  };

  const [byStatus, payments] = await Promise.all([
    reconciliationRepository.summariseLines(principal.scope, {
      ...window,
      ...(query.importId !== undefined ? { importId: query.importId } : {}),
    }),
    reconciliationRepository.summariseUnreconciledPayments(principal.scope, window),
  ]);

  const counts: Record<StatementLineMatchStatus, number> = {
    UNMATCHED: 0,
    MATCHED: 0,
    IGNORED: 0,
    AMBIGUOUS: 0,
  };
  let matchedTotal = Money.zero(currency);
  let unmatchedTotal = Money.zero(currency);

  for (const row of byStatus) {
    counts[row.matchStatus] += row.count;
    const total = Money.of(row.total, currency);
    if (row.matchStatus === 'MATCHED') matchedTotal = matchedTotal.plus(total);
    else if (row.matchStatus !== 'IGNORED') unmatchedTotal = unmatchedTotal.plus(total);
  }

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    currency,
    statementLines: counts.MATCHED + counts.UNMATCHED + counts.IGNORED + counts.AMBIGUOUS,
    matchedLines: counts.MATCHED,
    unmatchedLines: counts.UNMATCHED,
    ambiguousLines: counts.AMBIGUOUS,
    ignoredLines: counts.IGNORED,
    matchedTotal: matchedTotal.toString(),
    unmatchedTotal: unmatchedTotal.toString(),
    unreconciledPayments: payments.count,
    unreconciledPaymentTotal: Money.of(payments.total, currency).toString(),
  };
}

/* ----------------------------------------------------------------- matching */

/**
 * Attribute a statement line to a payment, and optionally credit it.
 *
 * The amounts must be exactly equal. A line and a payment that differ are not the same
 * money, and the two available ways of pretending otherwise — crediting the smaller figure
 * or the larger — are both a decision about how much the family owes that nobody has
 * authorised (Section 20).
 */
export async function matchStatementLine(
  principal: Principal,
  lineId: string,
  input: MatchLineBody,
): Promise<StatementMatchResult> {
  const line = await reconciliationRepository.findLineById(lineId);
  principal.scope.assertPermits(line, 'statement line');
  if (line === null) throw new NotFoundError('That statement line was not found.');

  if (line.direction !== 'MONEY_IN') {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      'That line is money leaving the account, so it cannot be a student’s payment. Set it ' +
        'aside with a reason instead.',
    );
  }

  const payment = await reconciliationRepository.findPaymentForMatch(input.paymentId);
  principal.scope.assertPermits(payment, 'payment');
  if (payment === null) throw new NotFoundError('That payment was not found.');

  if (payment.status === 'CANCELLED' || payment.status === 'FAILED') {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      `That payment is ${payment.status.toLowerCase()}, so this line cannot belong to it.`,
    );
  }

  const currency = line.currency as CurrencyCode;
  if (payment.currency !== line.currency) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `The line is in ${line.currency} and the payment in ${payment.currency}. No conversion ` +
        'is applied.',
    );
  }

  const lineAmount = Money.fromDatabase(line.amount, currency);
  const paymentAmount = Money.fromDatabase(payment.amount, currency);

  if (!lineAmount.equals(paymentAmount)) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `The statement line is ${lineAmount.format({ withCurrency: true })} and the payment is ` +
        `${paymentAmount.format({ withCurrency: true })}. They are not the same money: hold the ` +
        'payment for review, or correct it, rather than matching them.',
      {
        details: { lineAmount: lineAmount.toString(), paymentAmount: paymentAmount.toString() },
      },
    );
  }

  const existing = await reconciliationRepository.findLineForPayment(payment.id);
  if (existing !== null && existing.id !== line.id) {
    throw new ConflictError(
      `That payment is already matched to line ${String(existing.lineNumber)} of another ` +
        'statement. Two lines for one payment would mean the money arrived twice.',
      ErrorCode.CONFLICT,
      { details: { statementLineId: existing.id } },
    );
  }

  const shouldCredit = input.confirmPayment === true;

  if (shouldCredit) {
    // Crediting through reconciliation is verification, so it needs the verification
    // permission as well as the reconciliation one, and the same separation of duties.
    if (!principal.permissions.has(PermissionKey.PAYMENT_VERIFY_MANUAL)) {
      throw new ForbiddenError(
        'You may match this line, but confirming the payment needs the verification ' +
          'permission.',
        ErrorCode.INSUFFICIENT_PERMISSION,
        { logContext: { lineId, paymentId: payment.id } },
      );
    }
    await assertSeparationOfDuties(principal, payment);
  }

  const matchedAt = new Date();

  // The default names the line and the bank's own description, which is what a person
  // reading the payment months later needs. It deliberately carries no import id: a UUID
  // in a verification note is unreadable to the bursar it is written for, and the payment
  // is joined to its statement line in the database anyway.
  const note =
    input.note ??
    `Matched to line ${String(line.lineNumber)} of the imported bank statement: ${line.narrative}`;

  await prisma.$transaction(async (tx) => {
    const locked = await reconciliationRepository.lockLine(lineId, tx);
    if (locked === null) throw new NotFoundError('That statement line was not found.');

    if (locked.matchStatus === 'MATCHED' && locked.matchedPaymentId !== payment.id) {
      throw new ConflictError(
        'Somebody attributed this line to a different payment while you were looking at it. ' +
          'Reload the statement.',
        ErrorCode.CONFLICT,
      );
    }

    const moved = await reconciliationRepository.attributeLine(
      {
        lineId,
        fromStatuses: ['UNMATCHED', 'AMBIGUOUS', 'MATCHED'],
        expectedVersion: input.expectedVersion,
      },
      {
        matchStatus: 'MATCHED',
        matchedPaymentId: payment.id,
        matchedByUserId: principal.userId,
        matchedAt,
        matchNote: input.note ?? null,
      },
      tx,
    );

    if (moved === 0) {
      throw new ConflictError(
        'This line was changed by someone else while you were looking at it. Reload the ' +
          'statement and try again.',
        ErrorCode.RECORD_MODIFIED,
        { logContext: { lineId, expectedVersion: input.expectedVersion } },
      );
    }

    await record(
      {
        action: AuditAction.STATEMENT_LINE_MATCHED,
        entityType: AuditEntity.BANK_STATEMENT_LINE,
        entityId: lineId,
        schoolId: line.schoolId,
        actorUserId: principal.userId,
        reason: input.note ?? null,
        beforeState: { matchStatus: line.matchStatus, matchedPaymentId: line.matchedPaymentId },
        afterState: {
          matchStatus: 'MATCHED',
          matchedPaymentId: payment.id,
          paymentReference: payment.reference,
          lineAmount: lineAmount.toString(),
          confirmRequested: shouldCredit,
        },
      },
      tx,
    );
  });

  let credited = false;
  let message = `Line ${String(line.lineNumber)} is attributed to ${payment.reference}.`;

  if (shouldCredit) {
    // Finalisation runs in its own transaction, deliberately after the attribution is
    // committed: if the credit is refused — a status that moved, a race lost — the
    // attribution still stands, which is the useful half of the work and is what a bursar
    // would otherwise have to redo.
    const outcome = await finalisePayment(payment.id, {
      source: 'USER',
      actorUserId: principal.userId,
      confirmedAmount: lineAmount.toString(),
      currency: line.currency,
      providerTransactionId: null,
      transactionId: null,
      note,
      externalReference: line.reference,
      metadata: { verifiedBy: 'statement_reconciliation', statementLineId: line.id },
    });

    credited = outcome.kind === 'CREDITED';

    switch (outcome.kind) {
      case 'CREDITED':
        message = `Line ${String(line.lineNumber)} is matched to ${payment.reference}, and the balance has been updated.`;
        break;
      case 'ALREADY_CREDITED':
        message = `Line ${String(line.lineNumber)} is matched to ${payment.reference}, which was already credited.`;
        break;
      case 'HELD_FOR_REVIEW':
        message = outcome.reason;
        break;
      case 'REJECTED':
        message = `Line ${String(line.lineNumber)} is matched to ${payment.reference}, but it could not be credited: ${outcome.reason}`;
        break;
    }
  }

  const [updatedLine, updatedPayment] = await Promise.all([
    reconciliationRepository.findLineById(lineId),
    paymentRepository.findPaymentById(payment.id),
  ]);

  log.info(
    { lineId, paymentId: payment.id, credited, actorUserId: principal.userId },
    'Statement line matched to a payment',
  );

  return {
    line: toLineSummary(updatedLine ?? line),
    payment: updatedPayment === null ? null : toPaymentSummary(updatedPayment),
    credited,
    message,
  };
}

/**
 * Withdraw an attribution.
 *
 * Refused once the payment has been credited. Detaching the statement line from a credit
 * would leave money on a student's account with nothing behind it; a credit that should not
 * have been made is undone by reversing the payment, which is a decision with its own
 * permission and its own ledger entry.
 */
export async function unmatchStatementLine(
  principal: Principal,
  lineId: string,
  input: UnmatchLineBody,
): Promise<StatementLineSummary> {
  const line = await reconciliationRepository.findLineById(lineId);
  principal.scope.assertPermits(line, 'statement line');
  if (line === null) throw new NotFoundError('That statement line was not found.');

  if (line.matchStatus !== 'MATCHED' || line.matchedPaymentId === null) {
    throw new ConflictError(
      'That line is not attributed to a payment.',
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }

  const payment = await paymentRepository.findPaymentById(line.matchedPaymentId);
  if (payment !== null && payment.status === 'SUCCESSFUL') {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      `${payment.reference} has already been credited on the strength of this line. Reverse the ` +
        'payment if it was wrong; unmatching it would leave the credit with nothing behind it.',
      { details: { paymentId: payment.id } },
    );
  }

  await prisma.$transaction(async (tx) => {
    const moved = await reconciliationRepository.attributeLine(
      { lineId, fromStatuses: ['MATCHED'], expectedVersion: input.expectedVersion },
      {
        matchStatus: 'UNMATCHED',
        matchedPaymentId: null,
        matchedByUserId: null,
        matchedAt: null,
        matchNote: input.reason,
      },
      tx,
    );

    if (moved === 0) {
      throw new ConflictError(
        'This line was changed by someone else while you were looking at it. Reload the ' +
          'statement and try again.',
        ErrorCode.RECORD_MODIFIED,
      );
    }

    await record(
      {
        action: AuditAction.STATEMENT_LINE_UNMATCHED,
        entityType: AuditEntity.BANK_STATEMENT_LINE,
        entityId: lineId,
        schoolId: line.schoolId,
        actorUserId: principal.userId,
        reason: input.reason,
        beforeState: { matchStatus: 'MATCHED', matchedPaymentId: line.matchedPaymentId },
        afterState: { matchStatus: 'UNMATCHED', matchedPaymentId: null },
      },
      tx,
    );
  });

  const updated = await reconciliationRepository.findLineById(lineId);
  return toLineSummary(updated ?? line);
}

/**
 * Set a line aside, with a reason.
 *
 * For the lines that are genuinely not a student's payment: a bank charge, a transfer
 * between the school's own accounts, interest, a duplicate row in the export. The reason is
 * required and kept, because "not ours" without one is indistinguishable from a line
 * somebody could not be bothered to match.
 */
export async function ignoreStatementLine(
  principal: Principal,
  lineId: string,
  input: IgnoreLineBody,
): Promise<StatementLineSummary> {
  const line = await reconciliationRepository.findLineById(lineId);
  principal.scope.assertPermits(line, 'statement line');
  if (line === null) throw new NotFoundError('That statement line was not found.');

  if (line.matchStatus === 'MATCHED') {
    throw new ConflictError(
      'That line is attributed to a payment. Withdraw the attribution before setting it aside.',
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }

  await prisma.$transaction(async (tx) => {
    const moved = await reconciliationRepository.attributeLine(
      {
        lineId,
        fromStatuses: ['UNMATCHED', 'AMBIGUOUS', 'IGNORED'],
        expectedVersion: input.expectedVersion,
      },
      {
        matchStatus: 'IGNORED',
        matchedPaymentId: null,
        matchedByUserId: principal.userId,
        matchedAt: null,
        matchNote: input.reason,
      },
      tx,
    );

    if (moved === 0) {
      throw new ConflictError(
        'This line was changed by someone else while you were looking at it. Reload the ' +
          'statement and try again.',
        ErrorCode.RECORD_MODIFIED,
      );
    }

    await record(
      {
        action: AuditAction.STATEMENT_LINE_IGNORED,
        entityType: AuditEntity.BANK_STATEMENT_LINE,
        entityId: lineId,
        schoolId: line.schoolId,
        actorUserId: principal.userId,
        reason: input.reason,
        beforeState: { matchStatus: line.matchStatus },
        afterState: { matchStatus: 'IGNORED' },
      },
      tx,
    );
  });

  const updated = await reconciliationRepository.findLineById(lineId);
  return toLineSummary(updated ?? line);
}

/** The uploaded file, or a refusal a bursar can act on. */
export function requireStatementFile(file: {
  originalname?: string;
  buffer?: Buffer;
}): UploadedStatement {
  if (file.buffer === undefined || file.originalname === undefined) {
    throw new ValidationError('Attach the statement as a .csv or .xlsx file in the "file" field.');
  }
  return { fileName: file.originalname, buffer: file.buffer };
}
