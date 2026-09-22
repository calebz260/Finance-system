/**
 * Technical constants that are genuinely fixed for the whole system.
 *
 * Anything a school could reasonably want to change -- term count, fee amounts, levels,
 * proration policy, retention periods -- belongs in the database, not here (Section 45).
 */

/** Timestamps are stored in UTC and rendered in this zone (UTC+2, no DST). Section 27. */
export const DISPLAY_TIME_ZONE = 'Africa/Kigali';

/** Default locale for number and date formatting in the web client. */
export const DEFAULT_LOCALE = 'en-RW';

/** Header carrying a client-generated idempotency key on payment initiation. Section 14. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Header echoing the server-assigned request id, used for support and log correlation. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Headers a payment callback carries so its authenticity can be checked (Section 16).
 *
 * Named here rather than in the adapter because the webhook route reads them before it
 * knows which provider sent the request, and because the shape of a callback is part of
 * the system's contract with its providers rather than an implementation detail of one.
 * A provider whose real contract uses different header names gets them mapped in its own
 * adapter; these are what the sandbox simulator and the generic verifier use.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';

/**
 * How far a callback's timestamp may be from the server clock before it is refused as a
 * replay. Two minutes tolerates ordinary clock skew and network delay; anything older is
 * a captured request being sent again.
 */
export const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 120;

/** Current REST API version prefix. Section 29. */
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;
