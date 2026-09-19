/**
 * How a password-reset link reaches its owner.
 *
 * A port, not an implementation, because the channel that will actually carry it — email
 * or SMS — arrives in Phase 6. Defining the seam now keeps the reset flow complete and
 * testable today: the service mints, stores and consumes the token exactly as it will in
 * production, and only the last hop is swapped later.
 *
 * Two rules the adapters below exist to enforce:
 *
 *  - **The token never travels in an API response.** Returning it to the caller of
 *    `POST /auth/password/reset-request` would mean anyone could reset anyone's password
 *    by asking. It goes to the account's own contact details or nowhere.
 *
 *  - **The token is never written to a production log.** A log line holding a live reset
 *    credential is a credential in every log sink, backup and aggregator downstream. In
 *    development the link is printed because that is the only way to exercise the flow
 *    without a mail server; in production the absence of a channel is reported loudly,
 *    without the secret.
 */
import { config } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('auth.password-delivery');

export interface PasswordResetMessage {
  readonly email: string;
  readonly firstName: string;
  /** The raw token. Only ever handed to a delivery channel, never to an API caller. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface PasswordResetDelivery {
  deliver(message: PasswordResetMessage): Promise<void>;
}

/**
 * The adapter in force until Phase 6 wires a real notification channel.
 *
 * In development it logs the token so the flow can be walked end to end. In any other
 * environment it logs an error *without* the token: the reset was recorded and the user
 * was told to check their messages, so an operator has to know that nothing was sent.
 */
export class LoggingPasswordResetDelivery implements PasswordResetDelivery {
  deliver(message: PasswordResetMessage): Promise<void> {
    if (config.isDevelopment) {
      log.warn(
        {
          email: message.email,
          expiresAt: message.expiresAt.toISOString(),
          resetToken: message.token,
        },
        'No notification channel is configured (Phase 6). Reset token logged for development use only.',
      );
    } else {
      log.error(
        { email: message.email, expiresAt: message.expiresAt.toISOString() },
        'A password reset was requested but no notification channel is configured, so nothing was sent.',
      );
    }
    return Promise.resolve();
  }
}

/**
 * Collects messages instead of sending them, for tests that need to read the token the
 * service minted without reaching into the database.
 */
export class RecordingPasswordResetDelivery implements PasswordResetDelivery {
  readonly messages: PasswordResetMessage[] = [];

  deliver(message: PasswordResetMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  /** The most recent message, or undefined when nothing was delivered. */
  last(): PasswordResetMessage | undefined {
    return this.messages.at(-1);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

let delivery: PasswordResetDelivery = new LoggingPasswordResetDelivery();

export function getPasswordResetDelivery(): PasswordResetDelivery {
  return delivery;
}

/**
 * Replace the delivery channel. Phase 6 calls this at startup with the real notifier;
 * tests call it with a recorder and restore the previous value afterwards.
 */
export function setPasswordResetDelivery(next: PasswordResetDelivery): PasswordResetDelivery {
  const previous = delivery;
  delivery = next;
  return previous;
}
