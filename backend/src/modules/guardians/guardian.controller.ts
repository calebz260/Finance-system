/**
 * Guardian endpoints, and the student-guardian link.
 *
 * Linking is mounted under the student (`POST /students/:studentId/guardians`) because
 * that is the direction the work happens in: a registrar is looking at a child and
 * recording who is responsible for them.
 */
import type { Request, Response } from 'express';

import type { GuardianSummary, StudentGuardianLink } from '@sfs/shared';

import {
  HttpStatus,
  resolvePagination,
  sendCreated,
  sendPaginated,
  sendSuccess,
} from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import type { StudentIdParams } from '../students/student.schema.js';
import type {
  CreateGuardianBody,
  GuardianIdParams,
  LinkGuardianBody,
  LinkIdParams,
  ListGuardiansQuery,
  UpdateGuardianBody,
  UpdateLinkBody,
} from './guardian.schema.js';
import {
  createGuardian,
  getGuardian,
  linkGuardianToStudent,
  listGuardians,
  unlinkGuardian,
  updateGuardian,
  updateGuardianLink,
} from './guardian.service.js';

export const listGuardiansHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListGuardiansQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listGuardians(
    principal,
    { ...(query.search !== undefined ? { search: query.search } : {}) },
    pagination,
  );

  sendPaginated(res, {
    items: result.items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: result.totalItems,
  });
};

export const getGuardianHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: GuardianIdParams }>(req);

  sendSuccess(res, (await getGuardian(principal, params.guardianId)) satisfies GuardianSummary);
};

export const createGuardianHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateGuardianBody }>(req);

  const created = await createGuardian(principal, {
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    ...(body.altPhone !== undefined ? { altPhone: body.altPhone } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.nationalIdNumber !== undefined ? { nationalIdNumber: body.nationalIdNumber } : {}),
    ...(body.occupation !== undefined ? { occupation: body.occupation } : {}),
    ...(body.district !== undefined ? { district: body.district } : {}),
    ...(body.sector !== undefined ? { sector: body.sector } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
  });

  sendCreated(res, created satisfies GuardianSummary, `/api/v1/guardians/${created.id}`);
};

export const updateGuardianHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: GuardianIdParams; body: UpdateGuardianBody }>(req);

  const { expectedVersion, ...changes } = body;

  const updated = await updateGuardian(principal, {
    guardianId: params.guardianId,
    expectedVersion,
    ...changes,
  });

  sendSuccess(res, updated satisfies GuardianSummary);
};

/** `POST /students/:studentId/guardians` */
export const linkGuardianHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: StudentIdParams; body: LinkGuardianBody }>(req);

  const link = await linkGuardianToStudent(principal, {
    studentId: params.studentId,
    guardianId: body.guardianId,
    ...(body.relationship !== undefined ? { relationship: body.relationship } : {}),
    ...(body.isPrimaryContact !== undefined ? { isPrimaryContact: body.isPrimaryContact } : {}),
    ...(body.isFinanciallyResponsible !== undefined
      ? { isFinanciallyResponsible: body.isFinanciallyResponsible }
      : {}),
    ...(body.canViewFinancials !== undefined ? { canViewFinancials: body.canViewFinancials } : {}),
    ...(body.canInitiatePayments !== undefined
      ? { canInitiatePayments: body.canInitiatePayments }
      : {}),
  });

  sendCreated(res, link satisfies StudentGuardianLink);
};

/** `PATCH /guardian-links/:linkId` — the flags here decide who may see and pay. */
export const updateLinkHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: LinkIdParams; body: UpdateLinkBody }>(req);

  const updated = await updateGuardianLink(principal, {
    linkId: params.linkId,
    expectedVersion: body.expectedVersion,
    ...(body.relationship !== undefined ? { relationship: body.relationship } : {}),
    ...(body.isPrimaryContact !== undefined ? { isPrimaryContact: body.isPrimaryContact } : {}),
    ...(body.isFinanciallyResponsible !== undefined
      ? { isFinanciallyResponsible: body.isFinanciallyResponsible }
      : {}),
    ...(body.canViewFinancials !== undefined ? { canViewFinancials: body.canViewFinancials } : {}),
    ...(body.canInitiatePayments !== undefined
      ? { canInitiatePayments: body.canInitiatePayments }
      : {}),
  });

  sendSuccess(res, updated satisfies StudentGuardianLink);
};

/**
 * `DELETE /guardian-links/:linkId`
 *
 * Removes the guardian's access to this student. Payments they already made are
 * untouched — those belong to the student's financial history, not to the link.
 */
export const unlinkGuardianHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: LinkIdParams }>(req);

  await unlinkGuardian(principal, params.linkId);
  res.status(HttpStatus.NO_CONTENT).send();
};
