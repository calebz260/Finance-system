/**
 * Request schemas for fee configuration, charges and adjustments.
 *
 * The money rule is the one worth reading. Amounts arrive as **strings** and are
 * validated by `Money` itself, never by `z.number()`. A JSON number has already lost
 * precision by the time Zod sees it — `150000.10` parses to `150000.09999999999`, and a
 * validator that accepts it has accepted a wrong amount. Rejecting numbers at the edge
 * means the float never enters the system at all (Section 13A).
 */
import { z } from 'zod';

import { Money } from '@sfs/shared';

const uuid = z.uuid({ error: 'That is not a valid id.' });

const name = z.string().trim().min(1, 'This field is required.').max(120, 'That name is too long.');

const description = z.string().trim().max(500, 'That description is too long.');

/** A reason someone will read years later. Short enough to be a sentence, not an essay. */
const reason = z
  .string()
  .trim()
  .min(3, 'A reason is required, and it is recorded permanently.')
  .max(500, 'That reason is too long.');

const code = z
  .string()
  .trim()
  .min(1, 'A code is required.')
  .max(30, 'That code is too long.')
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only.')
  .transform((value) => value.toUpperCase());

const expectedVersion = z.coerce
  .number({ error: 'The record version is required so concurrent edits can be detected.' })
  .int()
  .min(0);

/**
 * A monetary amount.
 *
 * A string, deliberately. `Money.isValid` applies the same parsing, scale and maximum
 * the storage layer uses, so anything that validates here is storable without a second
 * rounding step — there is no "valid in the API, too large for the column" gap.
 */
const money = z
  .string()
  .trim()
  .min(1, 'An amount is required.')
  .refine((value) => Money.isValid(value), 'That is not a valid amount.')
  // Normalised to scale 2 here so the service and the database always see the same
  // string, whatever the client typed.
  .transform((value) => Money.of(value).toString());

/** Non-negative: a fee line of zero is legitimate, a negative one is a hidden discount. */
const nonNegativeMoney = money.refine(
  (value) => !Money.of(value).isNegative(),
  'An amount cannot be negative.',
);

/** Strictly positive: an adjustment of zero moves nothing and should not be recorded. */
const positiveMoney = money.refine(
  (value) => Money.of(value).isPositive(),
  'An amount must be greater than zero.',
);

const percentage = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a percentage such as 25 or 12.5.')
  .refine((value) => {
    const parsed = Number(value);
    return parsed > 0 && parsed <= 100;
  }, 'A percentage must be above 0 and at most 100.');

const residency = z.enum(['DAY', 'BOARDING']);
const reliefKind = z.enum(['DISCOUNT', 'SCHOLARSHIP', 'WAIVER', 'ADJUSTMENT']);
const approvalStatus = z.enum([
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'REVERSED',
]);

const paginationQuery = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
};

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
