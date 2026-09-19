/**
 * The single HTTP client for the web application.
 *
 * Everything the UI knows about the API goes through here, which is what lets the rest
 * of the app stay free of fetch boilerplate and error-shape guessing:
 *
 *  - Unwraps the shared `{ data }` / `{ error }` envelope.
 *  - Turns any failure -- HTTP error, network outage, timeout, unparseable body -- into
 *    one `ApiError` type carrying a machine-readable `code` the UI can branch on.
 *  - Surfaces the server's request id so a user can quote it to the bursar's office.
 *  - Sends credentials so the Phase 2 refresh cookie works without further changes.
 *
 * Money is always handled as the string the server sent. The client never does monetary
 * arithmetic (Section 3).
 */
import {
  type ApiErrorBody,
  type ApiSuccessResponse,
  ErrorCode,
  type FieldError,
  IDEMPOTENCY_KEY_HEADER,
  type PaginatedResponse,
  REQUEST_ID_HEADER,
  isApiErrorResponse,
} from '@sfs/shared';

import { getAccessToken, refreshAccessToken } from './auth-token';

const DEFAULT_TIMEOUT_MS = 20_000;

function resolveBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL;
  const base = typeof configured === 'string' && configured.length > 0 ? configured : '';
  return base.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveBaseUrl();

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors: readonly FieldError[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;

  constructor(args: {
    code: ErrorCode;
    message: string;
    status: number;
    fieldErrors?: readonly FieldError[];
    details?: Readonly<Record<string, unknown>>;
    requestId?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.fieldErrors = args.fieldErrors ?? [];
    if (args.details !== undefined) this.details = args.details;
    if (args.requestId !== undefined) this.requestId = args.requestId;
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return (
      this.code === ErrorCode.SERVICE_UNAVAILABLE ||
      this.code === ErrorCode.RATE_LIMITED ||
      this.code === ErrorCode.RECORD_MODIFIED ||
      this.status >= 500
    );
  }

  /** Field-level messages keyed by path, for attaching errors to form inputs. */
  get fieldErrorsByPath(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const fieldError of this.fieldErrors) {
      // Strip the `body.` / `query.` prefix so it matches the form field name.
      map[fieldError.path.replace(/^(body|query|params)\./, '')] = fieldError.message;
    }
    return map;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Required for payment initiation so a retry cannot create a second transaction. */
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Skip the bearer token and the refresh-and-retry behaviour. Set on the sign-in and
   * refresh calls themselves, which carry their own credential and must never recurse
   * into a renewal.
   */
  readonly anonymous?: boolean;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  const search = new URLSearchParams();
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      search.append(key, String(value));
    }
  }
  const queryString = search.toString();
  return `${API_BASE_URL}${normalisedPath}${queryString.length > 0 ? `?${queryString}` : ''}`;
}

function errorFromBody(body: ApiErrorBody, status: number): ApiError {
  return new ApiError({
    code: body.code,
    message: body.message,
    status,
    fieldErrors: body.fieldErrors ?? [],
    ...(body.details !== undefined ? { details: body.details } : {}),
    ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
  });
}

function fallbackMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to view this.';
  if (status === 404) return 'The requested information could not be found.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'The server is temporarily unavailable. Please try again shortly.';
  return 'The request could not be completed.';
}

/**
 * One attempt at a request. Returns the whole response envelope and throws `ApiError`
 * for every failure mode, so callers only ever handle one error type.
 *
 * Wrapped by `requestEnvelope`, which adds the refresh-and-retry behaviour. Keeping
 * them apart is what stops a renewal recursing into another renewal.
 */
async function performRequest<TEnvelope extends object>(
  path: string,
  options: RequestOptions = {},
): Promise<TEnvelope> {
  const { method = 'GET', body, query, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);

  // Honour a caller-supplied signal alongside our timeout.
  const onExternalAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };
  // The access token travels in the header, never in a cookie: a header is not
  // attached automatically by the browser, so it cannot be ridden by a cross-site
  // request the way an ambient cookie can.
  const accessToken = options.anonymous === true ? null : getAccessToken();
  if (accessToken !== null && headers.Authorization === undefined) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'include',
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === 'AbortError';
    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
    throw new ApiError({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message:
        aborted || timedOut
          ? 'The request took too long and was cancelled. Please try again.'
          : 'Could not reach the server. Check your connection and try again.',
      status: 0,
      cause,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;

  if (response.status === 204) return { data: undefined } as unknown as TEnvelope;

  // A parse failure is recorded rather than thrown, because what to do about it depends
  // on the status. A proxy or load balancer answering a 502 with an HTML page is a
  // normal outage; the user should be told the service is unavailable, not handed a
  // confusing "unreadable response".
  let payload: unknown;
  let parseFailure: unknown;
  const rawText = await response.text();
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch (cause) {
      parseFailure = cause;
    }
  }

  if (!response.ok) {
    if (isApiErrorResponse(payload)) throw errorFromBody(payload.error, response.status);
    throw new ApiError({
      code: response.status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.MALFORMED_REQUEST,
      message: fallbackMessage(response.status),
      status: response.status,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(parseFailure !== undefined ? { cause: parseFailure } : {}),
    });
  }

  // On a 2xx, an unparseable or non-envelope body means the client and server have
  // genuinely drifted, which is worth reporting distinctly.
  if (parseFailure !== undefined) {
    throw new ApiError({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'The server returned an unreadable response.',
      status: response.status,
      ...(requestId !== undefined ? { requestId } : {}),
      cause: parseFailure,
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

  return payload as TEnvelope;
}

/**
 * True when a failure is worth one silent renewal attempt.
 *
 * Only an expired token qualifies. A 401 carrying `TOKEN_INVALID` means the session
 * was revoked — by a sign-out elsewhere, a password change, or reuse detection — and
 * retrying it would turn a deliberate revocation into a loop.
 */
function shouldAttemptRefresh(error: unknown, options: RequestOptions): boolean {
  if (options.anonymous === true) return false;
  if (!(error instanceof ApiError)) return false;
  return error.status === 401 && error.code === ErrorCode.TOKEN_EXPIRED;
}

/**
 * Perform a request, renewing an expired access token once and retrying.
 *
 * The renewal is invisible to the caller by design: a bursar halfway through recording
 * a payment should not be bounced to the sign-in screen because fifteen minutes
 * elapsed. A genuinely ended session still surfaces as a 401, which the auth provider
 * turns into a sign-out.
 */
async function requestEnvelope<TEnvelope extends object>(
  path: string,
  options: RequestOptions = {},
): Promise<TEnvelope> {
  try {
    return await performRequest<TEnvelope>(path, options);
  } catch (error) {
    if (!shouldAttemptRefresh(error, options)) throw error;

    const renewed = await refreshAccessToken();
    // No renewal available means there is no live session; the original error is the
    // honest one to report.
    if (renewed === null) throw error;

    return performRequest<TEnvelope>(path, options);
  }
}

/**
 * Perform a request and return just the payload -- the common case, since most endpoints
 * have no `meta` worth reading.
 */
export async function request<TData>(path: string, options: RequestOptions = {}): Promise<TData> {
  const envelope = await requestEnvelope<ApiSuccessResponse<TData>>(path, options);
  return envelope.data;
}

/**
 * Variant for list endpoints: keeps the pagination metadata, which the table footer and
 * page controls need (Section 18).
 */
export function requestPaginated<TItem>(
  path: string,
  options: RequestOptions = {},
): Promise<PaginatedResponse<TItem>> {
  return requestEnvelope<PaginatedResponse<TItem>>(path, options);
}

export const api = {
  get: <TData>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<TData> =>
    request<TData>(path, { ...options, method: 'GET' }),
  post: <TData>(path: string, body?: unknown, options?: RequestOptions): Promise<TData> =>
    request<TData>(path, { ...options, method: 'POST', body }),
  patch: <TData>(path: string, body?: unknown, options?: RequestOptions): Promise<TData> =>
    request<TData>(path, { ...options, method: 'PATCH', body }),
  put: <TData>(path: string, body?: unknown, options?: RequestOptions): Promise<TData> =>
    request<TData>(path, { ...options, method: 'PUT', body }),
  delete: <TData>(path: string, options?: RequestOptions): Promise<TData> =>
    request<TData>(path, { ...options, method: 'DELETE' }),
};
