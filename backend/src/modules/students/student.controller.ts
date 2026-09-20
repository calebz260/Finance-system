/**
 * Student endpoints.
 *
 * Thin. The nested reads — a student's guardians, a student's enrolment history —
 * live here rather than under `/guardians` and `/enrolments` because that is how the
 * screens ask for them: a registrar opens a student and wants the whole picture.
 */
import type { Request, Response } from 'express';

import type { EnrollmentSummary, StudentDetail, StudentGuardianLink } from '@sfs/shared';

import { resolvePagination, sendCreated, sendPaginated, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { listEnrollmentsForStudent } from '../enrollments/enrollment.service.js';
import { listGuardiansForStudent } from '../guardians/guardian.service.js';
import type {
  ChangeStudentStatusBody,
  ListStudentsQuery,
  RegisterStudentBody,
  StudentIdParams,
  UpdateStudentBody,
} from './student.schema.js';
import {
  changeStudentStatus,
  getStudent,
  listStudents,
  registerStudent,
  updateStudent,
} from './student.service.js';

export const listStudentsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListStudentsQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listStudents(
    principal,
    {
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.admissionYear !== undefined ? { admissionYear: query.admissionYear } : {}),
      ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
      ...(query.levelId !== undefined ? { levelId: query.levelId } : {}),
      ...(query.classSectionId !== undefined ? { classSectionId: query.classSectionId } : {}),
    },
    pagination,
  );

  sendPaginated(res, {
    items: result.items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: result.totalItems,
  });
};

export const getStudentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: StudentIdParams }>(req);

  sendSuccess(res, (await getStudent(principal, params.studentId)) satisfies StudentDetail);
};

/**
 * `POST /students`
 *
 * Registers the student and their first enrolment together, and answers with the full
 * profile including the allocated Student ID — which is the thing the registrar needs
 * to write on the admission form.
 */
export const registerStudentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: RegisterStudentBody }>(req);

  const created = await registerStudent(principal, {
    firstName: body.firstName,
    lastName: body.lastName,
    ...(body.otherNames !== undefined ? { otherNames: body.otherNames } : {}),
    ...(body.gender !== undefined ? { gender: body.gender } : {}),
    ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth } : {}),
    admissionDate: body.admissionDate,
    ...(body.district !== undefined ? { district: body.district } : {}),
    ...(body.sector !== undefined ? { sector: body.sector } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    enrolment: {
      levelId: body.enrolment.levelId,
      ...(body.enrolment.classSectionId !== undefined
        ? { classSectionId: body.enrolment.classSectionId }
        : {}),
      ...(body.enrolment.residency !== undefined ? { residency: body.enrolment.residency } : {}),
      ...(body.enrolment.enrollmentType !== undefined
        ? { enrollmentType: body.enrolment.enrollmentType }
        : {}),
      ...(body.enrolment.startDate !== undefined ? { startDate: body.enrolment.startDate } : {}),
    },
  });

  sendCreated(res, created satisfies StudentDetail, `/api/v1/students/${created.id}`);
};

export const updateStudentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: StudentIdParams; body: UpdateStudentBody }>(req);

  const updated = await updateStudent(principal, {
    studentId: params.studentId,
    expectedVersion: body.expectedVersion,
    ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
    ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
    ...(body.otherNames !== undefined ? { otherNames: body.otherNames } : {}),
    ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth } : {}),
    ...(body.district !== undefined ? { district: body.district } : {}),
    ...(body.sector !== undefined ? { sector: body.sector } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
  });

  sendSuccess(res, updated satisfies StudentDetail);
};

/** `PUT /students/:studentId/status` — and, where it applies, ends the live enrolment. */
export const changeStudentStatusHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: StudentIdParams;
    body: ChangeStudentStatusBody;
  }>(req);

  const updated = await changeStudentStatus(principal, {
    studentId: params.studentId,
    expectedVersion: body.expectedVersion,
    status: body.status,
    reason: body.reason,
    effectiveDate: body.effectiveDate,
  });

  sendSuccess(res, updated satisfies StudentDetail);
};

export const listStudentGuardiansHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: StudentIdParams }>(req);

  const links = await listGuardiansForStudent(principal, params.studentId);
  sendSuccess(res, links satisfies readonly StudentGuardianLink[]);
};

/** The whole history, newest first. Append-only: nothing here is ever overwritten. */
export const listStudentEnrollmentsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: StudentIdParams }>(req);

  const history = await listEnrollmentsForStudent(principal, params.studentId);
  sendSuccess(res, history satisfies readonly EnrollmentSummary[]);
};
