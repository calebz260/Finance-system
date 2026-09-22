/**
 * Reconciliation endpoints.
 *
 * Thin, like every controller here. The one thing that belongs at this layer is the
 * statement upload: it is held in memory and parsed, and the file itself is never stored.
 *
 * That is a deliberate difference from proof of payment, which *is* stored. A bank slip is
 * evidence behind one credit and has to still be there years later; a statement export is
 * a transport for rows that are themselves stored, with the file's checksum kept so the
 * same export cannot be imported twice. Keeping the file as well would mean holding every
 * family's transactions in a second place for no additional answer (Sections 22, 24).
 */
import type { Request, Response } from 'express';
import multer from 'multer';

import {
  buildPaginationMeta,
  type ReconciliationSummary,
  type StatementImportDetail,
  type StatementImportPreview,
  type StatementImportResult,
  type StatementLineSummary,
  type StatementLineWorklist,
  type StatementMatchResult,
} from '@sfs/shared';

import { PayloadTooLargeError, ValidationError } from '../../lib/errors.js';
import { resolvePagination, sendCreated, sendPaginated, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { detectFormat } from '../imports/spreadsheet.js';
import type {
  IgnoreLineBody,
  ImportIdParams,
  ImportStatementFields,
  LineIdParams,
  ListImportsQuery,
  ListLinesQuery,
  MatchLineBody,
  ReconciliationSummaryQuery,
  UnmatchLineBody,
} from './reconciliation.schema.js';
import {
  commitStatementImport,
  getReconciliationSummary,
  getStatementImport,
  ignoreStatementLine,
  listStatementImports,
  listStatementLines,
  matchStatementLine,
  previewStatementImport,
  requireStatementFile,
  unmatchStatementLine,
} from './reconciliation.service.js';

/** A month of transactions for a school is tens of kilobytes, not megabytes. */
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

/**
 * Multer, configured to keep the statement in memory.
 *
 * The extension check refuses a file this system cannot read before any of it is parsed.
 * The browser's content type is not consulted, because an `.xlsx` arrives variously as the
 * correct long `openxmlformats` string, `application/octet-stream`, or nothing at all.
 */
export const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_STATEMENT_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, callback) => {
    if (detectFormat(file.originalname) === null) {
      callback(new ValidationError('Upload the statement as a .csv or .xlsx file.'));
      return;
    }
    callback(null, true);
  },
});

export function translateStatementUploadError(error: unknown): unknown {
  if (!(error instanceof multer.MulterError)) return error;

  if (error.code === 'LIMIT_FILE_SIZE') {
    return new PayloadTooLargeError(
      `That statement is larger than ${String(MAX_STATEMENT_BYTES / (1024 * 1024))} MB. ` +
        'Export one month at a time.',
    );
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return new ValidationError('Upload exactly one file, in the "file" field.');
  }
  return new ValidationError('That upload could not be read.');
}

/* ------------------------------------------------------------------ import */

/**
 * `POST /reconciliation/statements/preview`
 *
 * Reports what the file contains and what is wrong with it. Stores nothing — which is why
 * it needs only `reconciliation.read`.
 */
export const previewStatementHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const file = requireStatementFile(req.file ?? {});

  sendSuccess(
    res,
    (await previewStatementImport(principal, file)) satisfies StatementImportPreview,
  );
};

/** `POST /reconciliation/statements` — import the file and run the automatic pass. */
export const importStatementHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: ImportStatementFields }>(req);
  const file = requireStatementFile(req.file ?? {});

  const result = (await commitStatementImport(
    principal,
    file,
    body,
  )) satisfies StatementImportResult;

  sendCreated(res, result, `/api/v1/reconciliation/statements/${result.statement.id}`);
};

/* ------------------------------------------------------------------- reads */

export const listStatementsHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListImportsQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listStatementImports(principal, pagination);

  sendPaginated(res, {
    items: result.items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: result.totalItems,
  });
};

export const getStatementHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: ImportIdParams }>(req);

  sendSuccess(
    res,
    (await getStatementImport(principal, params.importId)) satisfies StatementImportDetail,
  );
};

/**
 * `GET /reconciliation/lines`
 *
 * The worklist across every statement. The candidates travel in the body alongside the
 * lines, and the pagination in `meta`: a screen that fetched suggestions per row would
 * make a hundred requests to render a month's statement.
 */
export const listLinesHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListLinesQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listStatementLines(principal, query, pagination);

  sendSuccess(
    res,
    { lines: result.items, suggestions: result.suggestions } satisfies StatementLineWorklist,
    {
      // Spread into a plain object because `sendSuccess` takes free-form meta: the
      // pagination shape is the same one every list endpoint returns, so a client reads
      // it the same way here.
      meta: {
        ...buildPaginationMeta({
          page: pagination.page,
          pageSize: pagination.pageSize,
          totalItems: result.totalItems,
        }),
      },
    },
  );
};

export const reconciliationSummaryHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ReconciliationSummaryQuery }>(req);

  sendSuccess(
    res,
    (await getReconciliationSummary(principal, query)) satisfies ReconciliationSummary,
  );
};

/* ---------------------------------------------------------------- decisions */

export const matchLineHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: LineIdParams; body: MatchLineBody }>(req);

  sendSuccess(
    res,
    (await matchStatementLine(principal, params.lineId, body)) satisfies StatementMatchResult,
  );
};

export const unmatchLineHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: LineIdParams; body: UnmatchLineBody }>(req);

  sendSuccess(
    res,
    (await unmatchStatementLine(principal, params.lineId, body)) satisfies StatementLineSummary,
  );
};

export const ignoreLineHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: LineIdParams; body: IgnoreLineBody }>(req);

  sendSuccess(
    res,
    (await ignoreStatementLine(principal, params.lineId, body)) satisfies StatementLineSummary,
  );
};
