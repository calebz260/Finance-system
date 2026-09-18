/**
 * Helpers that make every response in the API look the same (Section 29).
 *
 * Controllers call these instead of `res.json(...)` directly, so the success and error
 * envelopes stay consistent and the request id is always echoed back for support.
 */
import type { Response } from 'express';

import {
  type ApiErrorBody,
  type ApiSuccessResponse,
  DEFAULT_PAGE_SIZE,
  type ErrorCode,
  type FieldError,
  MAX_PAGE_SIZE,
  type PaginatedResponse,
  buildPaginationMeta,
} from '@sfs/shared';

export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export function sendSuccess<TData>(
  res: Response,
  data: TData,
  options: { status?: number; meta?: Record<string, unknown> } = {},
): Response {
  const body: ApiSuccessResponse<TData> =
    options.meta === undefined ? { data } : { data, meta: options.meta };
  return res.status(options.status ?? HttpStatus.OK).json(body);
}

export function sendCreated<TData>(res: Response, data: TData, location?: string): Response {
  if (location !== undefined) res.setHeader('Location', location);
  return sendSuccess(res, data, { status: HttpStatus.CREATED });
}

export function sendNoContent(res: Response): Response {
  return res.status(HttpStatus.NO_CONTENT).send();
}

export function sendPaginated<TItem>(
  res: Response,
  args: { items: readonly TItem[]; page: number; pageSize: number; totalItems: number },
): Response {
  const body: PaginatedResponse<TItem> = {
    data: args.items,
    meta: buildPaginationMeta({
      page: args.page,
      pageSize: args.pageSize,
      totalItems: args.totalItems,
    }),
  };
  return res.status(HttpStatus.OK).json(body);
}

export function buildErrorBody(args: {
  code: ErrorCode;
  message: string;
  requestId: string;
  fieldErrors?: readonly FieldError[];
  details?: Readonly<Record<string, unknown>>;
}): ApiErrorBody {
  return {
    code: args.code,
    message: args.message,
    ...(args.fieldErrors !== undefined && args.fieldErrors.length > 0
      ? { fieldErrors: args.fieldErrors }
      : {}),
    ...(args.details !== undefined ? { details: args.details } : {}),
    requestId: args.requestId,
    timestamp: new Date().toISOString(),
  };
}

export interface ResolvedPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly skip: number;
  readonly take: number;
}

/**
 * Clamp pagination input into safe bounds. A client asking for 100 000 rows gets
 * MAX_PAGE_SIZE instead -- reports and payment tables must never stream the whole
 * table into a browser (Section 18).
 */
export function resolvePagination(input: {
  page?: number | undefined;
  pageSize?: number | undefined;
}): ResolvedPagination {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const requested = Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
