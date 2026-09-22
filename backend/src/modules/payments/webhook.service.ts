/**
 * Inbound provider callbacks.
 *
 * A callback is an unauthenticated HTTP request from the public internet that claims a
 * payment succeeded. Everything in this file exists because of that sentence.
 *
 * ## The order of operations, and why it is that order
 *
 *  1. **Verify the signature** against the raw bytes, with the secret for the provider
 *     named in the *path* — never one named in the body, because a body nobody has
 *     authenticated must not get to choose the key that authenticates it.
 *  2. **Refuse a stale timestamp.** A signature over the body alone is replayable
 *     forever: whoever captures one valid callback can send it again whenever they like,
 *     and every delivery is genuinely signed. The signed timestamp and a narrow window
 *     are what make a captured callback stale rather than reusable.
 *  3. **Record the event before acting on it.** `(provider_key, event_id)` is unique, so
 *     a re-delivery loses the insert and is answered from the first delivery's record
 *     instead of being processed twice. This is the mechanism, not a nicety: providers
 *     retry as a matter of course.
 *  4. **Resolve the reference to one attempt**, scoped by provider, so a compromised
 *     secret for one channel cannot confirm another channel's payment.
 *  5. **Finalise through the same code the bursar path uses.** The amount is compared
 *     against the school's own record, and a mismatch parks the payment. A callback is
 *     evidence, never authority (Section 11).
 *
 * ## What the sender is told
 *
 * Almost nothing. A rejected callback gets a fixed refusal with no indication of *which*
 * check failed, because "signature bad" versus "timestamp stale" versus "reference
 * unknown" is a verification oracle for anyone probing. The detail goes to
 * `payment_webhook_events` and the audit log, where the school can read it (Section 16).
 *
 * ## Why rejections are stored at all
 *
 * One bad signature is a misconfiguration. A stream of them is somebody forging payment
 * confirmations, and that distinction only exists if the failures were written down.
 */
import { createHash } from 'node:crypto';

import { ErrorCode, type PaymentProviderKeyValue, type WebhookAcknowledgement } from '@sfs/shared';

import type { PaymentStatus, WebhookVerificationResult } from '../../generated/prisma/enums.js';
import { AppError, NotFoundError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { recordSafely } from '../audit/audit.service.js';
import { failPayment, finalisePayment, holdPaymentForReview } from './payment.finalize.js';
import { paymentRepository } from './payment.repository.js';
import { findProvider } from './providers/provider.registry.js';
import type { ProviderConfirmation } from './providers/provider.port.js';

const log = createLogger('payments.webhook');

/**
 * 401 with a fixed message.
 *
 * The same error for a bad signature, a replay and a body that could not be parsed. A
 * provider integrating for the first time reads the reason in the webhook log, which they
 * have access to through the school; a forger reads nothing.
 */
class CallbackRefusedError extends AppError {
  constructor() {
    super(401, ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'This callback could not be verified.');
  }
}

/** The acknowledgement every accepted callback gets, whatever it turned out to mean. */
const ACKNOWLEDGED: WebhookAcknowledgement = Object.freeze({ received: true });

export interface CallbackRequest {
  readonly providerKey: PaymentProviderKeyValue;
  /** The exact bytes received. The signature covers these and not a re-serialisation. */
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly requestId: string | null;
}

/**
 * Handle one callback.
 *
 * Returns the acknowledgement for anything that was accepted for processing — including a
 * signed callback that could not be attributed to a payment, which is the school's problem
 * to investigate rather than something to bounce into a provider's retry loop. Throws only
 * when the callback failed verification outright.
 */
export async function processProviderCallback(
  request: CallbackRequest,
): Promise<WebhookAcknowledgement> {
  const adapter = findProvider(request.providerKey);

  if (!adapter?.capabilities.supportsWebhook) {
    // No endpoint for a provider this deployment has not registered. A 404 discloses only
    // which channels are configured, which is deployment configuration and not a secret —
    // and answering 200 would tell an unconfigured provider that its callbacks are being
    // accepted when nothing is reading them.
    log.warn(
      { providerKey: request.providerKey },
      'A callback arrived for a provider that is not registered in this deployment',
    );
    throw new NotFoundError('There is no callback endpoint for that provider.');
  }

  const payloadDigest = createHash('sha256').update(request.rawBody).digest('hex');
  const verification = adapter.verifyWebhook({
    rawBody: request.rawBody,
    headers: request.headers,
    now: new Date(),
  });

  if (verification.kind !== 'VERIFIED') {
    await recordRejection(request, {
      payloadDigest,
      result: verification.kind,
      reason: verification.reason,
      eventId: verification.eventId,
      signedAt: verification.signedAt,
    });
    throw new CallbackRefusedError();
  }

  const confirmation = verification.confirmation;

  // A provider that sends no delivery id gets the payload digest as one. That is not a
  // workaround: two byte-identical callbacks are the same delivery by any useful
  // definition, so deduplicating on the digest is the behaviour we want anyway.
  const eventId = confirmation.eventId ?? payloadDigest;

  const event = await paymentRepository.recordWebhookEvent({
    providerKey: request.providerKey,
    eventId,
    verification: 'VERIFIED',
    payloadDigest,
    signedAt: confirmation.signedAt,
    requestId: request.requestId,
    safeMetadata: safeMetadataFor(confirmation),
  });

  if (event === null) {
    // The insert lost to an earlier delivery of the same event. Answered from that
    // delivery's record: the work was already done, and doing it again is exactly what
    // this constraint exists to prevent.
    const existing = await paymentRepository.findWebhookEvent({
      providerKey: request.providerKey,
      eventId,
    });

    await recordSafely({
      action: AuditAction.WEBHOOK_DUPLICATE_IGNORED,
      entityType: AuditEntity.PAYMENT_WEBHOOK_EVENT,
      entityId: existing?.id ?? null,
      schoolId: null,
      reason: 'This callback had already been delivered and processed.',
      metadata: {
        providerKey: request.providerKey,
        eventId,
        firstReceivedAt: existing?.receivedAt.toISOString() ?? null,
        resultingStatus: existing?.resultingStatus ?? null,
      },
    });

    log.info(
      { providerKey: request.providerKey, eventId, paymentId: existing?.paymentId ?? null },
      'Ignored a duplicate provider callback',
    );
    return ACKNOWLEDGED;
  }

  await applyConfirmation({ request, eventRowId: event.id, confirmation });
  return ACKNOWLEDGED;
}

/**
 * Act on a verified callback.
 *
 * Every path through this function completes the webhook event row, so the log says what
 * the callback was taken to mean — including "we could not attribute it", which is the
 * entry somebody has to read when a provider insists it sent a confirmation.
 */
async function applyConfirmation(args: {
  readonly request: CallbackRequest;
  readonly eventRowId: string;
  readonly confirmation: ProviderConfirmation;
}): Promise<void> {
  const { request, confirmation } = args;

  const transaction = await resolveAttempt(request.providerKey, confirmation);

  if (transaction === null) {
    await paymentRepository.completeWebhookEvent(args.eventRowId, {
      verification: 'UNKNOWN_REFERENCE',
      processedAt: new Date(),
    });

    await recordSafely({
      action: AuditAction.WEBHOOK_REJECTED,
      entityType: AuditEntity.PAYMENT_WEBHOOK_EVENT,
      entityId: args.eventRowId,
      result: 'FAILURE',
      schoolId: null,
      reason: 'A correctly signed callback named a reference this school does not have.',
      metadata: {
        providerKey: request.providerKey,
        internalReference: confirmation.internalReference,
        providerTransactionId: confirmation.providerTransactionId,
      },
    });

    // Logged at error level: a signed callback that cannot be attributed means either the
    // provider is quoting the wrong reference or a secret is shared with somebody it
    // should not be. Both need a person.
    log.error(
      {
        providerKey: request.providerKey,
        internalReference: confirmation.internalReference,
      },
      'A verified callback could not be matched to a payment attempt',
    );
    return;
  }

  await recordSafely({
    action: AuditAction.WEBHOOK_RECEIVED,
    entityType: AuditEntity.PAYMENT_WEBHOOK_EVENT,
    entityId: args.eventRowId,
    schoolId: transaction.schoolId,
    metadata: {
      providerKey: request.providerKey,
      paymentId: transaction.paymentId,
      internalReference: confirmation.internalReference,
      outcome: confirmation.outcome,
    },
  });

  const resultingStatus = await dispatchOutcome({
    confirmation,
    paymentId: transaction.paymentId,
    transactionId: transaction.id,
  });

  await paymentRepository.completeWebhookEvent(args.eventRowId, {
    schoolId: transaction.schoolId,
    paymentId: transaction.paymentId,
    paymentTransactionId: transaction.id,
    verification: 'VERIFIED',
    resultingStatus,
    processedAt: new Date(),
  });
}

/**
 * Which attempt a callback is about.
 *
 * The school's own reference first, because that is what the provider was asked to quote
 * back; the provider's id second, for a provider that answers with its own identifier
 * only. Both lookups are scoped by provider: a reference is unique per school, and
 * accepting one quoted by a different provider than the one asked to collect would let a
 * compromised secret for one channel confirm another channel's payment.
 */
async function resolveAttempt(
  providerKey: PaymentProviderKeyValue,
  confirmation: ProviderConfirmation,
): Promise<{ id: string; paymentId: string; schoolId: string } | null> {
  const byReference = await paymentRepository.findTransactionByInternalReference({
    providerKey,
    internalReference: confirmation.internalReference,
  });
  if (byReference !== null) return byReference;

  const byProviderId = await paymentRepository.findTransactionByProviderId({
    providerKey,
    providerTransactionId: confirmation.providerTransactionId,
  });
  return byProviderId;
}

/**
 * Park a payment, treating a refused transition as a fact rather than as a fault.
 *
 * `holdPaymentForReview` throws for an illegal transition, which is right when a bursar
 * pressed Hold: they should be told the payment has moved. It is wrong here. A provider
 * reporting an unknown outcome for a payment that was cancelled last week is telling us
 * something unhelpful but not erroneous, and letting that throw would answer the callback
 * with a 409 — which a provider reads as "try again", forever, for a payment that can never
 * move again. It is logged and swallowed instead, and the webhook event row still records
 * that the callback was received and led nowhere.
 */
async function holdOrRecordRefusal(
  paymentId: string,
  args: Parameters<typeof holdPaymentForReview>[1],
): Promise<PaymentStatus | null> {
  try {
    const held = await holdPaymentForReview(paymentId, args);
    return held.applied ? 'REQUIRES_REVIEW' : null;
  } catch (error) {
    log.warn(
      { err: error, paymentId, reason: args.reason },
      'A callback could not park its payment, which has already reached a final state',
    );
    return null;
  }
}

/**
 * Turn a provider's outcome into what happens to the payment.
 *
 * `SUCCEEDED` with no stated amount is the case worth reading twice: it is **not** treated
 * as a confirmation of the requested amount. A provider that says "it worked" without
 * saying what it took has not given the school enough to credit an account with, so the
 * payment is held for a person. Assuming the requested figure would mean a partial
 * collection silently wrote off the difference (Section 20).
 */
async function dispatchOutcome(args: {
  readonly confirmation: ProviderConfirmation;
  readonly paymentId: string;
  readonly transactionId: string;
}): Promise<PaymentStatus | null> {
  const { confirmation, paymentId, transactionId } = args;

  switch (confirmation.outcome) {
    case 'SUCCEEDED': {
      if (confirmation.confirmedAmount === null) {
        return holdOrRecordRefusal(paymentId, {
          reason:
            'The provider reported this payment as successful without stating an amount, so ' +
            'it has not been credited.',
          source: 'PROVIDER_WEBHOOK',
          actorUserId: null,
          metadata: { providerTransactionId: confirmation.providerTransactionId },
        });
      }

      // The verifier of record for a provider-confirmed payment is the person who started
      // it. A database check constraint requires a SUCCESSFUL payment to name one, and
      // `source: PROVIDER_WEBHOOK` on the history row is what says the provider — not that
      // person — is what confirmed it.
      const payment = await paymentRepository.findPaymentById(paymentId);
      if (payment === null) return null;

      const outcome = await finalisePayment(paymentId, {
        source: 'PROVIDER_WEBHOOK',
        actorUserId: payment.initiatedByUserId,
        confirmedAmount: confirmation.confirmedAmount,
        currency: confirmation.currency,
        providerTransactionId: confirmation.providerTransactionId,
        transactionId,
        note: null,
        externalReference: confirmation.providerTransactionId,
        ...(confirmation.metadata !== null ? { metadata: confirmation.metadata } : {}),
      });

      switch (outcome.kind) {
        case 'CREDITED':
        case 'ALREADY_CREDITED':
          return 'SUCCESSFUL';
        case 'HELD_FOR_REVIEW':
          return 'REQUIRES_REVIEW';
        case 'REJECTED':
          // A late confirmation for a payment that has already failed, been cancelled or
          // been reversed. Refused by the status machine and recorded here, because a
          // provider insisting a reversed payment succeeded is worth a look.
          log.warn(
            { paymentId, outcome: outcome.status, reason: outcome.reason },
            'A verified callback could not be applied to the payment it names',
          );
          return null;
      }
      break;
    }

    case 'FAILED': {
      const failed = await failPayment(paymentId, {
        reason:
          confirmation.failureMessage ??
          'The payment provider reported that this payment did not go through.',
        source: 'PROVIDER_WEBHOOK',
        actorUserId: null,
        transactionId,
        failureCode: confirmation.failureCode,
      });
      return failed.applied ? 'FAILED' : null;
    }

    case 'PENDING':
      // A progress update. Nothing to do: the payment is already live, and moving it
      // would be inventing a transition the provider did not report.
      log.info({ paymentId }, 'Provider reported a payment as still pending');
      return null;

    case 'UNKNOWN':
      // The provider does not know either. Held rather than failed, because an unknown
      // outcome may still have taken the payer's money.
      return holdOrRecordRefusal(paymentId, {
        reason: 'The provider reported an unknown outcome for this payment.',
        source: 'PROVIDER_WEBHOOK',
        actorUserId: null,
      });
  }

  return null;
}

/** Store a refusal, so a pattern of them is visible. */
async function recordRejection(
  request: CallbackRequest,
  args: {
    readonly payloadDigest: string;
    readonly result: Exclude<WebhookVerificationResult, 'VERIFIED' | 'UNKNOWN_REFERENCE'>;
    readonly reason: string;
    readonly eventId: string | null;
    readonly signedAt: Date | null;
  },
): Promise<void> {
  // A rejected callback may carry no usable event id — it may not have been parsed at all
  // — so the digest stands in. Two identical forged bodies then collapse into one row,
  // which is the right outcome: the interesting number is how many distinct attempts
  // there were.
  const eventId = args.eventId ?? args.payloadDigest;

  const event = await paymentRepository.recordWebhookEvent({
    providerKey: request.providerKey,
    eventId,
    verification: args.result,
    payloadDigest: args.payloadDigest,
    signedAt: args.signedAt,
    requestId: request.requestId,
    processedAt: new Date(),
    safeMetadata: { reason: args.reason },
  });

  await recordSafely({
    action: AuditAction.WEBHOOK_REJECTED,
    entityType: AuditEntity.PAYMENT_WEBHOOK_EVENT,
    entityId: event?.id ?? null,
    result: 'FAILURE',
    schoolId: null,
    reason: args.reason,
    metadata: {
      providerKey: request.providerKey,
      verification: args.result,
      payloadDigest: args.payloadDigest,
      duplicateDelivery: event === null,
    },
  });

  log.warn(
    {
      providerKey: request.providerKey,
      verification: args.result,
      reason: args.reason,
      payloadDigest: args.payloadDigest,
    },
    'Refused a provider callback',
  );
}

/**
 * The subset of a callback that is safe to keep.
 *
 * Explicitly built rather than spread from the confirmation, so a future adapter adding a
 * field to its metadata cannot quietly persist a token or a payer's full account number
 * (Sections 22, 38).
 */
function safeMetadataFor(
  confirmation: ProviderConfirmation,
): Record<string, string | number | boolean | null> {
  return {
    internalReference: confirmation.internalReference,
    providerTransactionId: confirmation.providerTransactionId,
    outcome: confirmation.outcome,
    confirmedAmount: confirmation.confirmedAmount,
    currency: confirmation.currency,
    failureCode: confirmation.failureCode,
  };
}
