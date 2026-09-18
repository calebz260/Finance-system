import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from '../../src/config/env.js';

const minimalEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/school_finance',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies safe defaults for everything except the database URL', () => {
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
