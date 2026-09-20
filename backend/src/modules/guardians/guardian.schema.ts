/**
 * Request schemas for guardians and their links to students.
 *
 * The link flags are validated as ordinary booleans here and enforced as
 * authorisation inputs later: `canViewFinancials` and `canInitiatePayments` are what
 * Phase 5 checks before showing a parent a balance or letting them pay. They default
 * to permissive on a new link, because the usual case is a parent who should see and
 * pay for their own child; the restrictive cases are set deliberately.
 */
import { z } from 'zod';

const uuid = z.uuid({ error: 'That is not a valid id.' });

const personName = z
  .string()
  .trim()
  .min(1, 'This field is required.')
  .max(100, 'That name is too long.');

/**
 * A contact number.
 *
 * Deliberately loose: the school's existing records contain `0788…`, `+250788…` and
 * numbers with spaces, and rejecting them would mean a registrar cannot record the
 * number they actually have. The importer normalises for matching; this only bounds
 * the length and insists on some digits.
 */
const phone = z
  .string()
  .trim()
  .min(7, 'That phone number is too short.')
  .max(30, 'That phone number is too long.')
  .regex(/[0-9]/, 'A phone number needs digits.');

/** Optional free text, explicitly clearable by sending null. */
const optionalText = (max: number): z.ZodOptional<z.ZodNullable<z.ZodString>> =>
  z.string().trim().max(max).nullable().optional();

const expectedVersion = z.coerce
  .number({ error: 'The record version is required so concurrent edits can be detected.' })
  .int()
  .min(0);

const relationship = z.enum(['MOTHER', 'FATHER', 'GUARDIAN', 'SIBLING', 'SPONSOR', 'OTHER']);

export const guardianIdParamsSchema = z.strictObject({ guardianId: uuid });
export type GuardianIdParams = z.infer<typeof guardianIdParamsSchema>;

export const linkIdParamsSchema = z.strictObject({ linkId: uuid });
export type LinkIdParams = z.infer<typeof linkIdParamsSchema>;

export const listGuardiansQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().max(200).optional(),
});
export type ListGuardiansQuery = z.infer<typeof listGuardiansQuerySchema>;

export const createGuardianSchema = z.strictObject({
  firstName: personName,
  lastName: personName,
  phone,
  altPhone: optionalText(30),
  email: z.email({ error: 'Enter a valid email address.' }).max(320).nullable().optional(),
  nationalIdNumber: optionalText(30),
  occupation: optionalText(100),
  district: optionalText(100),
  sector: optionalText(100),
  address: optionalText(250),
});
export type CreateGuardianBody = z.infer<typeof createGuardianSchema>;

export const updateGuardianSchema = z
  .strictObject({
    expectedVersion,
    firstName: personName.optional(),
    lastName: personName.optional(),
    phone: phone.optional(),
    altPhone: optionalText(30),
    email: z.email({ error: 'Enter a valid email address.' }).max(320).nullable().optional(),
    nationalIdNumber: optionalText(30),
    occupation: optionalText(100),
    district: optionalText(100),
    sector: optionalText(100),
    address: optionalText(250),
  })
  .refine((value) => Object.keys(value).length > 1, 'Provide at least one field to change.');
export type UpdateGuardianBody = z.infer<typeof updateGuardianSchema>;

/** Linking an existing guardian to a student. */
export const linkGuardianSchema = z.strictObject({
  guardianId: uuid,
  relationship: relationship.optional(),
  isPrimaryContact: z.boolean().optional(),
  isFinanciallyResponsible: z.boolean().optional(),
  canViewFinancials: z.boolean().optional(),
  canInitiatePayments: z.boolean().optional(),
});
export type LinkGuardianBody = z.infer<typeof linkGuardianSchema>;

export const updateLinkSchema = z
  .strictObject({
    expectedVersion,
    relationship: relationship.optional(),
    isPrimaryContact: z.boolean().optional(),
    isFinanciallyResponsible: z.boolean().optional(),
    canViewFinancials: z.boolean().optional(),
    canInitiatePayments: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 1, 'Provide at least one field to change.');
export type UpdateLinkBody = z.infer<typeof updateLinkSchema>;
