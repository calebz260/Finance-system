/**
 * The payment provider port.
 *
 * Everything the payment domain is allowed to know about a payment provider is in this
 * file. No service imports an adapter; they resolve one through the registry and talk to
 * it through this interface. That is what keeps "which bank are we integrated with?" a
 * configuration question rather than a refactor, and it is why the domain's tests can
 * cover a timeout, an unknown outcome and an amount mismatch without a network.
 *
 * Three rules the interface exists to impose on every adapter, present and future:
 *
 *  - **An adapter never decides that money moved.** It reports what the provider said.
 *    Whether that is enough to credit a student is decided by `payment.finalize.ts`,
 *    against the school's own record of what was requested. An adapter returning
 *    `SUCCEEDED` is evidence, not authority (Section 11).
 *
 *  - **An adapter never throws for an ordinary provider outcome.** A declined payment, a
 *    timeout and an unreachable provider are all results, and all three have to be
 *    representable — `UNKNOWN` most of all, because a request that timed out may still
 *    have taken the payer's money, and treating that as a failure is how a family is
 *    told a payment failed and then charged for it anyway.
 *
 *  - **An adapter returns no secrets.** `metadata` is a small chosen subset of the
 *    provider's response, destined for a database column and a support screen. Tokens,
 *    signatures and credentials never leave the adapter (Sections 25, 38).
 *
 * Money crosses this boundary as a decimal string, for the same reason it crosses the
 * HTTP boundary as one: a provider's JSON number has already lost precision by the time
 * it is parsed (ADR-001).
 */
import type {
  PaymentMethodValue,
  PaymentProviderKeyValue,
  PaymentTransactionStatusValue,
} from '@sfs/shared';

/** A small, explicitly safe subset of a provider's response. */
export type ProviderMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface ProviderInitiationRequest {
  /** The school's own reference for this attempt. The provider must quote it back. */
  readonly internalReference: string;
  /** Decimal string at scale 2. */
  readonly amount: string;
  readonly currency: string;
  readonly method: PaymentMethodValue;
  readonly payerName: string;
  /** The wallet or account the money comes from, where the channel needs one. */
  readonly payerPhone: string | null;
  /** What the payer sees on their handset or statement. Carries no personal data. */
  readonly description: string;
}

/**
 * The outcome of asking a provider to start collecting.
 *
 * `status` is the provider's view of the *attempt*, never of the payment. `PENDING` and
 * `PROCESSING` both mean "ask again later or wait for a callback"; the distinction is
 * whether the payer still has something to do.
 */
export interface ProviderInitiationResult {
  readonly status: Extract<
    PaymentTransactionStatusValue,
    'PENDING' | 'INITIATED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN'
  >;
  /** Null when the provider has not yet allocated one, or never responded. */
  readonly providerTransactionId: string | null;
  /** What the payer must now do, in words safe to show them. Null when nothing. */
  readonly instruction: string | null;
  readonly failureCode: string | null;
  /** Safe for display. Never a provider stack trace or raw error body. */
  readonly failureMessage: string | null;
  readonly metadata: ProviderMetadata | null;
}

/**
 * What a provider says about one transaction, however the school came to ask.
 *
 * The same shape is produced by a verified callback and by a status query, so
 * finalisation has one code path regardless of which arrived. That matters because the
 * checks that guard crediting — reference, amount, currency — must not be able to differ
 * between the two.
 */
export interface ProviderConfirmation {
  /** The school's reference, as quoted back. Resolves which attempt this is about. */
  readonly internalReference: string;
  readonly providerTransactionId: string;
  readonly outcome: Extract<
    PaymentTransactionStatusValue,
    'SUCCEEDED' | 'FAILED' | 'PENDING' | 'UNKNOWN'
  >;
  /**
   * What the provider says was actually taken, as a decimal string. Null when it does
   * not say — which is itself a reason not to credit, rather than a licence to assume
   * the requested amount was collected.
   */
  readonly confirmedAmount: string | null;
  readonly currency: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  /** The provider's delivery id, for idempotent webhook handling. */
  readonly eventId: string | null;
  /** The timestamp the provider signed, for replay rejection. */
  readonly signedAt: Date | null;
  readonly metadata: ProviderMetadata | null;
}

/**
 * The result of checking an inbound callback's authenticity.
 *
 * Deliberately not an exception and not a boolean. Every rejection reason is recorded in
 * `payment_webhook_events`, because one bad signature is a misconfiguration and a stream
 * of them is someone forging confirmations — and that distinction only exists if the
 * reason was written down (Section 16).
 */
export type WebhookVerification =
  | { readonly kind: 'VERIFIED'; readonly confirmation: ProviderConfirmation }
  | {
      readonly kind: 'SIGNATURE_INVALID' | 'REPLAYED' | 'MALFORMED';
      /** Safe to log. Never echoed to the caller, which gets a fixed refusal. */
      readonly reason: string;
      readonly eventId: string | null;
      readonly signedAt: Date | null;
    };

/**
 * What a provider can actually do.
 *
 * Declared rather than assumed so the system never offers a payer a channel that cannot
 * collect, and never claims to have re-verified a confirmation against a provider that
 * has no endpoint to re-verify against (Section 40).
 */
export interface PaymentProviderCapabilities {
  /** Whether the school can ask this provider to collect a payment. */
  readonly supportsInitiation: boolean;
  /**
   * Whether a transaction's status can be read back from the provider.
   *
   * This is what lets finalisation confirm a callback independently instead of trusting
   * it. An adapter declaring `false` is stating that a signed callback is the strongest
   * evidence available from that channel, and the payment record says so.
   */
  readonly supportsStatusQuery: boolean;
  readonly supportsWebhook: boolean;
}

export interface PaymentProviderAdapter {
  readonly key: PaymentProviderKeyValue;
  readonly displayName: string;
  readonly capabilities: PaymentProviderCapabilities;

  /**
   * Ask the provider to collect. Resolves with an outcome for every reachable state,
   * including the ones where nothing is known.
   */
  initiatePayment(request: ProviderInitiationRequest): Promise<ProviderInitiationResult>;

  /**
   * Read a transaction's current state back from the provider.
   *
   * Returns null when the provider has no record of it — which is a meaningful answer,
   * and not the same as a failure: it is the answer that would turn a forged callback into
   * a payment held for review rather than a credit.
   *
   * Adapters whose `supportsStatusQuery` is false resolve null.
   *
   * **Nothing calls this yet**, and saying so is more useful than implying otherwise: no
   * registered adapter supports a status query, because the only one registered is a
   * simulator that holds no state of its own. It is part of the contract because a real
   * adapter's ability to re-ask is the difference between a signed callback being the
   * strongest available evidence and being merely the first evidence — and the payment
   * record says which of those it relied on. The re-query itself, and the scheduled sweep
   * that would drive it for payments a provider has gone quiet about, arrive with the first
   * adapter that can answer. Until then a bursar resolves such a payment by hand, which
   * `verification.service.ts` deliberately permits.
   */
  queryTransactionStatus(args: {
    readonly internalReference: string;
    readonly providerTransactionId: string | null;
  }): Promise<ProviderConfirmation | null>;

  /**
   * Check a callback's authenticity against the raw request body.
   *
   * Takes the **raw bytes**, not a parsed object: a signature covers the bytes the
   * provider sent, and re-serialising parsed JSON does not reproduce them. Any adapter
   * verifying against `JSON.stringify(req.body)` is not verifying anything.
   */
  verifyWebhook(args: {
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly now: Date;
  }): WebhookVerification;
}
