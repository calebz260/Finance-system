/**
 * Typed calls to the fee, charge and relief endpoints.
 *
 * Every monetary value crossing this boundary is a **string**, in both directions. The
 * browser formats amounts and never computes one: a balance shown on screen is the
 * balance the backend derived from the ledger, not a subtraction done in React
 * (Section 13A).
 */
import type {
  ChargeRunPreview,
  ChargeRunResult,
  FeeCategorySummary,
  FeeStructureSummary,
  PaginatedResponse,
  ReliefKind,
  ReliefSummary,
  ScholarshipSummary,
  StudentBalance,
  StudentChargeSummary,
  StudentFinancialSummary,
} from '@sfs/shared';

import { api, requestPaginated } from './api-client';

/* -------------------------------------------------------------- categories */

export function listFeeCategories(
  options: { includeInactive?: boolean } = {},
): Promise<readonly FeeCategorySummary[]> {
  return api.get<readonly FeeCategorySummary[]>('/api/v1/fee-categories', {
    // Sent as a string because the API reads it from the query string, where a boolean
    // has no representation of its own.
    query: { includeInactive: options.includeInactive === true ? 'true' : undefined },
  });
}

export function createFeeCategory(body: {
  code: string;
  name: string;
  description?: string;
}): Promise<FeeCategorySummary> {
  return api.post<FeeCategorySummary>('/api/v1/fee-categories', body);
}

export function updateFeeCategory(
  categoryId: string,
  body: { expectedVersion: number; name?: string; isActive?: boolean },
): Promise<FeeCategorySummary> {
  return api.patch<FeeCategorySummary>(`/api/v1/fee-categories/${categoryId}`, body);
}

/* -------------------------------------------------------------- structures */

export interface FeeStructureFilters {
  readonly academicYearId?: string;
  readonly termId?: string;
  readonly status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  readonly page?: number;
  readonly pageSize?: number;
}

export function listFeeStructures(
  filters: FeeStructureFilters = {},
): Promise<PaginatedResponse<FeeStructureSummary>> {
  return requestPaginated<FeeStructureSummary>('/api/v1/fee-structures', { query: { ...filters } });
}

export function getFeeStructure(structureId: string): Promise<FeeStructureSummary> {
  return api.get<FeeStructureSummary>(`/api/v1/fee-structures/${structureId}`);
}

export interface CreateFeeStructureBody {
  readonly name: string;
  readonly description?: string;
  readonly academicYearId: string;
  /** Null for a fee charged once per year rather than per term. */
  readonly termId: string | null;
  readonly programId?: string | null;
  readonly levelId?: string | null;
  readonly residency?: 'DAY' | 'BOARDING' | null;
  readonly items: ReadonlyArray<{ feeCategoryId: string; label: string; amount: string }>;
}

export function createFeeStructure(body: CreateFeeStructureBody): Promise<FeeStructureSummary> {
  return api.post<FeeStructureSummary>('/api/v1/fee-structures', body);
}

export function changeFeeStructureStatus(
  structureId: string,
  body: { expectedVersion: number; status: 'ACTIVE' | 'ARCHIVED' },
): Promise<FeeStructureSummary> {
  return api.put<FeeStructureSummary>(`/api/v1/fee-structures/${structureId}/status`, body);
}

/* ----------------------------------------------------------------- charges */

export interface ChargeFilters {
  readonly studentId?: string;
  readonly academicYearId?: string;
  readonly termId?: string;
  readonly feeCategoryId?: string;
  readonly status?: 'RAISED' | 'VOID';
  readonly page?: number;
  readonly pageSize?: number;
}

export function listCharges(
  filters: ChargeFilters = {},
): Promise<PaginatedResponse<StudentChargeSummary>> {
  return requestPaginated<StudentChargeSummary>('/api/v1/charges', { query: { ...filters } });
}

export function createCharge(body: {
  studentId: string;
  feeCategoryId: string;
  academicYearId: string;
  termId?: string | null;
  description: string;
  amount: string;
  notes: string;
}): Promise<StudentChargeSummary> {
  return api.post<StudentChargeSummary>('/api/v1/charges', body);
}

export function voidCharge(
  chargeId: string,
  body: { expectedVersion: number; reason: string },
): Promise<StudentChargeSummary> {
  return api.post<StudentChargeSummary>(`/api/v1/charges/${chargeId}/void`, body);
}

/* ------------------------------------------------------------- charge runs */

export interface ChargeRunBody {
  readonly academicYearId: string;
  readonly termId: string | null;
  readonly feeStructureId?: string;
}

export function previewChargeRun(body: ChargeRunBody): Promise<ChargeRunPreview> {
  return api.post<ChargeRunPreview>('/api/v1/charge-runs/preview', body);
}

export function applyChargeRun(body: ChargeRunBody): Promise<ChargeRunResult> {
  return api.post<ChargeRunResult>('/api/v1/charge-runs', body);
}

/* ------------------------------------------------------------------ relief */

export interface ReliefFilters {
  readonly studentId?: string;
  readonly academicYearId?: string;
  readonly kind?: ReliefKind;
  readonly status?: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVERSED';
}

export function listReliefs(filters: ReliefFilters = {}): Promise<readonly ReliefSummary[]> {
  return api.get<readonly ReliefSummary[]>('/api/v1/relief', { query: { ...filters } });
}

export interface RequestReliefBody {
  readonly studentId: string;
  readonly studentChargeId?: string | null;
  readonly academicYearId: string;
  readonly termId?: string | null;
  readonly scholarshipId?: string;
  readonly direction?: 'DEBIT' | 'CREDIT';
  /** Exactly one of these. */
  readonly amount?: string;
  readonly percentage?: string;
  readonly reason: string;
}

export function requestRelief(kind: ReliefKind, body: RequestReliefBody): Promise<ReliefSummary> {
  return api.post<ReliefSummary>(`/api/v1/relief/${kind}`, body);
}

export function decideRelief(
  kind: ReliefKind,
  reliefId: string,
  body: { expectedVersion: number; decision: 'APPROVE' | 'REJECT'; note?: string },
): Promise<ReliefSummary> {
  return api.post<ReliefSummary>(`/api/v1/relief/${kind}/${reliefId}/decision`, body);
}

export function reverseRelief(
  kind: ReliefKind,
  reliefId: string,
  body: { expectedVersion: number; reason: string },
): Promise<ReliefSummary> {
  return api.post<ReliefSummary>(`/api/v1/relief/${kind}/${reliefId}/reverse`, body);
}

/* ------------------------------------------------------------ scholarships */

export function listScholarships(): Promise<readonly ScholarshipSummary[]> {
  return api.get<readonly ScholarshipSummary[]>('/api/v1/scholarships');
}

export function createScholarship(body: {
  code: string;
  name: string;
  description?: string;
  sponsor?: string;
}): Promise<ScholarshipSummary> {
  return api.post<ScholarshipSummary>('/api/v1/scholarships', body);
}

/* -------------------------------------------------------- student finances */

export function getStudentBalance(studentId: string): Promise<StudentBalance> {
  return api.get<StudentBalance>(`/api/v1/students/${studentId}/balance`);
}

export function getStudentFinancials(
  studentId: string,
  filters: { academicYearId?: string; termId?: string } = {},
): Promise<StudentFinancialSummary> {
  return api.get<StudentFinancialSummary>(`/api/v1/students/${studentId}/financials`, {
    query: { ...filters },
  });
}
