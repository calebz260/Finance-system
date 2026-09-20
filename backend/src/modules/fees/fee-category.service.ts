/**
 * Fee categories: the kinds of fee a school levies.
 *
 * Configuration rather than an enum, because the list differs between schools and
 * changes without wanting a release. The only rule with teeth is that a category is
 * never deleted. Deactivating one hides it from new fee structures; the charges raised
 * against it three years ago still name it, and a report covering that year has to be
 * able to say what the money was for (Section 12).
 */
import { ErrorCode, type FeeCategorySummary } from '@sfs/shared';

import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { feeRepository, type FeeCategoryRecord } from './fee.repository.js';
import type { CreateCategoryBody, UpdateCategoryBody } from './fee.schema.js';

function toSummary(category: FeeCategoryRecord): FeeCategorySummary {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
    isActive: category.isActive,
    sortOrder: category.sortOrder,
    chargeCount: category._count.charges,
    version: category.version,
  };
}

export async function listFeeCategories(
  principal: Principal,
  options: { includeInactive: boolean },
): Promise<readonly FeeCategorySummary[]> {
  const categories = await feeRepository.listCategories(principal.scope, options);
  return categories.map(toSummary);
}

export async function getFeeCategory(
  principal: Principal,
  categoryId: string,
): Promise<FeeCategorySummary> {
  const category = await feeRepository.findCategoryById(categoryId);
  principal.scope.assertPermits(category, 'fee category');
  return toSummary(category as FeeCategoryRecord);
}

export async function createFeeCategory(
  principal: Principal,
  input: CreateCategoryBody,
): Promise<FeeCategorySummary> {
  const schoolId = principal.scope.requireSchoolId();

  const existing = await feeRepository.findCategoryByCode(schoolId, input.code);
  if (existing !== null) {
    throw new ConflictError(
      `A fee category with the code ${input.code} already exists.`,
      ErrorCode.DUPLICATE_RESOURCE,
    );
  }

  const created = await feeRepository.createCategory({
    schoolId,
    code: input.code,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  });

  await record({
    action: AuditAction.FEE_CATEGORY_CREATED,
    entityType: AuditEntity.FEE_CATEGORY,
    entityId: created.id,
    afterState: { code: created.code, name: created.name, isActive: created.isActive },
  });

  return toSummary(created);
}

/**
 * Edit a category.
 *
 * The code is not editable — it is the identifier imports and historical reports use, so
 * renaming it after the fact silently breaks them. Deactivation is allowed at any time
 * and is the supported way to retire a category, including one that already carries
 * charges.
 */
export async function updateFeeCategory(
  principal: Principal,
  categoryId: string,
  input: UpdateCategoryBody,
): Promise<FeeCategorySummary> {
  const current = await feeRepository.findCategoryById(categoryId);
  principal.scope.assertPermits(current, 'fee category');
  if (current === null) throw new NotFoundError('The requested fee category was not found.');

  const before = {
    name: current.name,
    description: current.description,
    isActive: current.isActive,
    sortOrder: current.sortOrder,
  };

  const updated = await feeRepository.updateCategory(categoryId, input.expectedVersion, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  });

  await record({
    action: AuditAction.FEE_CATEGORY_UPDATED,
    entityType: AuditEntity.FEE_CATEGORY,
    entityId: categoryId,
    beforeState: before,
    afterState: {
      name: updated.name,
      description: updated.description,
      isActive: updated.isActive,
      sortOrder: updated.sortOrder,
    },
    // Recorded on the entry because retiring a category that carries history is the
    // change someone will later want explained.
    ...(before.isActive && !updated.isActive
      ? { reason: `Deactivated with ${String(updated._count.charges)} historical charge(s).` }
      : {}),
  });

  return toSummary(updated);
}
