/**
 * Structured logging.
 *
 * Production emits JSON on stdout for a log shipper to collect; development pretty-prints.
 * The redaction list is the important part: this system handles credentials, tokens,
 * webhook signatures and payment provider secrets, and none of them may ever reach a log
 * file (Section 32).
 */
import { pino, type Logger, type LoggerOptions } from 'pino';

import { config } from '../config/env.js';

/**
 * Paths scrubbed from every log record. Kept broad on purpose -- it is far better to
 * redact something harmless than to leak a bearer token.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'req.headers["x-webhook-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordConfirmation',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.resetToken',
  '*.mfaSecret',
  '*.totpSecret',
  '*.otp',
  '*.signature',
  '*.secret',
  '*.apiKey',
  '*.webhookSecret',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'mfaSecret',
  'secret',
];

/** Error fields that are safe and useful to log. Anything else is dropped. */
interface SerialisedError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  statusCode?: number;
  cause?: SerialisedError | string;
}

/**
 * Whitelisting error serialiser.
 *
 * Pino's default serialiser copies every own enumerable property of an error, and some
 * libraries attach the offending payload to their errors -- body-parser, for instance,
 * puts the raw request body on a JSON parse error. For this system that body could be a
 * payment request, so the fields are whitelisted rather than filtered.
 */
export function serialiseError(value: unknown, depth = 0): SerialisedError | string {
  if (!(value instanceof Error)) return typeof value === 'string' ? value : String(value);

  const candidate = value as Error & { code?: unknown; statusCode?: unknown; status?: unknown };
  const serialised: SerialisedError = {
    type: candidate.name,
    message: candidate.message,
  };
  if (candidate.stack !== undefined) serialised.stack = candidate.stack;
  if (typeof candidate.code === 'string') serialised.code = candidate.code;
  const status = candidate.statusCode ?? candidate.status;
  if (typeof status === 'number') serialised.statusCode = status;
  // Bounded so a self-referencing cause chain cannot loop.
  if (candidate.cause !== undefined && depth < 3) {
    serialised.cause = serialiseError(candidate.cause, depth + 1);
  }
  return serialised;
}

const baseOptions: LoggerOptions = {
  level: config.logging.level,
  base: {
    service: config.app.name,
    version: config.app.version,
    env: config.env,
  },
  serializers: {
    err: (value: unknown) => serialiseError(value),
    error: (value: unknown) => serialiseError(value),
  },
  redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  // ISO-8601 UTC, matching how timestamps are stored (Section 27).
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

function buildLogger(): Logger {
  if (config.logging.pretty) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service,version,env',
        },
      },
    });
  }
  return pino(baseOptions);
}

export const logger: Logger = buildLogger();

/** Child logger tagged with the module it belongs to, e.g. `payments.service`. */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
