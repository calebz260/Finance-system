/**
 * Typed calls to the academic-structure endpoints.
 *
 * These are read far more often than they are written: the registration form, the
 * enrolment form and the import all need the level and class lists before they can
 * show anything.
 */
import type {
  AcademicYearSummary,
  ClassSectionSummary,
  DepartmentSummary,
  LevelSummary,
  ProgramSummary,
} from '@sfs/shared';

import { api } from './api-client';

export function listAcademicYears(): Promise<readonly AcademicYearSummary[]> {
  return api.get<readonly AcademicYearSummary[]>('/api/v1/academic-years');
}

/** Null when a school has not configured one yet, which is a normal setup state. */
export function getCurrentAcademicYear(): Promise<AcademicYearSummary | null> {
  return api.get<AcademicYearSummary | null>('/api/v1/academic-years/current');
}

export function createAcademicYear(body: {
  name: string;
  startDate: string;
  endDate: string;
}): Promise<AcademicYearSummary> {
  return api.post<AcademicYearSummary>('/api/v1/academic-years', body);
}

export function setCurrentAcademicYear(academicYearId: string): Promise<AcademicYearSummary> {
  return api.put<AcademicYearSummary>(`/api/v1/academic-years/${academicYearId}/current`);
}

export function createTerm(body: {
  academicYearId: string;
  name: string;
  sequence: number;
  startDate: string;
  endDate: string;
}): Promise<unknown> {
  return api.post('/api/v1/terms', body);
}

export function setCurrentTerm(termId: string): Promise<unknown> {
  return api.put(`/api/v1/terms/${termId}/current`);
}

export function listDepartments(): Promise<readonly DepartmentSummary[]> {
  return api.get<readonly DepartmentSummary[]>('/api/v1/departments');
}

export function listPrograms(): Promise<readonly ProgramSummary[]> {
  return api.get<readonly ProgramSummary[]>('/api/v1/programs');
}

export function createProgram(body: {
  code: string;
  name: string;
  durationYears?: number | null;
}): Promise<ProgramSummary> {
  return api.post<ProgramSummary>('/api/v1/programs', body);
}

export function listLevels(programId?: string): Promise<readonly LevelSummary[]> {
  return api.get<readonly LevelSummary[]>('/api/v1/levels', {
    ...(programId !== undefined ? { query: { programId } } : {}),
  });
}

export function createLevel(body: {
  programId: string;
  code: string;
  name: string;
  sequence: number;
  isTerminal?: boolean;
}): Promise<LevelSummary> {
  return api.post<LevelSummary>('/api/v1/levels', body);
}

export function listClassSections(query: {
  academicYearId?: string;
  levelId?: string;
}): Promise<readonly ClassSectionSummary[]> {
  return api.get<readonly ClassSectionSummary[]>('/api/v1/class-sections', { query });
}

export function createClassSection(body: {
  academicYearId: string;
  levelId: string;
  code: string;
  name: string;
  capacity?: number | null;
}): Promise<ClassSectionSummary> {
  return api.post<ClassSectionSummary>('/api/v1/class-sections', body);
}
