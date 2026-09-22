/**
 * Request schemas for fee configuration, charges and adjustments.
 *
 * The shared primitives — and in particular the money rule, which is the one worth
 * reading — live in `lib/validation.ts` so that every module validates an amount the
 * same way. A money validator that drifted between the fee endpoints and the payment
 * endpoints would be one of them quietly accepting an amount the other refuses.
 */
import { z } from 'zod';

import {
  codeField as code,
  descriptionField as description,
  expectedVersionField as expectedVersion,
  nameField as name,
  nonNegativeMoneyField as nonNegativeMoney,
  paginationQueryFields,
  percentageField as percentage,
  positiveMoneyField as positiveMoney,
  reasonField as reason,
  uuidField as uuid,
} from '../../lib/validation.js';

const residency = z.enum(['DAY', 'BOARDING']);
const reliefKind = z.enum(['DISCOUNT', 'SCHOLARSHIP', 'WAIVER', 'ADJUSTMENT']);
const approvalStatus = z.enum([
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'REVERSED',
]);

const paginationQuery = paginationQueryFields;

/* ------------------------------------------------------------- fee categories */

export const listCategoriesQuerySchema = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

export const createCategorySchema = z.strictObject({
  code,
  name,
  description: description.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});
export type CreateCategoryBody = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  description: description.nullable().optional(),
  // The code is deliberately absent: it appears in imports and historical reports, and
  // renaming an identifier after the fact breaks the reports that used it.
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});
export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>;

export const categoryIdParamsSchema = z.strictObject({ categoryId: uuid });
export type CategoryIdParams = z.infer<typeof categoryIdParamsSchema>;

/* ------------------------------------------------------------ fee structures */

const structureItemInput = z.strictObject({
  feeCategoryId: uuid,
  label: name,
  amount: nonNegativeMoney,
  sortOrder: z.coerce.number().int().min(0).optional(),
});
export type StructureItemInput = z.infer<typeof structureItemInput>;

export const createStructureSchema = z.strictObject({
  name,
  description: description.optional(),
  academicYearId: uuid,
  /** Omit or send null for a fee charged once per year rather than per term. */
  termId: uuid.nullable().optional(),
  programId: uuid.nullable().optional(),
  levelId: uuid.nullable().optional(),
  classSectionId: uuid.nullable().optional(),
  residency: residency.nullable().optional(),
  items: z
    .array(structureItemInput)
    .min(1, 'A fee structure needs at least one item.')
    .max(50, 'That is more fee items than a structure should carry.'),
});
export type CreateStructureBody = z.infer<typeof createStructureSchema>;

export const updateStructureSchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  description: description.nullable().optional(),
  // Applicability and period are immutable after creation. Changing which students a
  // structure applies to, once it has raised charges, would silently reinterpret every
  // charge already raised from it.
});
export type UpdateStructureBody = z.infer<typeof updateStructureSchema>;

export const listStructuresQuerySchema = z.strictObject({
  ...paginationQuery,
  academicYearId: uuid.optional(),
  termId: uuid.optional(),
  levelId: uuid.optional(),
  programId: uuid.optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});
export type ListStructuresQuery = z.infer<typeof listStructuresQuerySchema>;

export const structureIdParamsSchema = z.strictObject({ structureId: uuid });
export type StructureIdParams = z.infer<typeof structureIdParamsSchema>;

export const structureItemParamsSchema = z.strictObject({ structureId: uuid, itemId: uuid });
export type StructureItemParams = z.infer<typeof structureItemParamsSchema>;

export const addStructureItemSchema = structureItemInput;
export type AddStructureItemBody = z.infer<typeof addStructureItemSchema>;

export const updateStructureItemSchema = z.strictObject({
  label: name.optional(),
  amount: nonNegativeMoney.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});
export type UpdateStructureItemBody = z.infer<typeof updateStructureItemSchema>;

export const changeStructureStatusSchema = z.strictObject({
  expectedVersion,
  status: z.enum(['ACTIVE', 'ARCHIVED']),
});
export type ChangeStructureStatusBody = z.infer<typeof changeStructureStatusSchema>;

/* ------------------------------------------------------------------ charges */

export const listChargesQuerySchema = z.strictObject({
  ...paginationQuery,
  studentId: uuid.optional(),
  academicYearId: uuid.optional(),
  termId: uuid.optional(),
  feeCategoryId: uuid.optional(),
  levelId: uuid.optional(),
  classSectionId: uuid.optional(),
  status: z.enum(['RAISED', 'VOID']).optional(),
  raisedFrom: z.iso.date().optional(),
  raisedTo: z.iso.date().optional(),
});
export type ListChargesQuery = z.infer<typeof listChargesQuerySchema>;

export const chargeIdParamsSchema = z.strictObject({ chargeId: uuid });
export type ChargeIdParams = z.infer<typeof chargeIdParamsSchema>;

/**
 * An ad-hoc charge against one student.
 *
 * Carries no fee-structure item, which is exactly what exempts it from the duplicate
 * key — this is the supported way to raise a second charge in a category a student
 * already holds, and the required reason is what makes that deliberate rather than
 * accidental.
 */
export const createChargeSchema = z.strictObject({
  studentId: uuid,
  feeCategoryId: uuid,
  academicYearId: uuid,
  termId: uuid.nullable().optional(),
  description: name,
  amount: nonNegativeMoney,
  notes: reason,
});
export type CreateChargeBody = z.infer<typeof createChargeSchema>;

export const voidChargeSchema = z.strictObject({
  expectedVersion,
  reason,
});
export type VoidChargeBody = z.infer<typeof voidChargeSchema>;

/* -------------------------------------------------------------- charge runs */

export const chargeRunSchema = z.strictObject({
  academicYearId: uuid,
  termId: uuid.nullable().optional(),
  /** Narrow the run to one structure. Omitted, every active structure for the period runs. */
  feeStructureId: uuid.optional(),
});
export type ChargeRunBody = z.infer<typeof chargeRunSchema>;

/* ------------------------------------------------------------------ relief */

/**
 * A request for relief, or for an authorised additional debit.
 *
 * One schema across the four kinds, with the kind-specific fields optional and checked
 * by the service: `scholarshipId` is required for an award, `direction` only means
 * anything for an adjustment, and a waiver is always a fixed sum.
 *
 * `studentChargeId` is optional. Relief may target one charge (a discount on tuition) or
 * sit at student level for a period (a bursary covering everything). When a charge is
 * named the service takes the academic context from it, so the two cannot disagree.
 */
export const requestReliefSchema = z
  .strictObject({
    studentId: uuid,
    studentChargeId: uuid.nullable().optional(),
    academicYearId: uuid,
    termId: uuid.nullable().optional(),
    /** Required when requesting a SCHOLARSHIP award. */
    scholarshipId: uuid.optional(),
    /** Only meaningful for an ADJUSTMENT; everything else credits. */
    direction: z.enum(['DEBIT', 'CREDIT']).optional(),
    /** Provide exactly one of `amount` or `percentage`. */
    amount: positiveMoney.optional(),
    percentage: percentage.optional(),
    reason,
  })
  .refine(
    (value) => (value.amount === undefined) !== (value.percentage === undefined),
    'Provide either a fixed amount or a percentage, not both.',
  )
  .refine(
    (value) => value.percentage === undefined || value.studentChargeId != null,
    'A percentage must name the charge it applies to, or there is nothing to take a percentage of.',
  );
export type RequestReliefBody = z.infer<typeof requestReliefSchema>;

export const listReliefsQuerySchema = z.strictObject({
  studentId: uuid.optional(),
  academicYearId: uuid.optional(),
  termId: uuid.optional(),
  kind: reliefKind.optional(),
  status: approvalStatus.optional(),
});
export type ListReliefsQuery = z.infer<typeof listReliefsQuerySchema>;

export const reliefParamsSchema = z.strictObject({ kind: reliefKind, reliefId: uuid });
export type ReliefParams = z.infer<typeof reliefParamsSchema>;

export const reliefKindParamsSchema = z.strictObject({ kind: reliefKind });
export type ReliefKindParams = z.infer<typeof reliefKindParamsSchema>;

export const decideReliefSchema = z.strictObject({
  expectedVersion,
  decision: z.enum(['APPROVE', 'REJECT']),
  note: description.optional(),
});
export type DecideReliefBody = z.infer<typeof decideReliefSchema>;

export const cancelReliefSchema = z.strictObject({ expectedVersion });
export type CancelReliefBody = z.infer<typeof cancelReliefSchema>;

export const reverseReliefSchema = z.strictObject({ expectedVersion, reason });
export type ReverseReliefBody = z.infer<typeof reverseReliefSchema>;

/* --------------------------------------------------- scholarship programmes */

export const listScholarshipsQuerySchema = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type ListScholarshipsQuery = z.infer<typeof listScholarshipsQuerySchema>;

export const createScholarshipSchema = z
  .strictObject({
    code,
    name,
    description: description.optional(),
    sponsor: name.optional(),
    /** Defaults offered when awarding. An award may still differ. */
    defaultPercentage: percentage.optional(),
    defaultAmount: nonNegativeMoney.optional(),
  })
  .refine(
    (value) => value.defaultPercentage === undefined || value.defaultAmount === undefined,
    'A scholarship has a default percentage or a default amount, not both.',
  );
export type CreateScholarshipBody = z.infer<typeof createScholarshipSchema>;

export const updateScholarshipSchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  description: description.nullable().optional(),
  sponsor: name.nullable().optional(),
  isActive: z.boolean().optional(),
  defaultPercentage: percentage.optional(),
  defaultAmount: nonNegativeMoney.optional(),
});
export type UpdateScholarshipBody = z.infer<typeof updateScholarshipSchema>;

export const scholarshipIdParamsSchema = z.strictObject({ scholarshipId: uuid });
export type ScholarshipIdParams = z.infer<typeof scholarshipIdParamsSchema>;

/* ------------------------------------------------------------- student view */

export const studentIdParamsSchema = z.strictObject({ studentId: uuid });
export type StudentIdParams = z.infer<typeof studentIdParamsSchema>;

export const studentFinancialQuerySchema = z.strictObject({
  academicYearId: uuid.optional(),
  termId: uuid.optional(),
});
export type StudentFinancialQuery = z.infer<typeof studentFinancialQuerySchema>;
