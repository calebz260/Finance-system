/**
 * Fee, charge and adjustment endpoints.
 *
 * Thin, like every controller here: translate HTTP into a service call and back. The one
 * thing worth noting is the student financial view, which assembles a balance, its
 * per-period breakdown, the charges and the adjustments in a single response — because
 * that is how the screen asks for it, and four round trips to render one page would make
 * the numbers capable of disagreeing with each other mid-load.
 */
import type { Request, Response } from 'express';

import type {
  ChargeRunPreview,
  ChargeRunResult,
  FeeCategorySummary,
  FeeStructureSummary,
  ReliefSummary,
  ScholarshipSummary,
  StudentBalance,
  StudentChargeSummary,
  StudentFinancialSummary,
} from '@sfs/shared';

import { resolvePagination, sendCreated, sendPaginated, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { getStudentBalance, getStudentBalanceByPeriod } from './balance.service.js';
import {
  cancelRelief,
  createScholarship,
  decideRelief,
  getRelief,
  getScholarship,
  listReliefs,
  listScholarships,
  requestRelief,
  reverseRelief,
  updateScholarship,
} from './relief.service.js';
import { listStudentEntries } from './entry.service.js';
import {
  applyChargeRun,
  createAdHocCharge,
  getCharge,
  listCharges,
  previewChargeRun,
  voidCharge,
} from './charge.service.js';
import {
  createFeeCategory,
  getFeeCategory,
  listFeeCategories,
  updateFeeCategory,
} from './fee-category.service.js';
import {
  addFeeStructureItem,
  changeFeeStructureStatus,
  createFeeStructure,
  getFeeStructure,
  listFeeStructures,
  removeFeeStructureItem,
  updateFeeStructure,
  updateFeeStructureItem,
} from './fee-structure.service.js';
import type {
  AddStructureItemBody,
  CancelReliefBody,
  CategoryIdParams,
  ChangeStructureStatusBody,
  ChargeIdParams,
  ChargeRunBody,
  CreateCategoryBody,
  CreateChargeBody,
  CreateScholarshipBody,
  CreateStructureBody,
  DecideReliefBody,
  ListCategoriesQuery,
  ListChargesQuery,
  ListReliefsQuery,
  ListScholarshipsQuery,
  ListStructuresQuery,
  ReliefKindParams,
  ReliefParams,
  RequestReliefBody,
  ReverseReliefBody,
  ScholarshipIdParams,
  StructureIdParams,
  StructureItemParams,
  StudentFinancialQuery,
  StudentIdParams,
  UpdateCategoryBody,
  UpdateScholarshipBody,
  UpdateStructureBody,
  UpdateStructureItemBody,
  VoidChargeBody,
} from './fee.schema.js';

/* ------------------------------------------------------------- categories */

export const listCategoriesHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListCategoriesQuery }>(req);

  sendSuccess(
    res,
    (await listFeeCategories(principal, {
      includeInactive: query.includeInactive,
    })) satisfies readonly FeeCategorySummary[],
  );
};

export const getCategoryHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: CategoryIdParams }>(req);

  sendSuccess(res, await getFeeCategory(principal, params.categoryId));
};

export const createCategoryHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateCategoryBody }>(req);

  const created = await createFeeCategory(principal, body);
  sendCreated(res, created, `/api/v1/fee-categories/${created.id}`);
};

export const updateCategoryHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: CategoryIdParams; body: UpdateCategoryBody }>(req);

  sendSuccess(res, await updateFeeCategory(principal, params.categoryId, body));
};

/* ------------------------------------------------------------- structures */

export const listStructuresHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListStructuresQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listFeeStructures(
    principal,
    {
      ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
      ...(query.termId !== undefined ? { termId: query.termId } : {}),
      ...(query.levelId !== undefined ? { levelId: query.levelId } : {}),
      ...(query.programId !== undefined ? { programId: query.programId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
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

export const getStructureHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: StructureIdParams }>(req);

  sendSuccess(
    res,
    (await getFeeStructure(principal, params.structureId)) satisfies FeeStructureSummary,
  );
};

export const createStructureHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateStructureBody }>(req);

  const created = await createFeeStructure(principal, body);
  sendCreated(res, created, `/api/v1/fee-structures/${created.id}`);
};

export const updateStructureHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: StructureIdParams; body: UpdateStructureBody }>(req);

  sendSuccess(res, await updateFeeStructure(principal, params.structureId, body));
};

export const changeStructureStatusHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: StructureIdParams;
    body: ChangeStructureStatusBody;
  }>(req);

  sendSuccess(res, await changeFeeStructureStatus(principal, params.structureId, body));
};

export const addStructureItemHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: StructureIdParams; body: AddStructureItemBody }>(
    req,
  );

  sendCreated(res, await addFeeStructureItem(principal, params.structureId, body));
};

export const updateStructureItemHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: StructureItemParams;
    body: UpdateStructureItemBody;
  }>(req);

  sendSuccess(
    res,
    await updateFeeStructureItem(principal, params.structureId, params.itemId, body),
  );
};

export const removeStructureItemHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: StructureItemParams }>(req);

  sendSuccess(res, await removeFeeStructureItem(principal, params.structureId, params.itemId));
};

/* ---------------------------------------------------------------- charges */

export const listChargesHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListChargesQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listCharges(
    principal,
    {
      ...(query.studentId !== undefined ? { studentId: query.studentId } : {}),
      ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
      ...(query.termId !== undefined ? { termId: query.termId } : {}),
      ...(query.feeCategoryId !== undefined ? { feeCategoryId: query.feeCategoryId } : {}),
      ...(query.levelId !== undefined ? { levelId: query.levelId } : {}),
      ...(query.classSectionId !== undefined ? { classSectionId: query.classSectionId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.raisedFrom !== undefined ? { raisedFrom: new Date(query.raisedFrom) } : {}),
      // Inclusive of the whole day: a filter "to 2026-03-31" that excluded charges
      // raised that afternoon would quietly under-report a month.
      ...(query.raisedTo !== undefined
        ? { raisedTo: new Date(`${query.raisedTo}T23:59:59.999Z`) }
        : {}),
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

export const getChargeHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: ChargeIdParams }>(req);

  sendSuccess(res, (await getCharge(principal, params.chargeId)) satisfies StudentChargeSummary);
};

export const createChargeHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateChargeBody }>(req);

  const created = await createAdHocCharge(principal, body);
  sendCreated(res, created, `/api/v1/charges/${created.id}`);
};

export const voidChargeHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: ChargeIdParams; body: VoidChargeBody }>(req);

  sendSuccess(res, await voidCharge(principal, params.chargeId, body));
};

/* ------------------------------------------------------------ charge runs */

export const previewChargeRunHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: ChargeRunBody }>(req);

  sendSuccess(res, (await previewChargeRun(principal, body)) satisfies ChargeRunPreview);
};

export const applyChargeRunHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: ChargeRunBody }>(req);

  sendCreated(res, (await applyChargeRun(principal, body)) satisfies ChargeRunResult);
};

/* ------------------------------------------------------------------ relief */

export const listReliefsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListReliefsQuery }>(req);

  sendSuccess(
    res,
    (await listReliefs(principal, {
      ...(query.studentId !== undefined ? { studentId: query.studentId } : {}),
      ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
      ...(query.termId !== undefined ? { termId: query.termId } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    })) satisfies readonly ReliefSummary[],
  );
};

export const getReliefHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: ReliefParams }>(req);

  sendSuccess(res, await getRelief(principal, params.kind, params.reliefId));
};

export const requestReliefHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: ReliefKindParams; body: RequestReliefBody }>(req);

  const created = await requestRelief(principal, params.kind, body);
  sendCreated(res, created, `/api/v1/relief/${params.kind}/${created.id}`);
};

export const decideReliefHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: ReliefParams; body: DecideReliefBody }>(req);

  sendSuccess(res, await decideRelief(principal, params.kind, params.reliefId, body));
};

export const cancelReliefHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: ReliefParams; body: CancelReliefBody }>(req);

  sendSuccess(res, await cancelRelief(principal, params.kind, params.reliefId, body));
};

export const reverseReliefHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: ReliefParams; body: ReverseReliefBody }>(req);

  sendSuccess(res, await reverseRelief(principal, params.kind, params.reliefId, body));
};

/* --------------------------------------------------- scholarship programmes */

export const listScholarshipsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListScholarshipsQuery }>(req);

  sendSuccess(
    res,
    (await listScholarships(principal, {
      includeInactive: query.includeInactive,
    })) satisfies readonly ScholarshipSummary[],
  );
};

export const getScholarshipHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: ScholarshipIdParams }>(req);

  sendSuccess(res, await getScholarship(principal, params.scholarshipId));
};

export const createScholarshipHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateScholarshipBody }>(req);

  const created = await createScholarship(principal, body);
  sendCreated(res, created, `/api/v1/scholarships/${created.id}`);
};

export const updateScholarshipHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: ScholarshipIdParams;
    body: UpdateScholarshipBody;
  }>(req);

  sendSuccess(res, await updateScholarship(principal, params.scholarshipId, body));
};

/* ------------------------------------------------------- student finances */

export const getStudentBalanceHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, query } = validated<{
    params: StudentIdParams;
    query: StudentFinancialQuery;
  }>(req);

  sendSuccess(
    res,
    (await getStudentBalance(principal.scope, params.studentId, {
      ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
      ...(query.termId !== undefined ? { termId: query.termId } : {}),
    })) satisfies StudentBalance,
  );
};

/**
 * `GET /students/:studentId/financials`
 *
 * The whole picture for one student: the balance, how it splits by period, the charges
 * behind it and every adjustment that moved it. Assembled server-side so the figures on
 * screen are guaranteed to be the same figures the balance was computed from.
 */
export const getStudentFinancialsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, query } = validated<{
    params: StudentIdParams;
    query: StudentFinancialQuery;
  }>(req);

  const period = {
    ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
    ...(query.termId !== undefined ? { termId: query.termId } : {}),
  };

  // A student's full financial history is bounded by their years at the school, so one
  // generous page is the whole record rather than an arbitrary truncation.
  const pagination = resolvePagination({ page: 1, pageSize: 200 });

  const [balance, periods, charges, reliefs, entries] = await Promise.all([
    getStudentBalance(principal.scope, params.studentId, period),
    getStudentBalanceByPeriod(principal.scope, params.studentId),
    listCharges(principal, { studentId: params.studentId, ...period }, pagination),
    listReliefs(principal, { studentId: params.studentId, ...period }),
    listStudentEntries(principal, params.studentId, period),
  ]);

  sendSuccess(res, {
    balance,
    periods,
    charges: charges.items,
    reliefs,
    entries,
  } satisfies StudentFinancialSummary);
};
