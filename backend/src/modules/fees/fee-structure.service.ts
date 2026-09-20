/**
 * Fee structures: what the school charges, and to whom.
 *
 * A structure is a template, never an obligation, and the rules here exist to keep that
 * distinction honest over time:
 *
 *  - **A structure that has raised charges is locked.** Not soft-locked: its items
 *    cannot be added to, edited or removed, and its applicability was immutable from
 *    creation. A structure that could be rewritten afterwards would make every charge
 *    raised from it unexplainable — "this student was charged 150,000 from a structure
 *    that now says 120,000" is exactly the ambiguity Section 12 forbids.
 *  - **Only a DRAFT structure is editable.** Publishing is the deliberate step that
 *    makes it usable for generation.
 *  - **Archiving withdraws, it does not delete.** Historical charges point at it.
 *  - **Applicability is validated against the academic structure**, so a structure
 *    cannot name a level from another school or a term from a different year.
 */
import {
  ErrorCode,
  type FeeStructureItemSummary,
  type FeeStructureSummary,
  Money,
  type ResidencyValue,
} from '@sfs/shared';

import { ConflictError, DomainError, NotFoundError } from '../../lib/errors.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { academicRepository } from '../academic/academic.repository.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import {
  feeRepository,
  type FeeStructureFilters,
  type FeeStructureItemRecord,
  type FeeStructureRecord,
} from './fee.repository.js';
import type {
  AddStructureItemBody,
  ChangeStructureStatusBody,
  CreateStructureBody,
  UpdateStructureBody,
  UpdateStructureItemBody,
} from './fee.schema.js';

/* ---------------------------------------------------------------- projection */

function toItemSummary(item: FeeStructureItemRecord): FeeStructureItemSummary {
  return {
    id: item.id,
    feeCategoryId: item.feeCategoryId,
    feeCategoryCode: item.feeCategory.code,
    feeCategoryName: item.feeCategory.name,
    label: item.label,
    amount: Money.fromDatabase(item.amount).toString(),
    sortOrder: item.sortOrder,
  };
}

function toSummary(structure: FeeStructureRecord): FeeStructureSummary {
  const items = structure.items.map(toItemSummary);
  const residency: ResidencyValue | null = structure.residency;

  return {
    id: structure.id,
    name: structure.name,
    description: structure.description,
    academicYearId: structure.academicYearId,
    academicYearName: structure.academicYear.name,
    termId: structure.termId,
    termName: structure.term?.name ?? null,
    programId: structure.programId,
    programName: structure.program?.name ?? null,
    levelId: structure.levelId,
    levelName: structure.level?.name ?? null,
    classSectionId: structure.classSectionId,
    classSectionName: structure.classSection?.name ?? null,
    residency,
    status: structure.status,
    items,
    // Summed through Money rather than with `reduce((a, b) => a + b)`: the totals on
    // this screen are read as the price of a term, and a float total would be wrong in
    // the second decimal place exactly where anyone would notice.
    totalAmount: Money.sum(items.map((item) => Money.of(item.amount))).toString(),
    chargeCount: structure._count.charges,
    version: structure.version,
  };
}

/* ----------------------------------------------------------------- guards */

async function loadStructure(
  principal: Principal,
  structureId: string,
): Promise<FeeStructureRecord> {
  const structure = await feeRepository.findStructureById(structureId);
  principal.scope.assertPermits(structure, 'fee structure');
  if (structure === null) throw new NotFoundError('The requested fee structure was not found.');
  return structure;
}

/**
 * Refuse any edit to a structure that is no longer a draft, or that has already raised
 * charges.
 *
 * Both conditions are checked, not one: a structure can be ACTIVE with no charges yet
 * (still safe to withdraw and redraft) and the charge count is what makes the lock
 * permanent.
 */
function assertEditable(structure: FeeStructureRecord): void {
  if (structure._count.charges > 0) {
    throw new ConflictError(
      `This fee structure has already raised ${String(structure._count.charges)} charge(s) and can no longer be changed. ` +
        'Archive it and create a replacement, so the charges already raised stay explainable.',
      ErrorCode.CONFLICT,
    );
  }
  if (structure.status !== 'DRAFT') {
    throw new ConflictError(
      'Only a draft fee structure can be edited. Archive this one and create a replacement.',
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }
}

/**
 * Check that every applicability reference exists inside the caller's school, and that
 * the period is coherent.
 *
 * Doing this here rather than relying on foreign keys is what produces a useful message:
 * a raw FK violation says "insert or update violates foreign key constraint", which
 * tells a school administrator nothing about which field they got wrong.
 */
async function validateApplicability(
  principal: Principal,
  input: {
    academicYearId: string;
    termId?: string | null | undefined;
    programId?: string | null | undefined;
    levelId?: string | null | undefined;
    classSectionId?: string | null | undefined;
  },
): Promise<void> {
  const year = await academicRepository.findAcademicYear(principal.scope, input.academicYearId);
  if (year === null) throw new NotFoundError('That academic year was not found.');
  if (year.status === 'CLOSED') {
    throw new DomainError(
      ErrorCode.PERIOD_CLOSED,
      'That academic year is closed. A new fee structure cannot be added to a period that has been signed off.',
    );
  }

  if (input.termId != null) {
    const term = await academicRepository.findTerm(principal.scope, input.termId);
    if (term === null) throw new NotFoundError('That term was not found.');
    if (term.academicYearId !== input.academicYearId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That term belongs to a different academic year.',
      );
    }
    if (term.status === 'CLOSED') {
      throw new DomainError(
        ErrorCode.PERIOD_CLOSED,
        'That term is closed. A new fee structure cannot be added to it.',
      );
    }
  }

  if (input.levelId != null) {
    const level = await academicRepository.findLevel(principal.scope, input.levelId);
    if (level === null) throw new NotFoundError('That level was not found.');

    if (input.programId != null && level.programId !== input.programId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That level does not belong to the programme named on this structure.',
      );
    }
  }

  if (input.classSectionId != null) {
    const classSection = await academicRepository.findClassSection(
      principal.scope,
      input.classSectionId,
    );
    if (classSection === null) throw new NotFoundError('That class was not found.');

    // The database enforces "a class implies a level"; this check is the one that says
    // *which* level, and catches a class from a different level being pasted in.
    if (input.levelId != null && classSection.levelId !== input.levelId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That class does not belong to the level named on this structure.',
      );
    }
    if (classSection.academicYearId !== input.academicYearId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'That class belongs to a different academic year.',
      );
    }
  }

  if (input.programId != null) {
    const program = await academicRepository.findProgram(principal.scope, input.programId);
    if (program === null) throw new NotFoundError('That programme was not found.');
  }
}

/** Every referenced category must exist, belong to the school, and still be active. */
async function validateCategories(
  principal: Principal,
  categoryIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(categoryIds)];
  if (unique.length !== categoryIds.length) {
    throw new DomainError(
      ErrorCode.DUPLICATE_RESOURCE,
      'A fee structure cannot charge the same category twice. Combine them into one line.',
    );
  }

  for (const categoryId of unique) {
    const category = await feeRepository.findCategoryById(categoryId);
    principal.scope.assertPermits(category, 'fee category');
    if (category === null) throw new NotFoundError('That fee category was not found.');
    if (!category.isActive) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `The fee category "${category.name}" is inactive and cannot be added to a new structure.`,
      );
    }
  }
}

/* ---------------------------------------------------------------- commands */

export async function listFeeStructures(
  principal: Principal,
  filters: FeeStructureFilters,
  pagination: ResolvedPagination,
): Promise<{ items: readonly FeeStructureSummary[]; totalItems: number }> {
  const result = await feeRepository.listStructures(principal.scope, filters, pagination);
  return { items: result.items.map(toSummary), totalItems: result.totalItems };
}

export async function getFeeStructure(
  principal: Principal,
  structureId: string,
): Promise<FeeStructureSummary> {
  return toSummary(await loadStructure(principal, structureId));
}

/**
 * Create a structure and its items together.
 *
 * One transaction: a structure with no items is not a usable half-result, it is a
 * configuration that would generate nothing and look like a bug.
 */
export async function createFeeStructure(
  principal: Principal,
  input: CreateStructureBody,
): Promise<FeeStructureSummary> {
  const schoolId = principal.scope.requireSchoolId();

  await validateApplicability(principal, input);
  await validateCategories(
    principal,
    input.items.map((item) => item.feeCategoryId),
  );

  const structure = await prisma.$transaction(async (tx) => {
    const created = await feeRepository.createStructure(
      {
        schoolId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        academicYearId: input.academicYearId,
        termId: input.termId ?? null,
        programId: input.programId ?? null,
        levelId: input.levelId ?? null,
        classSectionId: input.classSectionId ?? null,
        residency: input.residency ?? null,
      },
      tx,
    );

    for (const [index, item] of input.items.entries()) {
      await feeRepository.createStructureItem(
        {
          schoolId,
          feeStructureId: created.id,
          feeCategoryId: item.feeCategoryId,
          label: item.label,
          amount: item.amount,
          sortOrder: item.sortOrder ?? index,
        },
        tx,
      );
    }

    return feeRepository.updateStructure(created.id, created.version, {}, tx);
  });

  await record({
    action: AuditAction.FEE_STRUCTURE_CREATED,
    entityType: AuditEntity.FEE_STRUCTURE,
    entityId: structure.id,
    afterState: {
      name: structure.name,
      academicYearId: structure.academicYearId,
      termId: structure.termId,
      levelId: structure.levelId,
      residency: structure.residency,
      itemCount: structure.items.length,
      totalAmount: toSummary(structure).totalAmount,
    },
  });

  return toSummary(structure);
}

export async function updateFeeStructure(
  principal: Principal,
  structureId: string,
  input: UpdateStructureBody,
): Promise<FeeStructureSummary> {
  const current = await loadStructure(principal, structureId);
  assertEditable(current);

  const updated = await feeRepository.updateStructure(structureId, input.expectedVersion, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  });

  await record({
    action: AuditAction.FEE_STRUCTURE_UPDATED,
    entityType: AuditEntity.FEE_STRUCTURE,
    entityId: structureId,
    beforeState: { name: current.name, description: current.description },
    afterState: { name: updated.name, description: updated.description },
  });

  return toSummary(updated);
}

/**
 * Publish or withdraw a structure.
 *
 * Activation requires at least one item, because an active structure with no items
 * contributes nothing to a run and would look like generation silently failing.
 * Archiving is always permitted and is the correct response to a structure that turned
 * out to be wrong after it raised charges.
 */
export async function changeFeeStructureStatus(
  principal: Principal,
  structureId: string,
  input: ChangeStructureStatusBody,
): Promise<FeeStructureSummary> {
  const current = await loadStructure(principal, structureId);

  if (current.status === input.status) {
    throw new ConflictError(
      `This fee structure is already ${input.status.toLowerCase()}.`,
      ErrorCode.INVALID_STATE_TRANSITION,
    );
  }
  if (input.status === 'ACTIVE') {
    if (current.status === 'ARCHIVED') {
      throw new ConflictError(
        'An archived fee structure cannot be reactivated. Create a replacement instead, so the archived one keeps explaining the charges it raised.',
        ErrorCode.INVALID_STATE_TRANSITION,
      );
    }
    if (current.items.length === 0) {
      throw new DomainError(
        ErrorCode.PRECONDITION_FAILED,
        'A fee structure needs at least one item before it can be activated.',
      );
    }
  }

  const updated = await feeRepository.updateStructure(structureId, input.expectedVersion, {
    status: input.status,
  });

  await record({
    action:
      input.status === 'ACTIVE'
        ? AuditAction.FEE_STRUCTURE_ACTIVATED
        : AuditAction.FEE_STRUCTURE_ARCHIVED,
    entityType: AuditEntity.FEE_STRUCTURE,
    entityId: structureId,
    beforeState: { status: current.status },
    afterState: { status: updated.status, chargeCount: updated._count.charges },
  });

  return toSummary(updated);
}

/* ------------------------------------------------------------------- items */

export async function addFeeStructureItem(
  principal: Principal,
  structureId: string,
  input: AddStructureItemBody,
): Promise<FeeStructureSummary> {
  const structure = await loadStructure(principal, structureId);
  assertEditable(structure);

  await validateCategories(principal, [input.feeCategoryId]);
  if (structure.items.some((item) => item.feeCategoryId === input.feeCategoryId)) {
    throw new ConflictError(
      'This fee structure already charges that category.',
      ErrorCode.DUPLICATE_RESOURCE,
    );
  }

  await feeRepository.createStructureItem({
    schoolId: principal.scope.requireSchoolId(),
    feeStructureId: structureId,
    feeCategoryId: input.feeCategoryId,
    label: input.label,
    amount: input.amount,
    sortOrder: input.sortOrder ?? structure.items.length,
  });

  await record({
    action: AuditAction.FEE_STRUCTURE_ITEM_ADDED,
    entityType: AuditEntity.FEE_STRUCTURE,
    entityId: structureId,
    afterState: { label: input.label, amount: input.amount },
  });

  return toSummary(await loadStructure(principal, structureId));
}

export async function updateFeeStructureItem(
  principal: Principal,
  structureId: string,
  itemId: string,
  input: UpdateStructureItemBody,
): Promise<FeeStructureSummary> {
  const structure = await loadStructure(principal, structureId);
  assertEditable(structure);

  const item = structure.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) throw new NotFoundError('That fee item was not found on this structure.');

  await feeRepository.updateStructureItem(itemId, {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  });

  await record({
    action: AuditAction.FEE_STRUCTURE_ITEM_UPDATED,
    entityType: AuditEntity.FEE_STRUCTURE_ITEM,
    entityId: itemId,
    beforeState: { label: item.label, amount: Money.fromDatabase(item.amount).toString() },
    afterState: { label: input.label ?? item.label, amount: input.amount ?? undefined },
  });

  return toSummary(await loadStructure(principal, structureId));
}

export async function removeFeeStructureItem(
  principal: Principal,
  structureId: string,
  itemId: string,
): Promise<FeeStructureSummary> {
  const structure = await loadStructure(principal, structureId);
  assertEditable(structure);

  const item = structure.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) throw new NotFoundError('That fee item was not found on this structure.');

  await feeRepository.deleteStructureItem(itemId);

  await record({
    action: AuditAction.FEE_STRUCTURE_ITEM_REMOVED,
    entityType: AuditEntity.FEE_STRUCTURE_ITEM,
    entityId: itemId,
    beforeState: { label: item.label, amount: Money.fromDatabase(item.amount).toString() },
  });

  return toSummary(await loadStructure(principal, structureId));
}
