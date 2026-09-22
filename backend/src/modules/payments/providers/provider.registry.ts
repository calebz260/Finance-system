/**
 * Which payment channels the school actually has, and which of them work today.
 *
 * This is the file that keeps the system honest about its own integrations. The roadmap
 * names three Rwandan channels — Bank of Kigali, Zigama CSS and Umwarimu SACCO — and for
 * none of them is it yet established whether a payment-notification API exists
 * (docs/OPEN-QUESTIONS.md #1 and #2). No adapter is invented for them, no endpoint is
 * guessed and no credential is assumed. They are registered as **manual channels**: real
 * ways to pay the school, reconciled by a bursar against a statement, which is the
 * workflow ADR-003 treats as first-class precisely because it may carry most of the
 * volume.
 *
 * The consequence is deliberate and visible in the API: `GET /payment-methods` reports
 * `isAvailable` and, when false, `unavailableReason`. A parent is never shown a button
 * for a channel that cannot collect, and nothing in the codebase claims an integration
 * it does not have (Section 40).
 *
 * When a provider's real contract is confirmed, the change is: write the adapter against
 * the documented API, register it here, and flip the channel's verification method to
 * `PROVIDER`. Nothing in the payment domain, the ledger or the balance changes — which is
 * the whole point of the port.
 */
import type {
  PaymentMethodValue,
  PaymentMethodOption,
  PaymentProviderKeyValue,
  PaymentVerificationMethodValue,
} from '@sfs/shared';

import { config } from '../../../config/env.js';
import { createSandboxProvider } from './sandbox.provider.js';
import type { PaymentProviderAdapter } from './provider.port.js';

/**
 * A way to pay the school.
 *
 * `verificationMethod` is the channel's *policy*, not a preference: it says what has to
 * happen before the ledger is credited. Only `MOBILE_MONEY` is provider-verified, and
 * only while an adapter capable of initiation is registered.
 */
interface ChannelDefinition {
  readonly method: PaymentMethodValue;
  readonly label: string;
  readonly verificationMethod: PaymentVerificationMethodValue;
  /**
   * Providers a payer may name for this channel. For a manual bank channel this is the
   * list of institutions the school banks with; the payer says where they deposited so a
   * bursar knows which statement to look on.
   */
  readonly providerChoices: readonly PaymentProviderKeyValue[];
  /** Whether a claim through this channel must carry proof of payment. */
  readonly requiresEvidence: boolean;
  readonly instructions: string | null;
}

/**
 * The bank channels. Present as provider *values* so a payment records which institution
 * it came through — which is what makes reconciliation possible later without
 * redesigning the payment domain (Section 33) — while carrying no adapter.
 */
const BANK_CHANNELS: readonly PaymentProviderKeyValue[] = [
  'BANK_OF_KIGALI',
  'ZIGAMA_CSS',
  'UMWARIMU_SACCO',
];

const CHANNELS: readonly ChannelDefinition[] = [
  {
    method: 'MOBILE_MONEY',
    label: 'Mobile money',
    verificationMethod: 'PROVIDER',
    // Only the simulator today. A confirmed mobile-money contract is registered here.
    providerChoices: ['SANDBOX'],
    requiresEvidence: false,
    instructions: null,
  },
  {
    method: 'BANK_TRANSFER',
    label: 'Bank transfer',
    verificationMethod: 'MANUAL',
    providerChoices: BANK_CHANNELS,
    requiresEvidence: true,
    instructions:
      'Transfer to the school collection account, then submit the transfer confirmation ' +
      'here. A bursar credits your balance once it appears on the school statement.',
  },
  {
    method: 'BANK_DEPOSIT',
    label: 'Bank or agent deposit',
    verificationMethod: 'MANUAL',
    providerChoices: BANK_CHANNELS,
    requiresEvidence: true,
    instructions:
      'Deposit at a branch or agent, then submit a photo of the slip here. A bursar ' +
      'credits your balance once the deposit appears on the school statement.',
  },
  {
    method: 'CASH',
    label: 'Cash at the bursar’s office',
    verificationMethod: 'MANUAL',
    // Cash has no provider: somebody counted it, and that somebody is the verifier.
    providerChoices: [],
    requiresEvidence: false,
    instructions: 'Recorded by the bursar who receives it, and confirmed by a second person.',
  },
  {
    method: 'CHEQUE',
    label: 'Cheque',
    verificationMethod: 'MANUAL',
    providerChoices: BANK_CHANNELS,
    requiresEvidence: true,
    instructions: 'Credited once the cheque has cleared and appears on the school statement.',
  },
];

const CHANNELS_BY_METHOD: ReadonlyMap<PaymentMethodValue, ChannelDefinition> = new Map(
  CHANNELS.map((channel) => [channel.method, channel]),
);

/**
 * Adapters registered for this process.
 *
 * Built once and cached: an adapter is stateless configuration, and rebuilding it per
 * request would re-read the config on the hot path of a payment.
 */
function buildAdapters(): ReadonlyMap<PaymentProviderKeyValue, PaymentProviderAdapter> {
  const adapters = new Map<PaymentProviderKeyValue, PaymentProviderAdapter>();

  const secret = config.payments.sandbox.webhookSecret;
  if (config.payments.sandbox.enabled && secret !== null) {
    adapters.set(
      'SANDBOX',
      createSandboxProvider({
        webhookSecret: secret,
        maxSkewSeconds: config.payments.webhookMaxSkewSeconds,
      }),
    );
  }

  return adapters;
}

let adapterCache: ReadonlyMap<PaymentProviderKeyValue, PaymentProviderAdapter> | null = null;

function adapters(): ReadonlyMap<PaymentProviderKeyValue, PaymentProviderAdapter> {
  adapterCache ??= buildAdapters();
  return adapterCache;
}

/** Rebuild the adapter map. For tests that change configuration between cases. */
export function resetProviderRegistry(): void {
  adapterCache = null;
}

/** The adapter for a provider, or null when none is registered. */
export function findProvider(key: PaymentProviderKeyValue): PaymentProviderAdapter | null {
  return adapters().get(key) ?? null;
}

export function channelFor(method: PaymentMethodValue): ChannelDefinition | null {
  return CHANNELS_BY_METHOD.get(method) ?? null;
}

/**
 * Whether a provider may be named for a channel.
 *
 * Checked server-side on every initiation and claim, because the provider key decides
 * which statement a bursar reconciles against and which secret verifies a callback. A
 * client-chosen key that the channel does not offer is refused rather than stored.
 */
export function providerIsValidForChannel(
  method: PaymentMethodValue,
  providerKey: PaymentProviderKeyValue | null,
): boolean {
  const channel = channelFor(method);
  if (channel === null) return false;
  if (providerKey === null) return channel.providerChoices.length === 0;
  return channel.providerChoices.includes(providerKey);
}

/**
 * A channel's availability.
 *
 * A provider-verified channel is available only while an adapter that can initiate is
 * registered. A manual channel is always available: it needs no integration, only a
 * bursar — which is exactly why the manual path was built first.
 */
function describeAvailability(channel: ChannelDefinition): {
  isAvailable: boolean;
  unavailableReason: string | null;
  providerKey: PaymentProviderKeyValue | null;
} {
  if (channel.verificationMethod === 'MANUAL') {
    return {
      isAvailable: true,
      unavailableReason: null,
      // A manual channel's provider is chosen per payment by the payer, so there is no
      // single key to report here.
      providerKey: null,
    };
  }

  const usable = channel.providerChoices.find((key) => {
    const adapter = findProvider(key);
    return adapter?.capabilities.supportsInitiation === true;
  });

  if (usable === undefined) {
    return {
      isAvailable: false,
      unavailableReason:
        'Online collection is not connected for this channel yet. Pay by bank transfer, ' +
        'deposit or at the bursar’s office instead.',
      providerKey: null,
    };
  }

  return { isAvailable: true, unavailableReason: null, providerKey: usable };
}

/** The channels as the payment screen should render them. */
export function listPaymentMethodOptions(): readonly PaymentMethodOption[] {
  return CHANNELS.map((channel) => {
    const availability = describeAvailability(channel);
    return {
      method: channel.method,
      label: channel.label,
      verificationMethod: channel.verificationMethod,
      providerKey: availability.providerKey,
      isAvailable: availability.isAvailable,
      unavailableReason: availability.unavailableReason,
      requiresEvidence: channel.requiresEvidence,
      instructions: channel.instructions,
    } satisfies PaymentMethodOption;
  });
}

/**
 * The adapter that will collect for a channel, with the reason when there is none.
 *
 * Returns a reason rather than throwing so the caller can turn it into the right kind of
 * refusal: a channel with no adapter is a `SERVICE_UNAVAILABLE`-shaped fact about the
 * deployment, not a validation error in the payer's request.
 */
export function resolveInitiationProvider(
  method: PaymentMethodValue,
): { adapter: PaymentProviderAdapter } | { unavailableReason: string } {
  const channel = channelFor(method);
  if (channel === null) {
    return { unavailableReason: 'That payment method is not offered.' };
  }
  if (channel.verificationMethod !== 'PROVIDER') {
    return {
      unavailableReason:
        'That payment method is confirmed by a bursar, not by a provider. Record it as a ' +
        'manual payment claim instead.',
    };
  }

  const availability = describeAvailability(channel);
  if (!availability.isAvailable || availability.providerKey === null) {
    return {
      unavailableReason:
        availability.unavailableReason ?? 'Online collection is not available for that method.',
    };
  }

  const adapter = findProvider(availability.providerKey);
  if (adapter === null) {
    return { unavailableReason: 'Online collection is not available for that method.' };
  }
  return { adapter };
}
