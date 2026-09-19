/**
 * Time-based one-time passwords (RFC 6238), used for the MFA required of Bursar,
 * Finance Manager, School Administrator and Super Administrator accounts (Section 6).
 *
 * Standard parameters -- SHA-1, 6 digits, 30-second step -- not because they are the
 * strongest available but because they are what Google Authenticator, Microsoft
 * Authenticator, Authy and FreeOTP actually implement. A school cannot ask its bursar to
 * find an app that supports SHA-512.
 *
 * Two details that matter more than the algorithm choice:
 *
 *  - **A window of one step** either side is accepted, because phone clocks drift. Wider
 *    would extend how long an observed code stays usable.
 *  - **Codes cannot be replayed.** Verification returns the step counter it matched, and
 *    the caller persists it; a code at or below the last accepted counter is refused. Any
 *    other approach leaves a 30-90 second window in which a shoulder-surfed code works a
 *    second time.
 */
import { Secret, TOTP } from 'otpauth';

import { config } from '../config/env.js';

/** Seconds per step. */
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = 'SHA1';

/**
 * Steps of clock drift tolerated either side of now. One step means a code stays valid
 * for at most 90 seconds.
 */
export const TOTP_WINDOW = 1;

/** Bytes of entropy in a generated secret. 20 bytes is the RFC 4226 recommendation. */
const SECRET_BYTES = 20;

function buildTotp(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: config.auth.mfaIssuer,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** A new base32 secret, in the form authenticator apps expect. */
export function generateTotpSecret(): string {
  return new Secret({ size: SECRET_BYTES }).base32;
}

/**
 * The `otpauth://` URI an authenticator app consumes, usually via a QR code.
 *
 * Note that this URI contains the shared secret, so it is as sensitive as the secret
 * itself: it is returned once during enrolment, over an authenticated request, and never
 * logged or stored.
 */
export function buildTotpUri(args: { secret: string; accountLabel: string }): string {
  return buildTotp(args.secret, args.accountLabel).toString();
}

export interface TotpVerification {
  readonly valid: boolean;
  /**
   * The step counter the code matched. Persisted by the caller so the same code cannot
   * be accepted twice.
   */
  readonly counter?: number;
}

/**
 * Verify a code.
 *
 * `lastUsedCounter` is the highest counter previously accepted for this user. A code
 * resolving to that counter or lower is rejected as a replay even though it is
 * cryptographically valid.
 */
export function verifyTotp(args: {
  secret: string;
  code: string;
  accountLabel?: string;
  lastUsedCounter?: number | null;
  /** Injected in tests to make verification deterministic. */
  timestamp?: number;
}): TotpVerification {
  // Users type codes with spaces ("123 456"); tolerate that but nothing else.
  const code = args.code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { valid: false };

  const totp = buildTotp(args.secret, args.accountLabel ?? 'account');
  const delta = totp.validate({
    token: code,
    window: TOTP_WINDOW,
    ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
  });

  if (delta === null) return { valid: false };

  const now = args.timestamp ?? Date.now();
  const counter = Math.floor(now / 1000 / TOTP_PERIOD) + delta;

  if (args.lastUsedCounter != null && counter <= args.lastUsedCounter) {
    // Cryptographically valid but already spent.
    return { valid: false };
  }

  return { valid: true, counter };
}

/** The step counter for a moment in time. Exposed for tests and for replay bookkeeping. */
export function totpCounterAt(timestamp: number = Date.now()): number {
  return Math.floor(timestamp / 1000 / TOTP_PERIOD);
}
