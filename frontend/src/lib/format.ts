/**
 * Presentation-layer formatting.
 *
 * Two rules this module exists to enforce:
 *
 *  1. Timestamps arrive as ISO-8601 UTC and are rendered in Africa/Kigali. The
 *     conversion happens here and nowhere else (Section 27).
 *  2. Money arrives as a decimal string and is formatted, never recomputed. There is no
 *     addition, subtraction or rounding of monetary values in the browser (Section 13).
 */
import { DEFAULT_LOCALE, DISPLAY_TIME_ZONE, Money, type CurrencyCode } from '@sfs/shared';

export function formatDateTime(
  isoTimestamp: string,
  options: { withSeconds?: boolean } = {},
): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DISPLAY_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: options.withSeconds === true ? 'medium' : 'short',
  }).format(date);
}

export function formatDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DISPLAY_TIME_ZONE,
    dateStyle: 'medium',
  }).format(date);
}

/**
 * Format a monetary amount supplied by the API.
 * Invalid input renders as an em dash rather than throwing -- a malformed figure must
 * not blank out an entire payments table.
 */
export function formatMoney(
  amount: string,
  currency: CurrencyCode = 'RWF',
  options: { withCurrency?: boolean } = {},
): string {
  if (!Money.isValid(amount, currency)) return '—';
  return Money.of(amount, currency).format({
    withCurrency: options.withCurrency ?? true,
  });
}

/** `93` -> `1 minute 33 seconds`, for uptime and latency displays. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor((totalSeconds / 3600) % 24);
  const days = Math.floor(totalSeconds / 86_400);

  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  if (parts.length === 0 || seconds > 0) parts.push(`${String(seconds)}s`);
  return parts.join(' ');
}
