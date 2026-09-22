/**
 * Typed calls to the reconciliation endpoints.
 *
 * Money crosses this boundary as a string in both directions, as everywhere else. The one
 * thing worth noting is that the preview and the import are two calls with the same
 * payload: the first writes nothing, and a bursar is expected to look at it before the
 * second. The client never skips straight to the import (ADR-015).
 */
import type {
  PaginatedResponse,
  PaymentProviderKeyValue,
  ReconciliationSummary,
  StatementImportDetail,
  StatementImportPreview,
  StatementImportResult,
  StatementLineMatchStatusValue,
  StatementLineSummary,
  StatementLineWorklist,
  StatementMatchResult,
} from '@sfs/shared';

import { api, requestPaginated } from './api-client';
import { uploadFile } from './upload';

/* ------------------------------------------------------------------ import */

export function previewStatement(file: File): Promise<StatementImportPreview> {
  return uploadFile<StatementImportPreview>('/api/v1/reconciliation/statements/preview', file, {});
}

export function importStatement(
  file: File,
  fields: { provider: PaymentProviderKeyValue; accountLabel?: string; notes?: string },
): Promise<StatementImportResult> {
  return uploadFile<StatementImportResult>('/api/v1/reconciliation/statements', file, {
    provider: fields.provider,
    ...(fields.accountLabel !== undefined ? { accountLabel: fields.accountLabel } : {}),
    ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
  });
}

/* ------------------------------------------------------------------- reads */

export function listStatements(
  query: { page?: number; pageSize?: number } = {},
): Promise<PaginatedResponse<StatementImportResult['statement']>> {
  return requestPaginated<StatementImportResult['statement']>('/api/v1/reconciliation/statements', {
    query: { ...query },
  });
}

export function getStatement(importId: string): Promise<StatementImportDetail> {
  return api.get<StatementImportDetail>(`/api/v1/reconciliation/statements/${importId}`);
}

export interface LineFilters {
  readonly importId?: string;
  readonly matchStatus?: StatementLineMatchStatusValue;
  readonly direction?: 'MONEY_IN' | 'MONEY_OUT';
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export function listLines(filters: LineFilters = {}): Promise<StatementLineWorklist> {
  return api.get<StatementLineWorklist>('/api/v1/reconciliation/lines', {
    query: { ...filters },
  });
}

export function getReconciliationSummary(
  query: { importId?: string; from?: string; to?: string } = {},
): Promise<ReconciliationSummary> {
  return api.get<ReconciliationSummary>('/api/v1/reconciliation/summary', {
    query: { ...query },
  });
}

/* ---------------------------------------------------------------- decisions */

export function matchLine(
  lineId: string,
  body: {
    expectedVersion: number;
    paymentId: string;
    /** Credit the payment as well as attributing the line. */
    confirmPayment?: boolean;
    note?: string;
  },
): Promise<StatementMatchResult> {
  return api.post<StatementMatchResult>(`/api/v1/reconciliation/lines/${lineId}/match`, body);
}

export function unmatchLine(
  lineId: string,
  body: { expectedVersion: number; reason: string },
): Promise<StatementLineSummary> {
  return api.post<StatementLineSummary>(`/api/v1/reconciliation/lines/${lineId}/unmatch`, body);
}

export function ignoreLine(
  lineId: string,
  body: { expectedVersion: number; reason: string },
): Promise<StatementLineSummary> {
  return api.post<StatementLineSummary>(`/api/v1/reconciliation/lines/${lineId}/ignore`, body);
}
