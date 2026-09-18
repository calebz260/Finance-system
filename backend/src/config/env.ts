/**
 * Environment configuration.
 *
 * Parsed and validated once, at startup, before anything else runs. A misconfigured
 * deployment fails immediately with a readable list of problems rather than surfacing as
 * a mysterious runtime error halfway through a payment. Nothing outside this module reads
 * `process.env` directly -- see `docs/ENVIRONMENT.md`.
 */
// Side-effect import: must come first so `.env` is populated before anything is read.
import './load-dotenv.js';

import { z } from 'zod';

const nodeEnvSchema = z.enum(['development', 'test', 'production']);

/** Comma-separated list -> trimmed, de-duplicated array. */
const csvList = z
  .string()
  .transform((value) =>
    Array.from(
      new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ),
  )
  .pipe(z.array(z.string()));

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema.default('development'),

    /** Port the HTTP server binds to. */
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().min(1).default('0.0.0.0'),

    /** Reported in health checks and logs so a deployed build is identifiable. */
    APP_VERSION: z.string().min(1).default('0.1.0'),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Pretty-printed logs are for humans in development only; production stays JSON. */
    LOG_PRETTY: booleanish.optional(),

    /**
     * PostgreSQL connection string. Required in every environment -- there is no
     * embedded-database fallback, because production must never silently run on one.
     */
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
        'DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://)',
      ),

    /**
     * Exact browser origins allowed to call the API. No wildcard in production.
     * Note: Zod 4 `.default()` takes the *output* type, so the fallback is the parsed
     * array rather than the raw comma-separated string.
     */
    CORS_ORIGINS: csvList.default(['http://localhost:5173']),

    /** Global request ceiling per IP. Payment and auth routes add tighter limits. */
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(300),

    /** Maximum JSON body size. Uploads are handled separately with their own limits. */
    JSON_BODY_LIMIT: z.string().min(2).default('256kb'),

    /**
     * Number of reverse proxies in front of the app, so `req.ip` is the real client
     * address and rate limiting cannot be bypassed via a forged header.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    /** Seconds to let in-flight requests finish during a graceful shutdown. */
    SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production') {
      if (value.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'Wildcard CORS origin is not allowed in production',
        });
      }
      const insecureOrigin = value.CORS_ORIGINS.find(
        (origin) => origin.startsWith('http://') && !origin.startsWith('http://localhost'),
      );
      if (insecureOrigin !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: `Non-HTTPS origin "${insecureOrigin}" is not allowed in production`,
        });
      }
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: RawEnv['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly isDevelopment: boolean;
  readonly server: {
    readonly port: number;
    readonly host: string;
    readonly trustProxyHops: number;
    readonly jsonBodyLimit: string;
    readonly shutdownTimeoutMs: number;
  };
  readonly app: {
    readonly name: string;
    readonly version: string;
  };
  readonly logging: {
    readonly level: RawEnv['LOG_LEVEL'];
    readonly pretty: boolean;
  };
  readonly database: {
    readonly url: string;
  };
  readonly security: {
    readonly corsOrigins: readonly string[];
    readonly rateLimit: {
      readonly windowMs: number;
      readonly max: number;
    };
  };
}

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validate a raw environment bag into the typed application config.
 * Exported separately from the module-level singleton so tests can exercise invalid
 * configurations without mutating `process.env`.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigurationError(
      `Invalid environment configuration:\n  - ${problems.join('\n  - ')}`,
      problems,
    );
  }

  const env = result.data;

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isDevelopment: env.NODE_ENV === 'development',
    server: Object.freeze({
      port: env.PORT,
      host: env.HOST,
      trustProxyHops: env.TRUST_PROXY_HOPS,
      jsonBodyLimit: env.JSON_BODY_LIMIT,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    }),
    app: Object.freeze({
      name: 'school-finance-system-api',
      version: env.APP_VERSION,
    }),
    logging: Object.freeze({
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
    }),
    database: Object.freeze({
      url: env.DATABASE_URL,
    }),
    security: Object.freeze({
      corsOrigins: Object.freeze(env.CORS_ORIGINS),
      rateLimit: Object.freeze({
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.RATE_LIMIT_MAX_REQUESTS,
      }),
    }),
  });
}

/** The process-wide configuration. Import this, never `process.env`. */
export const config: AppConfig = loadConfig();
