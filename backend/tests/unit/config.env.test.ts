import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from '../../src/config/env.js';

/**
 * The three variables with no default in any environment. The two auth secrets are
 * deliberately defaultless -- a shared default signing key is a forgeable session -- so
 * every case here has to supply them even when testing something unrelated.
 */
const minimalEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/school_finance',
  JWT_ACCESS_SECRET: 'test-only-access-token-secret-0123456789abcdef',
  // 32 bytes of 0x74 ('t'), base64: the exact length AES-256-GCM requires.
  MFA_ENCRYPTION_KEY: 'dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHQ=',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies safe defaults for everything except the database URL and auth secrets', () => {
    const config = loadConfig(minimalEnv);

    expect(config.env).toBe('development');
    expect(config.server.port).toBe(4000);
    expect(config.server.trustProxyHops).toBe(0);
    expect(config.security.corsOrigins).toEqual(['http://localhost:5173']);
    expect(config.security.rateLimit.max).toBe(300);
    expect(config.isProduction).toBe(false);
  });

  it('requires a PostgreSQL connection string', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/school' })).toThrow(
      /must be a PostgreSQL connection string/,
    );
    // Guards against anyone reintroducing a file-based database (Section 3).
    expect(() => loadConfig({ DATABASE_URL: 'file:./dev.db' })).toThrow(ConfigurationError);
  });

  it('reports every configuration problem at once', () => {
    try {
      loadConfig({ DATABASE_URL: 'not-a-url', PORT: '70000', LOG_LEVEL: 'chatty' });
      expect.unreachable('expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const problems = (error as ConfigurationError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(3);
      expect(problems.join('\n')).toMatch(/DATABASE_URL/);
      expect(problems.join('\n')).toMatch(/PORT/);
      expect(problems.join('\n')).toMatch(/LOG_LEVEL/);
    }
  });

  it('parses a comma-separated CORS list, trimming and de-duplicating', () => {
    const config = loadConfig({
      ...minimalEnv,
      CORS_ORIGINS: ' https://fees.school.rw , https://admin.school.rw ,https://fees.school.rw, ',
    });
    expect(config.security.corsOrigins).toEqual([
      'https://fees.school.rw',
      'https://admin.school.rw',
    ]);
  });

  it('rejects a wildcard CORS origin in production', () => {
    expect(() => loadConfig({ ...minimalEnv, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /Wildcard CORS origin is not allowed in production/,
    );
  });

  it('rejects a non-HTTPS production origin but allows localhost in development', () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'http://fees.school.rw',
      }),
    ).toThrow(/Non-HTTPS origin/);

    expect(
      loadConfig({ ...minimalEnv, CORS_ORIGINS: 'http://localhost:5173' }).security.corsOrigins,
    ).toEqual(['http://localhost:5173']);
  });

  it('coerces numeric settings and enforces their bounds', () => {
    const config = loadConfig({ ...minimalEnv, PORT: '8080', TRUST_PROXY_HOPS: '2' });
    expect(config.server.port).toBe(8080);
    expect(config.server.trustProxyHops).toBe(2);

    expect(() => loadConfig({ ...minimalEnv, TRUST_PROXY_HOPS: '-1' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...minimalEnv, SHUTDOWN_TIMEOUT_SECONDS: '0' })).toThrow(
      ConfigurationError,
    );
  });

  it('converts the shutdown timeout to milliseconds', () => {
    expect(
      loadConfig({ ...minimalEnv, SHUTDOWN_TIMEOUT_SECONDS: '30' }).server.shutdownTimeoutMs,
    ).toBe(30_000);
  });

  it('pretty-prints logs in development and not in production', () => {
    expect(loadConfig(minimalEnv).logging.pretty).toBe(true);
    expect(
      loadConfig({
        ...minimalEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://fees.school.rw',
      }).logging.pretty,
    ).toBe(false);
  });

  it('returns a frozen config so nothing can mutate it at runtime', () => {
    const config = loadConfig(minimalEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.security)).toBe(true);
  });
});

describe('loadConfig: authentication', () => {
  const productionEnv = {
    ...minimalEnv,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://fees.school.rw',
  } satisfies NodeJS.ProcessEnv;

  it('refuses to start without the two defaultless secrets', () => {
    const { JWT_ACCESS_SECRET: _jwt, ...withoutJwt } = minimalEnv;
    const { MFA_ENCRYPTION_KEY: _mfa, ...withoutKey } = minimalEnv;

    expect(() => loadConfig(withoutJwt)).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadConfig(withoutKey)).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it('rejects a signing key short enough to weaken HS256', () => {
    expect(() => loadConfig({ ...minimalEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects an MFA key that is not exactly 32 bytes', () => {
    // Valid base64, wrong length: 16 bytes cannot key AES-256.
    const sixteenBytes = Buffer.alloc(16, 0x74).toString('base64');
    expect(() => loadConfig({ ...minimalEnv, MFA_ENCRYPTION_KEY: sixteenBytes })).toThrow(
      /exactly 32 bytes/,
    );
  });

  it('decodes the MFA key to a 32-byte buffer', () => {
    const { auth } = loadConfig(minimalEnv);
    expect(Buffer.isBuffer(auth.mfaEncryptionKey)).toBe(true);
    expect(auth.mfaEncryptionKey).toHaveLength(32);
  });

  it('converts token lifetimes from their human-facing units', () => {
    const { auth } = loadConfig({
      ...minimalEnv,
      ACCESS_TOKEN_TTL_MINUTES: '20',
      REFRESH_TOKEN_TTL_DAYS: '7',
      ACCOUNT_LOCK_MINUTES: '30',
    });

    expect(auth.accessTokenTtlSeconds).toBe(1_200);
    expect(auth.refreshTokenTtlSeconds).toBe(604_800);
    // Milliseconds, not seconds: it is compared against a Date.
    expect(auth.accountLockMs).toBe(1_800_000);
  });

  it('forces a Secure refresh cookie in production but not in development', () => {
    expect(loadConfig(minimalEnv).auth.refreshCookie.secure).toBe(false);
    expect(loadConfig(productionEnv).auth.refreshCookie.secure).toBe(true);
  });

  it('scopes the refresh cookie to the auth routes', () => {
    // So the browser does not attach a long-lived credential to every ordinary API call.
    expect(loadConfig(minimalEnv).auth.refreshCookie.path).toBe('/api/v1/auth');
  });

  it('rejects SameSite=None in production', () => {
    // It would send the refresh cookie on every cross-site request, which is only
    // defensible with CSRF protection in place.
    expect(() => loadConfig({ ...productionEnv, REFRESH_COOKIE_SAMESITE: 'none' })).toThrow(
      /SameSite=None is not allowed in production/,
    );
    // Still available in development, where the client and API may be on different hosts.
    expect(
      loadConfig({ ...minimalEnv, REFRESH_COOKIE_SAMESITE: 'none' }).auth.refreshCookie.sameSite,
    ).toBe('none');
  });

  it('omits the cookie domain unless one is configured', () => {
    expect(loadConfig(minimalEnv).auth.refreshCookie.domain).toBeUndefined();
    expect(
      loadConfig({ ...minimalEnv, REFRESH_COOKIE_DOMAIN: '.school.rw' }).auth.refreshCookie.domain,
    ).toBe('.school.rw');
  });
});

describe('loadConfig: payments', () => {
  const productionEnv = {
    ...minimalEnv,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://fees.school.rw',
  } satisfies NodeJS.ProcessEnv;

  const sandboxSecret = 'sandbox-webhook-secret-with-enough-length-0123';

  it('refuses to start with the payment simulator enabled in production', () => {
    // The sandbox can mint payment confirmations, and in production a confirmation
    // credits a real student's account. That is a refusal to start, not a warning.
    expect(() =>
      loadConfig({
        ...productionEnv,
        PAYMENT_SANDBOX_ENABLED: 'true',
        PAYMENT_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
      }),
    ).toThrow(/must never be enabled in production/);
  });

  it('refuses the simulator without a usable webhook secret, in every environment', () => {
    // Checked outside production too: a developer whose machine credits payments on an
    // unsigned POST learns the wrong lesson about what that endpoint guarantees.
    expect(() => loadConfig({ ...minimalEnv, PAYMENT_SANDBOX_ENABLED: 'true' })).toThrow(
      /at least 32 characters/,
    );
    expect(() =>
      loadConfig({
        ...minimalEnv,
        PAYMENT_SANDBOX_ENABLED: 'true',
        PAYMENT_SANDBOX_WEBHOOK_SECRET: 'too-short',
      }),
    ).toThrow(ConfigurationError);
  });

  it('holds no webhook secret at all when the simulator is off', () => {
    const config = loadConfig({
      ...minimalEnv,
      PAYMENT_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
    });

    expect(config.payments.sandbox.enabled).toBe(false);
    // Narrowed to null rather than carried as a live secret nothing may use.
    expect(config.payments.sandbox.webhookSecret).toBeNull();
  });

  it('accepts the simulator outside production and keeps its secret', () => {
    const config = loadConfig({
      ...minimalEnv,
      PAYMENT_SANDBOX_ENABLED: 'true',
      PAYMENT_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
    });

    expect(config.payments.sandbox.enabled).toBe(true);
    expect(config.payments.sandbox.webhookSecret).toBe(sandboxSecret);
  });

  it('defaults and bounds the replay window', () => {
    expect(loadConfig(minimalEnv).payments.webhookMaxSkewSeconds).toBe(120);
    expect(
      loadConfig({ ...minimalEnv, PAYMENT_WEBHOOK_MAX_SKEW_SECONDS: '30' }).payments
        .webhookMaxSkewSeconds,
    ).toBe(30);

    // A window of an hour would make a captured callback reusable for an hour.
    expect(() => loadConfig({ ...minimalEnv, PAYMENT_WEBHOOK_MAX_SKEW_SECONDS: '5000' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...minimalEnv, PAYMENT_WEBHOOK_MAX_SKEW_SECONDS: '1' })).toThrow(
      ConfigurationError,
    );
  });

  it('bounds the proof-of-payment upload size', () => {
    expect(loadConfig(minimalEnv).uploads.maxBytes).toBe(5 * 1024 * 1024);
    expect(loadConfig({ ...minimalEnv, UPLOAD_MAX_BYTES: '1048576' }).uploads.maxBytes).toBe(
      1_048_576,
    );
    expect(() => loadConfig({ ...minimalEnv, UPLOAD_MAX_BYTES: '999999999' })).toThrow(
      ConfigurationError,
    );
  });
});
