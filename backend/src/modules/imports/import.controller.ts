/**
 * Bulk-import endpoints.
 *
 * The upload is held **in memory and never written to disk**. Phase 5 is where file
 * storage, its path rules and malware scanning are designed; parsing an import in
 * memory and discarding the buffer when the request ends keeps this feature from
 * quietly establishing an upload convention that Phase 5 would then have to undo.
 *
 * Three limits apply before a single byte is parsed: the size cap in the multer
 * configuration, a single-file cap, and an extension check. None of them trusts the
 * browser's `Content-Type`, which for `.xlsx` is variously the correct long
 * `openxmlformats` string, `application/octet-stream`, or nothing at all.
 */
import type { Request, Response } from 'express';
import multer from 'multer';

import { ErrorCode, type ImportPreview, type ImportResult } from '@sfs/shared';

import { DomainError, PayloadTooLargeError, ValidationError } from '../../lib/errors.js';
import { sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { commitStudentImport, previewStudentImport } from './student-import.service.js';
import { detectFormat, SpreadsheetError } from './spreadsheet.js';

/** Comfortably above a 1,000-row workbook, far below anything that strains memory. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Multer, configured to keep the file in memory.
 *
 * `memoryStorage` is the deliberate choice, not the default-shaped one: with disk
 * storage the file would land somewhere on the server before anyone had decided where
 * uploads belong, how long they live, or who may read them.
 */
export const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, callback) => {
    if (detectFormat(file.originalname) === null) {
      callback(new ValidationError('Upload a .csv or .xlsx file.'));
      return;
    }
    callback(null, true);
  },
});

/**
 * Translate multer's own failures into the shared error envelope.
 *
 * Without this a file one byte over the limit surfaces as an unhandled `MulterError`
 * and a generic 500, which tells the registrar nothing about what to do.
 */
export function translateUploadError(error: unknown): unknown {
  if (!(error instanceof multer.MulterError)) return error;

  if (error.code === 'LIMIT_FILE_SIZE') {
    return new PayloadTooLargeError(
      `That file is larger than ${String(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Split it and import in batches.`,
    );
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return new ValidationError('Upload exactly one file, in the "file" field.');
  }
  return new ValidationError('That upload could not be read.');
}

/** The uploaded file, or a clear refusal. */
function requireFile(req: Request): { fileName: string; buffer: Buffer } {
  const file = req.file;
  if (file === undefined) {
    throw new ValidationError('Attach a .csv or .xlsx file in the "file" field.');
  }
  return { fileName: file.originalname, buffer: file.buffer };
}

/** A parse failure is the user's file, not a server fault, so it reads as a 400. */
function asDomainError(error: unknown): unknown {
  if (error instanceof SpreadsheetError) {
    return new DomainError(ErrorCode.VALIDATION_FAILED, error.message, {
      ...(error.row !== undefined ? { details: { row: error.row } } : {}),
    });
  }
  return error;
}

/**
 * `POST /students/import/preview`
 *
 * Validates and reports. Writes nothing — which is the point: a registrar sees every
 * problem in their file before a single record is created.
 */
export const previewImportHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const file = requireFile(req);

  try {
    const preview = await previewStudentImport(principal, file);
    sendSuccess(res, preview satisfies ImportPreview);
  } catch (error) {
    throw asDomainError(error);
  }
};

/**
 * `POST /students/import`
 *
 * Applies the file in one transaction. By default a file with any problem imports
 * nothing; `allowPartial` opts into importing only the valid rows, which is a
 * deliberate choice rather than the default, because reconciling which rows landed is
 * the expensive part.
 */
export const commitImportHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const file = requireFile(req);

  // Multipart text fields arrive as strings on an untyped body, so this narrows before
  // comparing rather than trusting the shape. Anything other than the literal "true"
  // means the safe default: import nothing if any row failed.
  const fields: unknown = req.body;
  const allowPartial =
    typeof fields === 'object' &&
    fields !== null &&
    (fields as Record<string, unknown>).allowPartial === 'true';

  try {
    const result = await commitStudentImport(principal, file, { allowPartial });
    sendSuccess(res, result satisfies ImportResult);
  } catch (error) {
    throw asDomainError(error);
  }
};
