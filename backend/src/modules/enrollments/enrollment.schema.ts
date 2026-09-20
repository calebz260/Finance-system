/**
 * Request schemas for enrolment.
 *
 * Note what an enrolment body cannot change once it exists: the student, the year, the
 * programme and the level. Those describe where a student *was*, and rewriting them
 * would falsify the history that clearance checks and prorations read. A change of
 * level is a promotion or a re-admission, and creates a new row.
 */
import { z } from 'zod';

const uuid = z.uuid({ error: 'That is not a valid id.' });

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

const expectedVersion = z.coerce
  .number({ error: 'The record version is required so concurrent edits can be detected.' })
  .int()
  .min(0);

export const enrollmentIdParamsSchema = z.strictObject({ enrollmentId: uuid });
export type EnrollmentIdParams = z.infer<typeof enrollmentIdParamsSchema>;

export const enrolStudentSchema = z.strictObject({
  studentId: uuid,
  /** Defaults to the current academic year. */
  academicYearId: uuid.optional(),
  levelId: uuid,
  classSectionId: uuid.nullable().optional(),
  residency: z.enum(['DAY', 'BOARDING']).optional(),
  enrollmentType: z.enum(['NEW', 'CONTINUING', 'REPEAT', 'RE_ADMISSION', 'TRANSFER_IN']).optional(),
  startDate: calendarDate.optional(),
});
export type EnrolStudentBody = z.infer<typeof enrolStudentSchema>;

/** The only edit a live enrolment accepts: a move between classes in the same level. */
export const moveClassSchema = z.strictObject({
  expectedVersion,
  classSectionId: uuid.nullable(),
});
export type MoveClassBody = z.infer<typeof moveClassSchema>;

export const endEnrollmentSchema = z.strictObject({
  status: z.enum(['PROMOTED', 'REPEATED', 'COMPLETED', 'TRANSFERRED_OUT', 'WITHDRAWN']),
  endDate: calendarDate.optional(),
  exitReason: z.string().trim().min(1).max(500).optional(),
});
export type EndEnrollmentBody = z.infer<typeof endEnrollmentSchema>;
