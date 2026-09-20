/**
 * Academic-structure endpoints.
 *
 * Thin, as everywhere: read the validated request, call the service, shape the
 * response. Every rule — date ordering, term overlap, the level chain, what a closed
 * period permits — lives in the service, where it can be tested without HTTP.
 */
import type { Request, Response } from 'express';

import type {
  AcademicYearSummary,
  ClassSectionSummary,
  DepartmentSummary,
  LevelSummary,
  ProgramSummary,
  TermSummary,
} from '@sfs/shared';

import { sendCreated, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import type {
  AcademicYearIdParams,
  ClassSectionIdParams,
  CreateAcademicYearBody,
  CreateClassSectionBody,
  CreateDepartmentBody,
  CreateLevelBody,
  CreateProgramBody,
  CreateTermBody,
  LevelIdParams,
  ListClassSectionsQuery,
  ListLevelsQuery,
  ListProgramsQuery,
  ProgramIdParams,
  SetLevelProgressionBody,
  TermIdParams,
  UpdateAcademicYearBody,
  UpdateClassSectionBody,
  UpdateProgramBody,
  UpdateTermBody,
} from './academic.schema.js';
import {
  createAcademicYear,
  createClassSection,
  createDepartment,
  createLevel,
  createProgram,
  createTerm,
  getCurrentAcademicYear,
  listAcademicYears,
  listClassSections,
  listDepartments,
  listLevels,
  listPrograms,
  setCurrentAcademicYear,
  setCurrentTerm,
  setLevelProgression,
  updateAcademicYear,
  updateClassSection,
  updateProgram,
  updateTerm,
} from './academic.service.js';

/* ------------------------------------------------------------- academic years */

export const listAcademicYearsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  sendSuccess(res, (await listAcademicYears(principal)) satisfies readonly AcademicYearSummary[]);
};

/**
 * `GET /academic-years/current`
 *
 * Answers `null` rather than 404 when none is set. A school that has not configured a
 * year yet is in a normal setup state, and the screen needs to say so rather than
 * render an error.
 */
export const getCurrentAcademicYearHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  sendSuccess(res, await getCurrentAcademicYear(principal));
};

export const createAcademicYearHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateAcademicYearBody }>(req);

  const created = await createAcademicYear(principal, {
    name: body.name,
    startDate: body.startDate,
    endDate: body.endDate,
    ...(body.status !== undefined ? { status: body.status } : {}),
  });

  sendCreated(res, created satisfies AcademicYearSummary, `/api/v1/academic-years/${created.id}`);
};

export const updateAcademicYearHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: AcademicYearIdParams;
    body: UpdateAcademicYearBody;
  }>(req);

  const updated = await updateAcademicYear(principal, {
    id: params.academicYearId,
    expectedVersion: body.expectedVersion,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
    ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  });

  sendSuccess(res, updated satisfies AcademicYearSummary);
};

export const setCurrentAcademicYearHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: AcademicYearIdParams }>(req);

  sendSuccess(res, await setCurrentAcademicYear(principal, params.academicYearId));
};

/* -------------------------------------------------------------------- terms */

export const createTermHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateTermBody }>(req);

  const created = await createTerm(principal, {
    academicYearId: body.academicYearId,
    name: body.name,
    sequence: body.sequence,
    startDate: body.startDate,
    endDate: body.endDate,
    ...(body.status !== undefined ? { status: body.status } : {}),
  });

  sendCreated(res, created satisfies TermSummary, `/api/v1/terms/${created.id}`);
};

export const updateTermHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: TermIdParams; body: UpdateTermBody }>(req);

  const updated = await updateTerm(principal, {
    id: params.termId,
    expectedVersion: body.expectedVersion,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
    ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
    ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  });

  sendSuccess(res, updated satisfies TermSummary);
};

export const setCurrentTermHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: TermIdParams }>(req);

  sendSuccess(res, await setCurrentTerm(principal, params.termId));
};

/* -------------------------------------------------------------- departments */

export const listDepartmentsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  sendSuccess(res, (await listDepartments(principal)) satisfies readonly DepartmentSummary[]);
};

export const createDepartmentHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateDepartmentBody }>(req);

  const created = await createDepartment(principal, {
    code: body.code,
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
  });

  sendCreated(res, created satisfies DepartmentSummary);
};

/* ---------------------------------------------------------------- programmes */

export const listProgramsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListProgramsQuery }>(req);

  const programs = await listPrograms(
    principal,
    query.status === undefined ? {} : { status: query.status },
  );
  sendSuccess(res, programs satisfies readonly ProgramSummary[]);
};

export const createProgramHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateProgramBody }>(req);

  const created = await createProgram(principal, {
    code: body.code,
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
    ...(body.durationYears !== undefined ? { durationYears: body.durationYears } : {}),
    ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
  });

  sendCreated(res, created satisfies ProgramSummary, `/api/v1/programs/${created.id}`);
};

export const updateProgramHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: ProgramIdParams; body: UpdateProgramBody }>(req);

  const updated = await updateProgram(principal, {
    id: params.programId,
    expectedVersion: body.expectedVersion,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
    ...(body.durationYears !== undefined ? { durationYears: body.durationYears } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
  });

  sendSuccess(res, updated satisfies ProgramSummary);
};

/* -------------------------------------------------------------------- levels */

export const listLevelsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListLevelsQuery }>(req);

  const levels = await listLevels(
    principal,
    query.programId === undefined ? {} : { programId: query.programId },
  );
  sendSuccess(res, levels satisfies readonly LevelSummary[]);
};

export const createLevelHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateLevelBody }>(req);

  const created = await createLevel(principal, {
    programId: body.programId,
    code: body.code,
    name: body.name,
    sequence: body.sequence,
    ...(body.isTerminal !== undefined ? { isTerminal: body.isTerminal } : {}),
  });

  sendCreated(res, created satisfies LevelSummary, `/api/v1/levels/${created.id}`);
};

/** `PUT /levels/:levelId/next` — the chain end-of-year promotion walks. */
export const setLevelProgressionHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: LevelIdParams;
    body: SetLevelProgressionBody;
  }>(req);

  const updated = await setLevelProgression(principal, {
    levelId: params.levelId,
    nextLevelId: body.nextLevelId,
  });

  sendSuccess(res, updated satisfies LevelSummary);
};

/* ------------------------------------------------------------- class sections */

export const listClassSectionsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListClassSectionsQuery }>(req);

  const sections = await listClassSections(principal, {
    ...(query.academicYearId !== undefined ? { academicYearId: query.academicYearId } : {}),
    ...(query.levelId !== undefined ? { levelId: query.levelId } : {}),
  });

  sendSuccess(res, sections satisfies readonly ClassSectionSummary[]);
};

export const createClassSectionHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateClassSectionBody }>(req);

  const created = await createClassSection(principal, {
    academicYearId: body.academicYearId,
    levelId: body.levelId,
    code: body.code,
    name: body.name,
    ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
    ...(body.classTeacherName !== undefined ? { classTeacherName: body.classTeacherName } : {}),
  });

  sendCreated(res, created satisfies ClassSectionSummary, `/api/v1/class-sections/${created.id}`);
};

export const updateClassSectionHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: ClassSectionIdParams;
    body: UpdateClassSectionBody;
  }>(req);

  const updated = await updateClassSection(principal, {
    id: params.classSectionId,
    expectedVersion: body.expectedVersion,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
    ...(body.classTeacherName !== undefined ? { classTeacherName: body.classTeacherName } : {}),
  });

  sendSuccess(res, updated satisfies ClassSectionSummary);
};
