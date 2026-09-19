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
