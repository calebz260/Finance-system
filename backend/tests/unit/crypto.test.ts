/**
 * The cryptographic primitives behind sessions and MFA.
 *
 * These assert the properties the rest of the auth layer depends on, not the algorithms
 * themselves: that a tampered ciphertext fails loudly rather than decrypting to
 * something plausible, that a stored value never contains the secret it protects, and
 * that recovery codes survive the way a person actually types them.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  generateToken,
  hashRecoveryCode,
  hashToken,
  normaliseRecoveryCode,
  tokenMatchesHash,
} from '../../src/lib/crypto.js';

const SECRET = 'JBSWY3DPEHPK3PXP';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });

  it('never stores the plaintext', () => {
    const encrypted = encryptSecret(SECRET);
    expect(encrypted).not.toContain(SECRET);
    expect(encrypted.startsWith('v1.')).toBe(true);
  });

  it('produces a different ciphertext each time, so equal secrets are not detectable', () => {
    // A deterministic ciphertext would let anyone reading the table see which accounts
    // share an MFA secret -- and a repeated IV would break GCM outright.
    expect(encryptSecret(SECRET)).not.toBe(encryptSecret(SECRET));
  });

  /**
   * Change one character, at a position whose bits survive decoding.
   *
   * Not the last character: base64url encodes in 4-character groups, and when the final
   * group is partial its trailing bits are discarded on decode. Flipping the last
   * character therefore sometimes produces byte-identical output — which made an earlier
   * version of this test pass or fail depending on the randomly generated ciphertext.
   */
  function tamperFirstCharacter(part: string): string {
    return (part.startsWith('A') ? 'B' : 'A') + part.slice(1);
  }

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const [version, iv, tag, body] = encryptSecret(SECRET).split('.') as [
      string,
      string,
      string,
      string,
    ];

    const tampered = [version, iv, tag, tamperFirstCharacter(body)].join('.');

    expect(() => decryptSecret(tampered)).toThrow(CryptoError);
  });

  it('rejects a tampered authentication tag', () => {
    const [version, iv, tag, body] = encryptSecret(SECRET).split('.') as [
      string,
      string,
      string,
      string,
    ];

    const tampered = [version, iv, tamperFirstCharacter(tag), body].join('.');

    expect(() => decryptSecret(tampered)).toThrow(CryptoError);
  });

  it('rejects a tampered initialisation vector', () => {
    const [version, iv, tag, body] = encryptSecret(SECRET).split('.') as [
      string,
      string,
      string,
      string,
    ];

    const tampered = [version, tamperFirstCharacter(iv), tag, body].join('.');

    expect(() => decryptSecret(tampered)).toThrow(CryptoError);
  });

  it('rejects a value encrypted under a different key', () => {
    const otherKey = randomBytes(32);
    const encrypted = encryptSecret(SECRET, otherKey);

    expect(() => decryptSecret(encrypted)).toThrow(CryptoError);
    expect(decryptSecret(encrypted, otherKey)).toBe(SECRET);
  });

  it('rejects a malformed or unversioned value', () => {
    expect(() => decryptSecret('not-a-ciphertext')).toThrow(/four dot-separated parts/);
    expect(() => decryptSecret('v2.aaaa.bbbb.cccc')).toThrow(/Unsupported ciphertext version/);
    expect(() => decryptSecret('v1.short.tag.data')).toThrow(/initialisation vector or tag/);
  });

  it('refuses a key that is not 32 bytes, rather than silently weakening the cipher', () => {
    expect(() => encryptSecret(SECRET, randomBytes(16))).toThrow(/exactly 32 bytes/);
  });
});

describe('tokens', () => {
  it('generates distinct, URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes in base64url.
      expect(token.length).toBeGreaterThanOrEqual(43);
    }
  });

  it('hashes deterministically, and the hash does not contain the token', () => {
    const token = generateToken();

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
  });

  it('matches a token against its stored hash, and rejects anything else', () => {
    const token = generateToken();
    const stored = hashToken(token);

    expect(tokenMatchesHash(token, stored)).toBe(true);
    expect(tokenMatchesHash(generateToken(), stored)).toBe(false);
    // A length mismatch must read as "no match", not throw.
    expect(tokenMatchesHash(token, 'short')).toBe(false);
    expect(tokenMatchesHash(token, '')).toBe(false);
  });
});

describe('recovery codes', () => {
  it('generates four groups of five characters from an unambiguous alphabet', () => {
    for (let index = 0; index < 20; index += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{5}(-[ACDEFGHJKMNPQRTUVWXY34679]{5}){3}$/);
      // 0/O, 1/I/L, 2/Z, 5/S and 8/B are excluded: these are copied off paper.
      expect(code).not.toMatch(/[01258BILOSZ]/);
    }
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(100);
  });

  it('normalises the way people actually type a code', () => {
    const code = 'AC3EF-HJK4M-NPQ6R-TUVWX';
    const canonical = normaliseRecoveryCode(code);

    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normaliseRecoveryCode(code.replace(/-/g, ''))).toBe(canonical);
    expect(normaliseRecoveryCode(` ${code.replace(/-/g, ' ')} `)).toBe(canonical);
  });

  it('hashes equivalently however the code was typed', () => {
    // The user who writes the code on paper does not reproduce the dashes, and must
    // still be able to get back into their account.
    const code = generateRecoveryCode();
    const expected = hashRecoveryCode(code);

    expect(hashRecoveryCode(code.toLowerCase())).toBe(expected);
    expect(hashRecoveryCode(code.replace(/-/g, ''))).toBe(expected);
    expect(hashRecoveryCode(`  ${code}  `)).toBe(expected);
    expect(hashRecoveryCode(generateRecoveryCode())).not.toBe(expected);
  });
});
