/**
 * Discounts, scholarship awards, waivers and authorised adjustments.
 *
 * Four tables, because the formal data model keeps them distinct and because the
 * questions asked of them differ — "what did this bursary cost us?" is a scholarship
 * question and has no meaning for a waiver. One workflow, because the *control* over
 * them is identical: requested by one person, approved by another, never editing the
 * charge, always leaving a trail.
 *
 * What is load-bearing here:
 *
 *  - **Nothing modifies the charge.** The original obligation stays exactly as raised.
 *    Relief sits beside it and posts a ledger entry, which is what lets a balance be
 *    explained line by line years later (Sections 14, 16, 20).
 *  - **Approval is what moves money.** A pending request has posted nothing. Approving
 *    posts a CREDIT (or, for a debiting adjustment, a DEBIT); rejecting posts nothing.
 *  - **Requesting and approving are different permissions.** A Bursar holds
 *    `adjustment.request`; only a Finance Manager holds `adjustment.approve`.
 *  - **Nobody approves their own request**, regardless of permissions. A Finance Manager
 *    holds both, and would otherwise be a single point of authorisation for money
 *    leaving the ledger.
 *  - **A reversal is a new fact.** The record stays APPROVED-then-REVERSED and an
 *    opposing entry is posted. The original decision and its approver remain visible.
 *  - **The amount is frozen at request and re-checked at approval**, so what is approved
 *    is what was reviewed, even if the charge collected other relief in between.
 */
import {
  type AdjustmentMethodValue,
  type ApprovalState,
  type CurrencyCode,
  type EntryDirectionValue,
  ErrorCode,
  Money,
  type ReliefKind,
  type ReliefSummary,
  type ScholarshipSummary,
} from '@sfs/shared';

import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { academicRepository } from '../academic/academic.repository.js';
import { AuditAction, AuditEntity, reliefEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { getRemainingChargeValue } from './balance.service.js';
import {
  type AdjustmentRecord,
  type DiscountRecord,
  feeRepository,
  type ReliefFilters,
  type ScholarshipAwardRecord,
  type ScholarshipRecord,
  type WaiverRecord,
} from './fee.repository.js';
import type {
  CancelReliefBody,
  CreateScholarshipBody,
  DecideReliefBody,
  RequestReliefBody,
  ReverseReliefBody,
  UpdateScholarshipBody,
} from './fee.schema.js';
import { type EntrySourceRef, postEntry, reverseEntryFor } from './ledger.service.js';

/* ------------------------------------------------------------- projections */

type AnyReliefRecord = DiscountRecord | ScholarshipAwardRecord | WaiverRecord | AdjustmentRecord;

function hasMethod(relief: AnyReliefRecord): relief is DiscountRecord | ScholarshipAwardRecord {
  return 'method' in relief;
}

function directionOf(kind: ReliefKind, relief: AnyReliefRecord): EntryDirectionValue {
  if (kind !== 'ADJUSTMENT') return 'CREDIT';
  return (relief as AdjustmentRecord).direction;
}

function toSummary(kind: ReliefKind, relief: AnyReliefRecord): ReliefSummary {
  const method: AdjustmentMethodValue = hasMethod(relief) ? relief.method : 'FIXED';
  const status: ApprovalState = relief.status;
  const award = kind === 'SCHOLARSHIP' ? (relief as ScholarshipAwardRecord) : null;

  return {
    id: relief.id,
    kind,
    direction: directionOf(kind, relief),
    studentId: relief.studentId,
    studentNumber: relief.student.studentId,
    studentName: `${relief.student.firstName} ${relief.student.lastName}`,
    studentChargeId: relief.studentChargeId,
    chargeDescription: relief.studentCharge?.description ?? null,
    academicYearId: relief.academicYearId,
    termId: relief.termId,
    termName: relief.term?.name ?? null,
    method,
    percentage: hasMethod(relief) ? (relief.percentage?.toString() ?? null) : null,
    amount: Money.fromDatabase(relief.amount).toString(),
    scholarshipId: award?.scholarshipId ?? null,
    scholarshipName: award?.scholarship.name ?? null,
    reason: relief.reason,
    status,
    requestedByName: `${relief.requestedBy.firstName} ${relief.requestedBy.lastName}`,
    requestedAt: relief.requestedAt.toISOString(),
    decidedByName:
      relief.decidedBy === null
        ? null
        : `${relief.decidedBy.firstName} ${relief.decidedBy.lastName}`,
    decidedAt: relief.decidedAt?.toISOString() ?? null,
    decisionNote: relief.decisionNote,
    reversedAt: relief.reversedAt?.toISOString() ?? null,
    reversalReason: relief.reversalReason,
    version: relief.version,
  };
}

function toScholarshipSummary(scholarship: ScholarshipRecord): ScholarshipSummary {
  return {
    id: scholarship.id,
    code: scholarship.code,
    name: scholarship.name,
    description: scholarship.description,
    sponsor: scholarship.sponsor,
    defaultMethod: scholarship.defaultMethod,
    defaultPercentage: scholarship.defaultPercentage?.toString() ?? null,
    defaultAmount:
      scholarship.defaultAmount === null
        ? null
        : Money.fromDatabase(scholarship.defaultAmount).toString(),
    isActive: scholarship.isActive,
    awardCount: scholarship._count.awards,
    version: scholarship.version,
  };
}

async function currencyFor(schoolId: string): Promise<CurrencyCode> {
  return (await feeRepository.findSchoolCurrency(schoolId)) as CurrencyCode;
}

/* ------------------------------------------------------------- record access */

/** Load a relief record of a known kind, scope-checked. */
async function loadRelief(
  principal: Principal,
  kind: ReliefKind,
  id: string,
): Promise<AnyReliefRecord> {
  const relief = await (kind === 'DISCOUNT'
    ? feeRepository.findDiscountById(id)
    : kind === 'SCHOLARSHIP'
      ? feeRepository.findScholarshipAwardById(id)
      : kind === 'WAIVER'
        ? feeRepository.findWaiverById(id)
        : feeRepository.findAdjustmentById(id));

  principal.scope.assertPermits(relief, 'record');
  if (relief === null) throw new NotFoundError('The requested record was not found.');
  return relief;
}

/** The ledger reference for a record of a given kind. */
function refFor(kind: ReliefKind, id: string): EntrySourceRef {
  switch (kind) {
    case 'DISCOUNT':
      return { source: 'DISCOUNT', discountId: id };
    case 'SCHOLARSHIP':
      return { source: 'SCHOLARSHIP', studentScholarshipId: id };
    case 'WAIVER':
      return { source: 'WAIVER', feeWaiverId: id };
    case 'ADJUSTMENT':
      return { source: 'ADJUSTMENT', financialAdjustmentId: id };
  }
}

/* ------------------------------------------------------------ amount rules */

/**
 * Resolve what a request is worth, and check it fits.
 *
 * A percentage is taken against the charge's *remaining* value — what is left after
 * relief already approved — not its face value. Two 60% discounts on one charge would
 * otherwise total 120% of it.
 */
async function resolveAmount(
  input: RequestReliefBody,
  charge: { id: string; amount: string } | null,
  currency: CurrencyCode,
): Promise<{ amount: Money; percentage: string | null }> {
  if (input.percentage !== undefined) {
    if (charge === null) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'A percentage must name the charge it applies to, or there is nothing to take a percentage of.',
      );
    }
    const remaining = await getRemainingChargeValue(charge.id, charge.amount, currency);
    return {
      // prorate(pct, 100) rather than times(pct / 100): the division would reintroduce a
      // float exactly where the rounding has to be right.
      amount: remaining.prorate(input.percentage, 100),
      percentage: input.percentage,
    };
  }

  return { amount: Money.of(input.amount!, currency), percentage: null };
}

/**
 * Relief may not exceed what is left of the charge it targets.
 *
 * Only applies to charge-level credits. A student-level credit is not bounded by any one
 * charge, and a debiting adjustment adds rather than reduces, so neither is checked here
 * — an overshoot on those surfaces as a credit balance, which is modelled explicitly.
 */
async function assertFitsCharge(
  direction: EntryDirectionValue,
  amount: Money,
  charge: { id: string; amount: string } | null,
  currency: CurrencyCode,
): Promise<void> {
  if (charge === null || direction === 'DEBIT') return;

  const remaining = await getRemainingChargeValue(charge.id, charge.amount, currency);
  if (amount.greaterThan(remaining)) {
    throw new DomainError(
      ErrorCode.AMOUNT_EXCEEDS_BALANCE,
      `That is more than the charge still carries. ${remaining.format({ withCurrency: true })} remains after relief already approved against it.`,
    );
  }
}

/* ------------------------------------------------------------------ queries */

export async function listReliefs(
  principal: Principal,
  filters: ReliefFilters,
): Promise<readonly ReliefSummary[]> {
  const found = await feeRepository.listReliefs(principal.scope, filters);

  return [
    ...found.discounts.map((relief) => toSummary('DISCOUNT', relief)),
    ...found.scholarships.map((relief) => toSummary('SCHOLARSHIP', relief)),
    ...found.waivers.map((relief) => toSummary('WAIVER', relief)),
    ...found.adjustments.map((relief) => toSummary('ADJUSTMENT', relief)),
    // Newest first: an account is read from the most recent decision backwards.
  ].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function getRelief(
  principal: Principal,
  kind: ReliefKind,
  id: string,
): Promise<ReliefSummary> {
  return toSummary(kind, await loadRelief(principal, kind, id));
}

/* ----------------------------------------------------------------- commands */

/**
 * Request relief. Creates the record PENDING_APPROVAL; the ledger is untouched until a
 * Finance Manager approves it.
 */
export async function requestRelief(
  principal: Principal,
  kind: ReliefKind,
  input: RequestReliefBody,
): Promise<ReliefSummary> {
  const schoolId = principal.scope.requireSchoolId();
  const currency = await currencyFor(schoolId);

  const student = await feeRepository.findStudentIdentity(principal.scope, input.studentId);
  if (student === null) throw new NotFoundError('The requested student was not found.');

  let charge: { id: string; amount: string } | null = null;
  let academicYearId = input.academicYearId;
  let termId = input.termId ?? null;

  if (input.studentChargeId != null) {
    const found = await feeRepository.findChargeById(input.studentChargeId);
    principal.scope.assertPermits(found, 'charge');
    if (found === null) throw new NotFoundError('The requested charge was not found.');

    if (found.studentId !== input.studentId) {
      // Refused rather than silently corrected: a request naming another student's
      // charge is either a mistake or an attempt, and neither should be applied.
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That charge belongs to a different student.',
      );
    }
    if (found.status === 'VOID') {
      throw new DomainError(
        ErrorCode.PRECONDITION_FAILED,
        'That charge has been voided. There is nothing left to adjust.',
      );
    }

    charge = { id: found.id, amount: Money.fromDatabase(found.amount, currency).toString() };
    // The charge decides the period, so the two can never disagree.
    academicYearId = found.academicYearId;
    termId = found.termId;
  } else {
    const year = await academicRepository.findAcademicYear(principal.scope, academicYearId);
    if (year === null) throw new NotFoundError('That academic year was not found.');
    if (termId !== null) {
      const term = await academicRepository.findTerm(principal.scope, termId);
      if (term === null) throw new NotFoundError('That term was not found.');
      if (term.academicYearId !== academicYearId) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'That term belongs to a different academic year.',
        );
      }
    }
  }

  const direction: EntryDirectionValue =
    kind === 'ADJUSTMENT' ? (input.direction ?? 'CREDIT') : 'CREDIT';

  const resolved = await resolveAmount(input, charge, currency);
  if (!resolved.amount.isPositive()) {
    throw new DomainError(
      ErrorCode.INVALID_AMOUNT,
      'That works out to nothing. Check the charge and the percentage.',
    );
  }
  await assertFitsCharge(direction, resolved.amount, charge, currency);

  const common = {
    schoolId,
    studentId: input.studentId,
    studentChargeId: input.studentChargeId ?? null,
    academicYearId,
    termId,
    amount: resolved.amount.toString(),
    reason: input.reason,
    requestedByUserId: principal.userId,
  };

  const created = await (async (): Promise<AnyReliefRecord> => {
    switch (kind) {
      case 'DISCOUNT':
        return feeRepository.createDiscount({
          ...common,
          method: resolved.percentage === null ? 'FIXED' : 'PERCENTAGE',
          percentage: resolved.percentage,
        });
      case 'SCHOLARSHIP': {
        if (input.scholarshipId === undefined) {
          throw new DomainError(
            ErrorCode.VALIDATION_FAILED,
            'A scholarship award must name the scholarship it is awarded under.',
          );
        }
        const scholarship = await feeRepository.findScholarshipById(input.scholarshipId);
        principal.scope.assertPermits(scholarship, 'scholarship');
        if (scholarship === null) throw new NotFoundError('That scholarship was not found.');
        if (!scholarship.isActive) {
          throw new DomainError(
            ErrorCode.VALIDATION_FAILED,
            `The scholarship "${scholarship.name}" is no longer active and cannot be awarded.`,
          );
        }
        return feeRepository.createScholarshipAward({
          ...common,
          scholarshipId: input.scholarshipId,
          method: resolved.percentage === null ? 'FIXED' : 'PERCENTAGE',
          percentage: resolved.percentage,
        });
      }
      case 'WAIVER':
        return feeRepository.createWaiver(common);
      case 'ADJUSTMENT':
        return feeRepository.createAdjustment({
          ...common,
          direction: direction,
        });
    }
  })();

  await record({
    action: AuditAction.RELIEF_REQUESTED,
    entityType: reliefEntity(kind),
    entityId: created.id,
    reason: input.reason,
    afterState: {
      kind,
      direction,
      studentId: input.studentId,
      studentChargeId: input.studentChargeId ?? null,
      percentage: resolved.percentage,
      amount: resolved.amount.toString(),
      status: created.status,
    },
  });

  return toSummary(kind, created);
}

/**
 * Approve or reject a request.
 *
 * Approval is the moment money moves: the status change and the ledger entry happen in
 * one transaction, so a failure cannot leave an approved record with no entry behind it —
 * which would be relief that everyone believes was granted and that no balance reflects.
 */
export async function decideRelief(
  principal: Principal,
  kind: ReliefKind,
  id: string,
  input: DecideReliefBody,
): Promise<ReliefSummary> {
  const relief = await loadRelief(principal, kind, id);

  if (relief.status !== 'PENDING_APPROVAL') {
    throw new ConflictError(
      `That request is already ${relief.status.toLowerCase().replace(/_/g, ' ')}.`,
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }

  if (relief.requestedByUserId === principal.userId) {
    throw new ForbiddenError(
      'You requested this, so you cannot also approve it. It needs a second Finance Manager.',
      ErrorCode.AUTHORISATION_REQUIRED,
    );
  }

  const currency = await currencyFor(relief.schoolId);
  const direction = directionOf(kind, relief);
  const amount = Money.fromDatabase(relief.amount, currency);
  const approved = input.decision === 'APPROVE';

  if (approved && relief.studentChargeId !== null) {
    // Re-checked at the moment of approval. Between request and decision the charge may
    // have collected other approved relief, and approving into an overdrawn charge would
    // put the student into a credit balance nobody authorised.
    const charge = await feeRepository.findChargeById(relief.studentChargeId);
    if (charge === null || charge.status === 'VOID') {
      throw new ConflictError(
        'The charge this applies to has been voided. Reject this request instead.',
        ErrorCode.PRECONDITION_FAILED,
      );
    }
    await assertFitsCharge(
      direction,
      amount,
      { id: charge.id, amount: Money.fromDatabase(charge.amount, currency).toString() },
      currency,
    );
  }

  await prisma.$transaction(async (tx) => {
    await feeRepository.transitionRelief(
      kind,
      id,
      { expectedVersion: input.expectedVersion, fromStatus: 'PENDING_APPROVAL' },
      {
        status: approved ? 'APPROVED' : 'REJECTED',
        decidedByUserId: principal.userId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      },
      tx,
    );

    if (approved) {
      await postEntry(
        {
          schoolId: relief.schoolId,
          studentId: relief.studentId,
          academicYearId: relief.academicYearId,
          termId: relief.termId,
          entryType: direction,
          amount,
          description: describeEntry(kind, relief),
          ref: refFor(kind, id),
          postedByUserId: principal.userId,
          studentChargeId: relief.studentChargeId,
        },
        tx,
      );
    }

    await record(
      {
        action: approved ? AuditAction.RELIEF_APPROVED : AuditAction.RELIEF_REJECTED,
        entityType: reliefEntity(kind),
        entityId: id,
        ...(input.note !== undefined ? { reason: input.note } : {}),
        beforeState: { status: relief.status },
        afterState: {
          kind,
          status: approved ? 'APPROVED' : 'REJECTED',
          decidedByUserId: principal.userId,
          direction,
          amount: amount.toString(),
          ledgerEntryPosted: approved,
        },
      },
      tx,
    );
  });

  return toSummary(kind, await loadRelief(principal, kind, id));
}

/** What the ledger line says on a statement. */
function describeEntry(kind: ReliefKind, relief: AnyReliefRecord): string {
  const against =
    relief.studentCharge?.description === undefined
      ? ''
      : ` against ${relief.studentCharge.description}`;

  switch (kind) {
    case 'DISCOUNT':
      return `Discount${against}`;
    case 'SCHOLARSHIP':
      return `${(relief as ScholarshipAwardRecord).scholarship.name}${against}`;
    case 'WAIVER':
      return `Waiver${against}`;
    case 'ADJUSTMENT':
      return `Adjustment${against}`;
  }
}

/** Withdraw your own request before anyone has decided on it. */
export async function cancelRelief(
  principal: Principal,
  kind: ReliefKind,
  id: string,
  input: CancelReliefBody,
): Promise<ReliefSummary> {
  const relief = await loadRelief(principal, kind, id);

  if (relief.status !== 'PENDING_APPROVAL') {
    throw new ConflictError(
      'Only a request still awaiting approval can be cancelled.',
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }
  if (relief.requestedByUserId !== principal.userId) {
    throw new ForbiddenError(
      'Only the person who made a request can cancel it. Reject it instead.',
    );
  }

  await feeRepository.transitionRelief(
    kind,
    id,
    { expectedVersion: input.expectedVersion, fromStatus: 'PENDING_APPROVAL' },
    { status: 'CANCELLED' },
  );

  await record({
    action: AuditAction.RELIEF_CANCELLED,
    entityType: reliefEntity(kind),
    entityId: id,
    beforeState: { status: relief.status },
    afterState: { kind, status: 'CANCELLED' },
  });

  return toSummary(kind, await loadRelief(principal, kind, id));
}

/**
 * Reverse approved relief.
 *
 * The record stays APPROVED-then-REVERSED rather than reverting to pending or being
 * deleted: the decision was really made, by a named person, and a balance that changed
 * twice should say so both times (Section 20). An opposing ledger entry is posted in the
 * same transaction.
 */
export async function reverseRelief(
  principal: Principal,
  kind: ReliefKind,
  id: string,
  input: ReverseReliefBody,
): Promise<ReliefSummary> {
  const relief = await loadRelief(principal, kind, id);

  if (relief.status !== 'APPROVED') {
    throw new ConflictError(
      'Only approved relief can be reversed.',
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }

  await prisma.$transaction(async (tx) => {
    await feeRepository.transitionRelief(
      kind,
      id,
      { expectedVersion: input.expectedVersion, fromStatus: 'APPROVED' },
      {
        status: 'REVERSED',
        reversedByUserId: principal.userId,
        reversedAt: new Date(),
        reversalReason: input.reason,
      },
      tx,
    );

    const reversed = await reverseEntryFor(
      refFor(kind, id),
      {
        description: `Reversal of ${describeEntry(kind, relief).toLowerCase()}`,
        postedByUserId: principal.userId,
      },
      tx,
    );

    await record(
      {
        action: AuditAction.RELIEF_REVERSED,
        entityType: reliefEntity(kind),
        entityId: id,
        reason: input.reason,
        beforeState: {
          status: relief.status,
          amount: Money.fromDatabase(relief.amount).toString(),
        },
        afterState: {
          kind,
          status: 'REVERSED',
          reversedByUserId: principal.userId,
          ledgerEntryPosted: reversed,
        },
      },
      tx,
    );
  });

  return toSummary(kind, await loadRelief(principal, kind, id));
}

/* --------------------------------------------------- scholarship programmes */

export async function listScholarships(
  principal: Principal,
  options: { includeInactive: boolean },
): Promise<readonly ScholarshipSummary[]> {
  const scholarships = await feeRepository.listScholarships(principal.scope, options);
  return scholarships.map(toScholarshipSummary);
}

export async function getScholarship(
  principal: Principal,
  scholarshipId: string,
): Promise<ScholarshipSummary> {
  const scholarship = await feeRepository.findScholarshipById(scholarshipId);
  principal.scope.assertPermits(scholarship, 'scholarship');
  if (scholarship === null) throw new NotFoundError('The requested scholarship was not found.');
  return toScholarshipSummary(scholarship);
}

export async function createScholarship(
  principal: Principal,
  input: CreateScholarshipBody,
): Promise<ScholarshipSummary> {
  const schoolId = principal.scope.requireSchoolId();

  const existing = await feeRepository.findScholarshipByCode(schoolId, input.code);
  if (existing !== null) {
    throw new ConflictError(
      `A scholarship with the code ${input.code} already exists.`,
      ErrorCode.DUPLICATE_RESOURCE,
    );
  }

  const created = await feeRepository.createScholarship({
    schoolId,
    code: input.code,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.sponsor !== undefined ? { sponsor: input.sponsor } : {}),
    defaultMethod: input.defaultPercentage !== undefined ? 'PERCENTAGE' : 'FIXED',
    defaultPercentage: input.defaultPercentage ?? null,
    defaultAmount: input.defaultAmount ?? null,
  });

  await record({
    action: AuditAction.SCHOLARSHIP_CREATED,
    entityType: AuditEntity.SCHOLARSHIP,
    entityId: created.id,
    afterState: { code: created.code, name: created.name, sponsor: created.sponsor },
  });

  return toScholarshipSummary(created);
}

/**
 * Edit a scholarship programme.
 *
 * The code is not editable, for the same reason a fee category's is not: it is the
 * identifier reports and imports use. Deactivation is the supported way to retire a
 * programme, including one that has already made awards — those awards keep naming it.
 */
export async function updateScholarship(
  principal: Principal,
  scholarshipId: string,
  input: UpdateScholarshipBody,
): Promise<ScholarshipSummary> {
  const current = await feeRepository.findScholarshipById(scholarshipId);
  principal.scope.assertPermits(current, 'scholarship');
  if (current === null) throw new NotFoundError('The requested scholarship was not found.');

  const updated = await feeRepository.updateScholarship(scholarshipId, input.expectedVersion, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.sponsor !== undefined ? { sponsor: input.sponsor } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.defaultPercentage !== undefined
      ? { defaultPercentage: input.defaultPercentage, defaultMethod: 'PERCENTAGE' as const }
      : {}),
    ...(input.defaultAmount !== undefined
      ? { defaultAmount: input.defaultAmount, defaultMethod: 'FIXED' as const }
      : {}),
  });

  await record({
    action: AuditAction.SCHOLARSHIP_UPDATED,
    entityType: AuditEntity.SCHOLARSHIP,
    entityId: scholarshipId,
    beforeState: { name: current.name, isActive: current.isActive },
    afterState: { name: updated.name, isActive: updated.isActive },
  });

  return toScholarshipSummary(updated);
}
