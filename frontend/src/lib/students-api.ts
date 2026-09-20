/**
 * Typed calls to the student, guardian, enrolment and import endpoints.
 *
 * The import calls send `multipart/form-data` rather than JSON, so they bypass
 * `api-client`'s body handling and are written out here — with the one thing that
 * matters kept intact: the bearer token and the credentialed request, so a session
 * that renews mid-upload still works.
 */
import type {
  EnrollmentSummary,
  GuardianRelation,
  GuardianSummary,
  ImportPreview,
  ImportResult,
  PaginatedResponse,
  StudentDetail,
  StudentGuardianLink,
  StudentState,
  StudentSummary,
} from '@sfs/shared';

import { api, requestPaginated } from './api-client';
import { uploadFile } from './upload';

export interface StudentListQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly status?: StudentState;
  readonly levelId?: string;
  readonly classSectionId?: string;
}

export function listStudents(
  query: StudentListQuery = {},
): Promise<PaginatedResponse<StudentSummary>> {
  return requestPaginated<StudentSummary>('/api/v1/students', { query: { ...query } });
}

export function getStudent(studentId: string): Promise<StudentDetail> {
  return api.get<StudentDetail>(`/api/v1/students/${studentId}`);
}

export interface RegisterStudentInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly otherNames?: string | null;
  readonly gender?: 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';
  readonly dateOfBirth?: string | null;
  readonly admissionDate: string;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly enrolment: {
    readonly levelId: string;
    readonly classSectionId?: string | null;
    readonly residency?: 'DAY' | 'BOARDING';
  };
}

export function registerStudent(input: RegisterStudentInput): Promise<StudentDetail> {
  return api.post<StudentDetail>('/api/v1/students', input);
}

export function updateStudent(
  studentId: string,
  body: Record<string, unknown> & { expectedVersion: number },
): Promise<StudentDetail> {
  return api.patch<StudentDetail>(`/api/v1/students/${studentId}`, body);
}

export function changeStudentStatus(
  studentId: string,
  body: {
    expectedVersion: number;
    status: StudentState;
    reason?: string;
    effectiveDate?: string;
  },
): Promise<StudentDetail> {
  return api.put<StudentDetail>(`/api/v1/students/${studentId}/status`, body);
}

export function listStudentEnrollments(studentId: string): Promise<readonly EnrollmentSummary[]> {
  return api.get<readonly EnrollmentSummary[]>(`/api/v1/students/${studentId}/enrolments`);
}

/* ------------------------------------------------------------------- guardians */

export function listGuardians(
  query: { page?: number; pageSize?: number; search?: string } = {},
): Promise<PaginatedResponse<GuardianSummary>> {
  return requestPaginated<GuardianSummary>('/api/v1/guardians', { query: { ...query } });
}

export function createGuardian(body: {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string | null;
  occupation?: string | null;
}): Promise<GuardianSummary> {
  return api.post<GuardianSummary>('/api/v1/guardians', body);
}

export function linkGuardian(
  studentId: string,
  body: {
    guardianId: string;
    relationship?: GuardianRelation;
    isPrimaryContact?: boolean;
    isFinanciallyResponsible?: boolean;
    canViewFinancials?: boolean;
    canInitiatePayments?: boolean;
  },
): Promise<StudentGuardianLink> {
  return api.post<StudentGuardianLink>(`/api/v1/students/${studentId}/guardians`, body);
}

export function unlinkGuardian(linkId: string): Promise<void> {
  return api.delete<void>(`/api/v1/guardian-links/${linkId}`);
}

/* ------------------------------------------------------------------ enrolment */

export function enrolStudent(body: {
  studentId: string;
  levelId: string;
  classSectionId?: string | null;
  residency?: 'DAY' | 'BOARDING';
  enrollmentType?: 'NEW' | 'CONTINUING' | 'REPEAT' | 'RE_ADMISSION' | 'TRANSFER_IN';
}): Promise<EnrollmentSummary> {
  return api.post<EnrollmentSummary>('/api/v1/enrolments', body);
}

export function moveClass(
  enrollmentId: string,
  body: { expectedVersion: number; classSectionId: string | null },
): Promise<EnrollmentSummary> {
  return api.patch<EnrollmentSummary>(`/api/v1/enrolments/${enrollmentId}`, body);
}

/* --------------------------------------------------------------- bulk import */

/** Validates and reports. Writes nothing, which is what makes it safe to run twice. */
export function previewImport(file: File): Promise<ImportPreview> {
  return uploadFile<ImportPreview>('/api/v1/students/import/preview', file);
}

export function commitImport(file: File, allowPartial: boolean): Promise<ImportResult> {
  return uploadFile<ImportResult>('/api/v1/students/import', file, {
    allowPartial: String(allowPartial),
  });
}
