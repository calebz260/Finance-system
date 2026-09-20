/**
 * Enrolment endpoints.
 */
import type { Request, Response } from 'express';

import type { EnrollmentSummary } from '@sfs/shared';

import { sendCreated, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import type {
  EndEnrollmentBody,
  EnrolStudentBody,
  EnrollmentIdParams,
  MoveClassBody,
} from './enrollment.schema.js';
import { endEnrollment, enrolStudent, moveToClass } from './enrollment.service.js';

/** `POST /enrolments` — a re-admission, a transfer in, or a placement for a new year. */
export const enrolStudentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: EnrolStudentBody }>(req);

  const created = await enrolStudent(principal, {
    studentId: body.studentId,
    academicYearId: body.academicYearId,
    levelId: body.levelId,
    ...(body.classSectionId !== undefined ? { classSectionId: body.classSectionId } : {}),
    ...(body.residency !== undefined ? { residency: body.residency } : {}),
    ...(body.enrollmentType !== undefined ? { enrollmentType: body.enrollmentType } : {}),
    ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
  });

  sendCreated(res, created satisfies EnrollmentSummary, `/api/v1/enrolments/${created.id}`);
};

/** `PATCH /enrolments/:enrollmentId` — a class move, and nothing else. */
export const moveClassHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: EnrollmentIdParams; body: MoveClassBody }>(req);

  const updated = await moveToClass(principal, {
    enrollmentId: params.enrollmentId,
    expectedVersion: body.expectedVersion,
    classSectionId: body.classSectionId,
  });

  sendSuccess(res, updated satisfies EnrollmentSummary);
};

/**
 * `POST /enrolments/:enrollmentId/end`
 *
 * Closes the enrolment with an outcome. The row stays: a withdrawal in March is part
 * of the record a clearance check and a proration both read.
 */
export const endEnrollmentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: EnrollmentIdParams; body: EndEnrollmentBody }>(req);

  const ended = await endEnrollment(principal, {
    enrollmentId: params.enrollmentId,
    status: body.status,
    ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    exitReason: body.exitReason,
  });

  sendSuccess(res, ended satisfies EnrollmentSummary);
};
