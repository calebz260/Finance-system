/**
 * TOTP verification.
 *
 * The two properties worth testing are not "does RFC 6238 work" — `otpauth` covers that
 * — but the decisions layered on top of it: how much clock drift is forgiven, and
 * whether an observed code can be used twice.
 */
import { TOTP, Secret } from 'otpauth';
import { describe, expect, it } from 'vitest';

import {
  TOTP_PERIOD,
  buildTotpUri,
  generateTotpSecret,
  totpCounterAt,
  verifyTotp,
} from '../../src/lib/totp.js';

/** A code as the user's authenticator app would show it at `timestamp`. */
function codeAt(secret: string, timestamp: number): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp });
}

const NOW = Date.UTC(2026, 8, 19, 10, 0, 0);

describe('generateTotpSecret', () => {
  it('produces a distinct base32 secret each time', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));

    expect(secrets.size).toBe(20);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      // 20 bytes, base32-encoded.
      expect(secret.length).toBeGreaterThanOrEqual(32);
    }
  });
});

describe('buildTotpUri', () => {
  it('produces an otpauth URI carrying the issuer and the account label', () => {
    const secret = generateTotpSecret();
    const uri = buildTotpUri({ secret, accountLabel: 'bursar@gskicukiro.invalid' });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=School%20Finance%20System');
    expect(uri).toContain(encodeURIComponent('bursar@gskicukiro.invalid'));
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});

describe('verifyTotp', () => {
  it('accepts the code for the current step', () => {
    const secret = generateTotpSecret();

    const result = verifyTotp({ secret, code: codeAt(secret, NOW), timestamp: NOW });

    expect(result.valid).toBe(true);
    expect(result.counter).toBe(totpCounterAt(NOW));
  });

  it('tolerates one step of clock drift either side, because phone clocks drift', () => {
    const secret = generateTotpSecret();

    for (const offset of [-TOTP_PERIOD, TOTP_PERIOD]) {
      const result = verifyTotp({
        secret,
        code: codeAt(secret, NOW + offset * 1000),
        timestamp: NOW,
      });
      expect(result.valid).toBe(true);
    }
  });

  it('refuses a code from further away than one step', () => {
    // Wider tolerance would extend how long a shoulder-surfed code stays usable.
    const secret = generateTotpSecret();

    expect(
      verifyTotp({ secret, code: codeAt(secret, NOW + 3 * TOTP_PERIOD * 1000), timestamp: NOW })
        .valid,
    ).toBe(false);
  });

  it('refuses a code generated from a different secret', () => {
    expect(
      verifyTotp({
        secret: generateTotpSecret(),
        code: codeAt(generateTotpSecret(), NOW),
        timestamp: NOW,
      }).valid,
    ).toBe(false);
  });

  it('refuses a replayed code, even though it is cryptographically valid', () => {
    // This is the whole point of persisting the counter: without it, an observed code
    // works for up to 90 seconds, which is ample for someone reading over a shoulder.
    const secret = generateTotpSecret();
    const code = codeAt(secret, NOW);

    const first = verifyTotp({ secret, code, timestamp: NOW });
    expect(first.valid).toBe(true);

    const replay = verifyTotp({
      secret,
      code,
      timestamp: NOW,
      lastUsedCounter: first.counter ?? null,
    });
    expect(replay.valid).toBe(false);
  });

  it('accepts the next step after a code has been used', () => {
    const secret = generateTotpSecret();
    const used = verifyTotp({ secret, code: codeAt(secret, NOW), timestamp: NOW });

    const next = NOW + TOTP_PERIOD * 1000;
    const result = verifyTotp({
      secret,
      code: codeAt(secret, next),
      timestamp: next,
      lastUsedCounter: used.counter ?? null,
    });

    expect(result.valid).toBe(true);
    expect(result.counter).toBe((used.counter ?? 0) + 1);
  });

  it('tolerates the space people paste from an authenticator app', () => {
    const secret = generateTotpSecret();
    const code = codeAt(secret, NOW);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotp({ secret, code: spaced, timestamp: NOW }).valid).toBe(true);
  });

  it('refuses anything that is not six digits, without consulting the secret', () => {
    const secret = generateTotpSecret();

    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5', '000-000']) {
      expect(verifyTotp({ secret, code, timestamp: NOW }).valid).toBe(false);
    }
  });
});
