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

/** Current REST API version prefix. Section 29. */
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;
