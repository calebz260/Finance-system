/**
 * Multipart uploads.
 *
 * Separate from `api-client` because a file upload is the one request that must *not*
 * go through its JSON body handling: the browser has to set the multipart boundary on
 * `Content-Type` itself, and setting that header by hand is the classic way to produce
 * an upload the server cannot parse.
 *
 * Everything else `api-client` guarantees is preserved deliberately — the bearer
 * token, credentialed requests, the shared error envelope, and the request id — so an
 * import that fails reports the same way as any other call, with a reference the
 * registrar can quote.
 */
import { ErrorCode, isApiErrorResponse, REQUEST_ID_HEADER } from '@sfs/shared';

import { API_BASE_URL, ApiError } from './api-client';
import { getAccessToken, refreshAccessToken } from './auth-token';

/** A thousand-row workbook is well under a megabyte; the server caps at five. */
const UPLOAD_TIMEOUT_MS = 120_000;

async function attempt<TData>(
  path: string,
  file: File,
  fields: Readonly<Record<string, string>>,
): Promise<TData> {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Upload timed out', 'TimeoutError'));
  }, UPLOAD_TIMEOUT_MS);

  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  // Note: no Content-Type. The browser adds it, with the boundary.

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (cause) {
    throw new ApiError({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'The file could not be sent. Check your connection and try again.',
      status: 0,
      cause,
    });
  } finally {
    clearTimeout(timeout);
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
  const rawText = await response.text();

  let payload: unknown;
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw new ApiError({
        code: payload.error.code,
        message: payload.error.message,
        status: response.status,
        fieldErrors: payload.error.fieldErrors ?? [],
        ...(payload.error.details !== undefined ? { details: payload.error.details } : {}),
        ...(payload.error.requestId !== undefined ? { requestId: payload.error.requestId } : {}),
      });
    }

    throw new ApiError({
      code: response.status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.MALFORMED_REQUEST,
      message:
        response.status === 413
          ? 'That file is too large to upload.'
          : 'The file could not be processed.',
      status: response.status,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new ApiError({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'The server returned an unexpected response.',
      status: response.status,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  return (payload as { data: TData }).data;
}

/**
 * Upload a file, renewing an expired access token once and retrying.
 *
 * The retry matters more here than elsewhere: parsing a thousand-row workbook is the
 * longest request in the system, and it is exactly where a fifteen-minute token
 * expires mid-flight.
 */
export async function uploadFile<TData>(
  path: string,
  file: File,
  fields: Readonly<Record<string, string>> = {},
): Promise<TData> {
  try {
    return await attempt<TData>(path, file, fields);
  } catch (error) {
    const expired = error instanceof ApiError && error.code === ErrorCode.TOKEN_EXPIRED;
    if (!expired) throw error;

    const renewed = await refreshAccessToken();
    if (renewed === null) throw error;

    return attempt<TData>(path, file, fields);
  }
}
