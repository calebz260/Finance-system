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

    /* --------------------------------------------------- authentication (Phase 2) */

    /**
     * Signing key for access tokens. Deliberately has no default in any environment: a
     * default signing key is a forgeable session, and a value that exists in the repo
     * eventually reaches production. 32 bytes is the minimum for HS256 to carry its
     * nominal strength.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (use a random value)'),

    /**
     * Short-lived on purpose. A revoked session is rejected on the next request anyway
     * (the session is checked against the database), so this bounds how long a *stolen*
     * token is usable, not how long a revocation takes to apply.
     */
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),

    /** Sliding session length. Rotated on every refresh. */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    /**
     * AES-256-GCM key protecting TOTP secrets at rest, as 32 bytes in base64. A stolen
     * database dump must not hand over the ability to generate valid MFA codes.
     */
    MFA_ENCRYPTION_KEY: z
      .string()
      .min(1, 'MFA_ENCRYPTION_KEY is required')
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'MFA_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64'),

    /** Label shown beside the code in the user's authenticator app. */
    MFA_ISSUER: z.string().min(1).default('School Finance System'),

    /** Consecutive failures before an account is locked. */
    MAX_FAILED_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),

    /** How long a locked account stays locked. */
    ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    /** Validity of a password-reset link. Short, because it is emailed. */
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

    /**
     * Validity of the intermediate token issued between a correct password and a
     * completed MFA challenge. Long enough to open an authenticator app, no longer.
     */
    MFA_CHALLENGE_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(5),

    /**
     * Cookie attributes for the refresh token. `Secure` is forced on in production;
     * `SameSite` is configurable because the API and the web client may be served from
     * different hosts, where `Strict` would drop the cookie.
     */
    REFRESH_COOKIE_NAME: z.string().min(1).default('sfs_refresh'),
    REFRESH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    REFRESH_COOKIE_DOMAIN: z.string().optional(),
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

      // `SameSite=None` sends the refresh cookie on every cross-site request, so it is
      // only defensible with CSRF protection in place. Rejected here rather than left as
      // a footgun someone discovers after a session-riding incident.
      if (value.REFRESH_COOKIE_SAMESITE === 'none') {
        ctx.addIssue({
          code: 'custom',
          path: ['REFRESH_COOKIE_SAMESITE'],
          message:
            'SameSite=None is not allowed in production. Serve the web client and the API ' +
            'from the same site, or add CSRF protection before relaxing this.',
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
  readonly auth: {
    readonly accessTokenSecret: string;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlSeconds: number;
    readonly mfaChallengeTtlSeconds: number;
    readonly passwordResetTtlSeconds: number;
    readonly maxFailedLoginAttempts: number;
    readonly accountLockMs: number;
    readonly mfaIssuer: string;
    /** Decoded 32-byte AES-256-GCM key for TOTP secrets at rest. */
    readonly mfaEncryptionKey: Buffer;
    readonly refreshCookie: {
      readonly name: string;
      readonly sameSite: 'strict' | 'lax' | 'none';
      readonly secure: boolean;
      readonly domain?: string;
      /** Scoped to the refresh route, so it is not sent with ordinary API calls. */
      readonly path: string;
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
    auth: Object.freeze({
      accessTokenSecret: env.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_MINUTES * 60,
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
      mfaChallengeTtlSeconds: env.MFA_CHALLENGE_TTL_MINUTES * 60,
      passwordResetTtlSeconds: env.PASSWORD_RESET_TTL_MINUTES * 60,
      maxFailedLoginAttempts: env.MAX_FAILED_LOGIN_ATTEMPTS,
      accountLockMs: env.ACCOUNT_LOCK_MINUTES * 60 * 1000,
      mfaIssuer: env.MFA_ISSUER,
      mfaEncryptionKey: Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64'),
      refreshCookie: Object.freeze({
        name: env.REFRESH_COOKIE_NAME,
        sameSite: env.REFRESH_COOKIE_SAMESITE,
        // Never negotiable in production: a refresh token sent over plain HTTP is a
        // session handed to anyone on the network path.
        secure: env.NODE_ENV === 'production',
        ...(env.REFRESH_COOKIE_DOMAIN !== undefined ? { domain: env.REFRESH_COOKIE_DOMAIN } : {}),
        // Narrow path: the browser then sends the refresh token only to the endpoints
        // that consume it, not alongside every ordinary API request.
        path: '/api/v1/auth',
      }),
    }),
  });
}

/** The process-wide configuration. Import this, never `process.env`. */
export const config: AppConfig = loadConfig();
