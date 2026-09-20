/**
 * Request schemas for student registration and profile.
 *
 * Two shapes are deliberately absent from every body here: `studentId` and `status`.
 * The identifier is allocated by the server and appears on receipts, so it is not a
 * field a client may set or change; the status is a lifecycle decision with its own
 * endpoint, its own permission and its own audit action.
 */
import { z } from 'zod';

const uuid = z.uuid({ error: 'That is not a valid id.' });

/**
 * A calendar date. Parsed to UTC midnight explicitly — a date of birth and an
 * admission date are days, not instants, and must not shift with the sender's zone.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .transform((value, ctx) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      ctx.addIssue({ code: 'custom', message: 'That is not a real date.' });
      return z.NEVER;
    }
    return parsed;
  });

const personName = z
  .string()
  .trim()
  .min(1, 'This field is required.')
  .max(100, 'That name is too long.');

/** Optional free text, explicitly clearable by sending null. */
const optionalText = (max: number): z.ZodOptional<z.ZodNullable<z.ZodString>> =>
  z.string().trim().max(max).nullable().optional();

const expectedVersion = z.coerce
  .number({ error: 'The record version is required so concurrent edits can be detected.' })
  .int()
  .min(0);

export const studentIdParamsSchema = z.strictObject({ studentId: uuid });
export type StudentIdParams = z.infer<typeof studentIdParamsSchema>;

export const listStudentsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
  /** Matches the Student ID or any part of the name. */
  search: z.string().trim().max(200).optional(),
  status: z
    .enum(['ACTIVE', 'COMPLETED', 'TRANSFERRED', 'WITHDRAWN', 'SUSPENDED', 'ARCHIVED'])
    .optional(),
  admissionYear: z.coerce.number().int().min(1900).max(2200).optional(),
  academicYearId: uuid.optional(),
  levelId: uuid.optional(),
  classSectionId: uuid.optional(),
});
export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;

/**
 * Registration.
 *
 * The enrolment is part of the body rather than a follow-up call: a student with no
 * enrolment cannot be placed, charged or reported on, and leaving the two steps
 * separate means a half-registered student whenever the second one is forgotten.
 */
export const registerStudentSchema = z.strictObject({
  firstName: personName,
  lastName: personName,
  otherNames: optionalText(100),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).optional(),
  dateOfBirth: calendarDate.nullable().optional(),
  admissionDate: calendarDate,
  district: optionalText(100),
  sector: optionalText(100),
  address: optionalText(250),
  phone: optionalText(30),
  email: z.email({ error: 'Enter a valid email address.' }).max(320).nullable().optional(),

  enrolment: z.strictObject({
    levelId: uuid,
    classSectionId: uuid.nullable().optional(),
    residency: z.enum(['DAY', 'BOARDING']).optional(),
    enrollmentType: z
      .enum(['NEW', 'CONTINUING', 'REPEAT', 'RE_ADMISSION', 'TRANSFER_IN'])
      .optional(),
    startDate: calendarDate.optional(),
  }),
});
export type RegisterStudentBody = z.infer<typeof registerStudentSchema>;

export const updateStudentSchema = z
  .strictObject({
    expectedVersion,
    firstName: personName.optional(),
    lastName: personName.optional(),
    otherNames: optionalText(100),
    dateOfBirth: calendarDate.nullable().optional(),
    district: optionalText(100),
    sector: optionalText(100),
    address: optionalText(250),
    phone: optionalText(30),
    email: z.email({ error: 'Enter a valid email address.' }).max(320).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 1, 'Provide at least one field to change.');
export type UpdateStudentBody = z.infer<typeof updateStudentSchema>;

/**
 * A lifecycle change.
 *
 * A reason is required for everything except reinstatement: "why did this student
 * leave" is the question a clearance check and a proration both start from, and it is
 * unanswerable a year later if nobody wrote it down.
 */
export const changeStudentStatusSchema = z
  .strictObject({
    expectedVersion,
    status: z.enum(['ACTIVE', 'COMPLETED', 'TRANSFERRED', 'WITHDRAWN', 'SUSPENDED', 'ARCHIVED']),
    reason: z.string().trim().min(1).max(500).optional(),
    /** The day the student actually left, which proration in Phase 9 depends on. */
    effectiveDate: calendarDate.optional(),
  })
  .refine((value) => value.status === 'ACTIVE' || value.reason !== undefined, {
    message: 'Give a reason for this change.',
    path: ['reason'],
  });
export type ChangeStudentStatusBody = z.infer<typeof changeStudentStatusSchema>;
