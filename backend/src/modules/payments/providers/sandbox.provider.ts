/**
 * The sandbox payment provider: a local simulator.
 *
 * **This is not a bank and not an integration.** It makes no outbound request to
 * anything. Its only purpose is to make the provider path — initiation, signature
 * verification, replay rejection, amount checking, transactional finalisation — fully
 * exercisable in development and in CI, without credentials, without a network and
 * without real money (Section 36).
 *
 * It is refused outright in production by `config/env.ts`, because a simulator that can
 * mint payment confirmations must not be reachable anywhere a confirmation credits a
 * real student's account.
 *
 * ## What it simulates, and what that is worth
 *
 * `initiatePayment` records the intent and returns `PENDING` with a generated provider
 * transaction id and an instruction. Nothing settles on its own: settlement arrives only
 * as a signed callback posted to `/payment-webhooks/SANDBOX`. That is the honest shape,
 * and it is the useful one — every interesting case (success, decline, amount mismatch,
 * duplicate delivery, replay, forged signature) is driven by what the caller posts, so
 * the tests exercise the real verification and finalisation code rather than a mock of
 * it.
 *
 * `supportsStatusQuery` is **false**, and that is a deliberate statement rather than an
 * omission: the simulator keeps no ledger of its own, so there is nothing to read back.
 * A payment verified through it is therefore verified on the strength of a valid
 * signature, a matching reference and a matching amount — and the payment record says
 * exactly that. Re-querying a provider is declared on the port and implemented by nobody
 * yet, because no registered adapter can answer; see `queryTransactionStatus` there for
 * what changes when one can.
 *
 * ## The signature scheme
 *
 * HMAC-SHA256 over `"<timestamp>.<raw body bytes>"`, hex-encoded, in
 * `X-Webhook-Signature`, with the Unix-seconds timestamp in `X-Webhook-Timestamp`.
 *
 * The timestamp is inside the signed material on purpose. A signature over the body
 * alone is replayable forever: an attacker who captures one valid callback can resend it
 * whenever they like, and every delivery is genuinely signed. Binding the timestamp into
 * the digest and refusing anything outside a narrow window is what makes a captured
 * callback stale rather than reusable — and the `payment_webhook_events` uniqueness
 * constraint catches the rest.
 *
 * Comparison is timing-safe. A byte-by-byte `===` on a signature leaks how much of a
 * guess was correct, which is enough to forge one a byte at a time.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  Money,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type PaymentProviderKeyValue,
} from '@sfs/shared';

import { createLogger } from '../../../lib/logger.js';
import type {
  PaymentProviderAdapter,
  PaymentProviderCapabilities,
  ProviderConfirmation,
  ProviderInitiationRequest,
  ProviderInitiationResult,
  WebhookVerification,
} from './provider.port.js';

const log = createLogger('payments.provider.sandbox');

const KEY: PaymentProviderKeyValue = 'SANDBOX';

/**
 * The callback body the simulator signs and verifies.
 *
 * Narrow on purpose: these are the fields finalisation actually needs, so the parser
 * rejects anything that does not carry them rather than accepting a partial callback and
 * discovering the gap while crediting.
 */
interface SandboxCallbackBody {
  readonly eventId?: unknown;
  readonly reference?: unknown;
  readonly providerTransactionId?: unknown;
  readonly outcome?: unknown;
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly failureCode?: unknown;
  readonly failureMessage?: unknown;
}

const OUTCOMES = new Set(['SUCCEEDED', 'FAILED', 'PENDING', 'UNKNOWN']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build the material the signature covers.
 *
 * Exported because the integration tests sign callbacks with it. A test that constructed
 * the signed string independently would be free to drift from the verifier, and the case
 * it would stop covering is the one that matters: a mismatch between what is signed and
 * what is checked.
 */
export function sandboxSignedPayload(timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
}

/** The hex signature for a body and timestamp under a secret. */
export function signSandboxCallback(args: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
}): string {
  return createHmac('sha256', args.secret)
    .update(sandboxSignedPayload(args.timestamp, args.rawBody))
    .digest('hex');
}

function signaturesMatch(expectedHex: string, presentedHex: string): boolean {
  // Length is compared first because `timingSafeEqual` throws on a length mismatch.
  // Length itself is not a secret: it is fixed by the algorithm.
  if (expectedHex.length !== presentedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(presentedHex, 'hex'));
  } catch {
    // Non-hex input. A malformed signature is simply not a match.
    return false;
  }
}

export interface SandboxProviderOptions {
  readonly webhookSecret: string;
  readonly maxSkewSeconds: number;
}

export function createSandboxProvider(options: SandboxProviderOptions): PaymentProviderAdapter {
  const capabilities: PaymentProviderCapabilities = Object.freeze({
    supportsInitiation: true,
    // Stated, not forgotten. See the module comment.
    supportsStatusQuery: false,
    supportsWebhook: true,
  });

  return {
    key: KEY,
    displayName: 'Sandbox simulator (not a real provider)',
    capabilities,

    initiatePayment(request: ProviderInitiationRequest): Promise<ProviderInitiationResult> {
      // No network call. The id is random rather than derived from the reference, so a
      // test cannot accidentally depend on being able to predict it — a real provider's
      // id is opaque, and code that guesses it would break on the first real adapter.
      const providerTransactionId = `SBX-${randomBytes(9).toString('hex').toUpperCase()}`;

      log.info(
        {
          providerKey: KEY,
          internalReference: request.internalReference,
          providerTransactionId,
          method: request.method,
        },
        'Sandbox provider accepted a simulated collection request',
      );

      return Promise.resolve({
        status: 'PENDING',
        providerTransactionId,
        instruction:
          'Simulated request accepted. Nothing has been collected: this channel settles ' +
          'only when a signed sandbox callback is delivered.',
        failureCode: null,
        failureMessage: null,
        metadata: {
          simulated: true,
          acceptedAt: new Date().toISOString(),
        },
      });
    },

    queryTransactionStatus(): Promise<ProviderConfirmation | null> {
      // The simulator holds no state, so it has nothing to confirm. Null is the truthful
      // answer and the one `supportsStatusQuery: false` promises.
      return Promise.resolve(null);
    },

    verifyWebhook(args): WebhookVerification {
      const signature = args.headers[WEBHOOK_SIGNATURE_HEADER];
      const timestamp = args.headers[WEBHOOK_TIMESTAMP_HEADER];

      if (!isNonEmptyString(signature) || !isNonEmptyString(timestamp)) {
        return {
          kind: 'SIGNATURE_INVALID',
          reason: 'The callback carried no signature or no timestamp.',
          eventId: null,
          signedAt: null,
        };
      }

      const signedSeconds = Number(timestamp);
      if (!Number.isFinite(signedSeconds) || !Number.isInteger(signedSeconds)) {
        return {
          kind: 'SIGNATURE_INVALID',
          reason: 'The callback timestamp was not a Unix-seconds integer.',
          eventId: null,
          signedAt: null,
        };
      }
      const signedAt = new Date(signedSeconds * 1000);

      // Signature before freshness. Checking the window first would let an unsigned
      // request learn whether its clock guess was acceptable, and would spend the
      // comparison on input nobody has authenticated.
      const expected = signSandboxCallback({
        secret: options.webhookSecret,
        timestamp,
        rawBody: args.rawBody,
      });
      if (!signaturesMatch(expected, signature)) {
        return {
          kind: 'SIGNATURE_INVALID',
          reason: 'The callback signature did not match the shared secret.',
          eventId: null,
          signedAt,
        };
      }

      const skewSeconds = Math.abs((args.now.getTime() - signedAt.getTime()) / 1000);
      if (skewSeconds > options.maxSkewSeconds) {
        // Correctly signed but stale: a captured callback being sent again. Refused as a
        // replay rather than as a bad signature, because the two mean different things to
        // whoever reads the webhook log.
        return {
          kind: 'REPLAYED',
          reason:
            `The callback was signed ${String(Math.round(skewSeconds))}s from now, outside ` +
            `the ${String(options.maxSkewSeconds)}s window.`,
          eventId: null,
          signedAt,
        };
      }

      let parsed: SandboxCallbackBody;
      try {
        const decoded: unknown = JSON.parse(args.rawBody.toString('utf8'));
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
          throw new Error('not an object');
        }
        parsed = decoded;
      } catch {
        return {
          kind: 'MALFORMED',
          reason: 'The callback body was not a JSON object.',
          eventId: null,
          signedAt,
        };
      }

      const eventId = isNonEmptyString(parsed.eventId) ? parsed.eventId.trim() : null;

      if (!isNonEmptyString(parsed.reference)) {
        return {
          kind: 'MALFORMED',
          reason: 'The callback named no payment reference.',
          eventId,
          signedAt,
        };
      }
      if (!isNonEmptyString(parsed.providerTransactionId)) {
        return {
          kind: 'MALFORMED',
          reason: 'The callback carried no provider transaction id.',
          eventId,
          signedAt,
        };
      }
      if (!isNonEmptyString(parsed.outcome) || !OUTCOMES.has(parsed.outcome)) {
        return {
          kind: 'MALFORMED',
          reason: 'The callback outcome was missing or not a recognised value.',
          eventId,
          signedAt,
        };
      }

      // The amount is validated as money here, at the boundary, rather than trusted into
      // the domain. A callback quoting `1e5` or `12.345` is malformed; it is not an
      // amount to be rounded into something plausible (ADR-001).
      let confirmedAmount: string | null = null;
      if (parsed.amount !== undefined && parsed.amount !== null) {
        if (typeof parsed.amount !== 'string' || !Money.isValid(parsed.amount)) {
          return {
            kind: 'MALFORMED',
            reason: 'The callback amount was not a decimal string.',
            eventId,
            signedAt,
          };
        }
        confirmedAmount = Money.of(parsed.amount).toString();
      }

      return {
        kind: 'VERIFIED',
        confirmation: {
          internalReference: parsed.reference.trim(),
          providerTransactionId: parsed.providerTransactionId.trim(),
          outcome: parsed.outcome as ProviderConfirmation['outcome'],
          confirmedAmount,
          currency: isNonEmptyString(parsed.currency) ? parsed.currency.trim() : null,
          failureCode: isNonEmptyString(parsed.failureCode) ? parsed.failureCode.trim() : null,
          failureMessage: isNonEmptyString(parsed.failureMessage)
            ? parsed.failureMessage.trim()
            : null,
          eventId,
          signedAt,
          metadata: { simulated: true },
        },
      };
    },
  };
}
