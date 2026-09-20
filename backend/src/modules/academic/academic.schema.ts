/**
 * Request schemas for the academic structure.
 *
 * Dates arrive as `YYYY-MM-DD` and are parsed to a UTC midnight `Date`. These are
 * calendar dates — a term starts on a day, not at an instant — and letting a client
 * send a full timestamp would make "did this payment fall in Term 2?" depend on the
 * sender's time zone.
 */
import { z } from 'zod';

/**
 * A calendar date.
 *
 * Parsed as UTC midnight explicitly rather than through `new Date('2026-01-15')`,
 * which is only UTC by a quirk of the spec for that exact format and is local time for
 * most others. Being explicit means the behaviour does not depend on the shape of the
 * string.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .transform((value, ctx) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(year, month - 1, day));

    // Rejects 2026-02-31, which `Date.UTC` would silently roll forward to 3 March.
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

const periodStatus = z.enum(['UPCOMING', 'ACTIVE', 'CLOSED']);

const name = z.string().trim().min(1, 'This field is required.').max(120, 'That name is too long.');

/** Machine-facing codes: upper-case, no spaces, so they are safe in a URL and a report. */
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

const uuid = z.uuid({ error: 'That is not a valid id.' });

/* ------------------------------------------------------------- academic years */

export const createAcademicYearSchema = z.strictObject({
  name,
  startDate: calendarDate,
  endDate: calendarDate,
  status: periodStatus.optional(),
});
export type CreateAcademicYearBody = z.infer<typeof createAcademicYearSchema>;

export const updateAcademicYearSchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  startDate: calendarDate.optional(),
  endDate: calendarDate.optional(),
  status: periodStatus.optional(),
});
export type UpdateAcademicYearBody = z.infer<typeof updateAcademicYearSchema>;

export const academicYearIdParamsSchema = z.strictObject({ academicYearId: uuid });
export type AcademicYearIdParams = z.infer<typeof academicYearIdParamsSchema>;

/* -------------------------------------------------------------------- terms */

export const createTermSchema = z.strictObject({
  academicYearId: uuid,
  name,
  sequence: z.coerce.number().int().min(1, 'Terms are numbered from 1.').max(12),
  startDate: calendarDate,
  endDate: calendarDate,
  status: periodStatus.optional(),
});
export type CreateTermBody = z.infer<typeof createTermSchema>;

export const updateTermSchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  sequence: z.coerce.number().int().min(1).max(12).optional(),
  startDate: calendarDate.optional(),
  endDate: calendarDate.optional(),
  status: periodStatus.optional(),
});
export type UpdateTermBody = z.infer<typeof updateTermSchema>;

export const termIdParamsSchema = z.strictObject({ termId: uuid });
export type TermIdParams = z.infer<typeof termIdParamsSchema>;

/* -------------------------------------------------------------- departments */

export const createDepartmentSchema = z.strictObject({
  code,
  name,
  description: z.string().trim().max(500).nullable().optional(),
});
export type CreateDepartmentBody = z.infer<typeof createDepartmentSchema>;

/* ---------------------------------------------------------------- programmes */

export const listProgramsQuerySchema = z.strictObject({
  status: z.enum(['ACTIVE', 'DISCONTINUED']).optional(),
});
export type ListProgramsQuery = z.infer<typeof listProgramsQuerySchema>;

export const createProgramSchema = z.strictObject({
  code,
  name,
  description: z.string().trim().max(500).nullable().optional(),
  departmentId: uuid.nullable().optional(),
  durationYears: z.coerce.number().int().min(1).max(10).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
});
export type CreateProgramBody = z.infer<typeof createProgramSchema>;

export const updateProgramSchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  departmentId: uuid.nullable().optional(),
  durationYears: z.coerce.number().int().min(1).max(10).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISCONTINUED']).optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
});
export type UpdateProgramBody = z.infer<typeof updateProgramSchema>;

export const programIdParamsSchema = z.strictObject({ programId: uuid });
export type ProgramIdParams = z.infer<typeof programIdParamsSchema>;

/* -------------------------------------------------------------------- levels */

export const listLevelsQuerySchema = z.strictObject({ programId: uuid.optional() });
export type ListLevelsQuery = z.infer<typeof listLevelsQuerySchema>;

export const createLevelSchema = z.strictObject({
  programId: uuid,
  code,
  name,
  sequence: z.coerce.number().int().min(1, 'Levels are numbered from 1.').max(20),
  isTerminal: z.boolean().optional(),
});
export type CreateLevelBody = z.infer<typeof createLevelSchema>;

/** `null` unchains a level, which is how a terminal level is expressed. */
export const setLevelProgressionSchema = z.strictObject({
  nextLevelId: uuid.nullable(),
});
export type SetLevelProgressionBody = z.infer<typeof setLevelProgressionSchema>;

export const levelIdParamsSchema = z.strictObject({ levelId: uuid });
export type LevelIdParams = z.infer<typeof levelIdParamsSchema>;

/* ------------------------------------------------------------- class sections */

export const listClassSectionsQuerySchema = z.strictObject({
  academicYearId: uuid.optional(),
  levelId: uuid.optional(),
});
export type ListClassSectionsQuery = z.infer<typeof listClassSectionsQuerySchema>;

export const createClassSectionSchema = z.strictObject({
  academicYearId: uuid,
  levelId: uuid,
  code,
  name,
  capacity: z.coerce.number().int().min(1).max(500).nullable().optional(),
  classTeacherName: z.string().trim().max(120).nullable().optional(),
});
export type CreateClassSectionBody = z.infer<typeof createClassSectionSchema>;

export const updateClassSectionSchema = z.strictObject({
  expectedVersion,
  name: name.optional(),
  capacity: z.coerce.number().int().min(1).max(500).nullable().optional(),
  classTeacherName: z.string().trim().max(120).nullable().optional(),
});
export type UpdateClassSectionBody = z.infer<typeof updateClassSectionSchema>;

export const classSectionIdParamsSchema = z.strictObject({ classSectionId: uuid });
export type ClassSectionIdParams = z.infer<typeof classSectionIdParamsSchema>;
