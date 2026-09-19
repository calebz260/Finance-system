/**
 * Cryptographic primitives shared by the authentication layer.
 *
 * Three distinct jobs, deliberately kept apart because they need different treatment:
 *
 *  - **Reversible encryption** for TOTP secrets. The server has to recover the secret to
 *    verify a code, so hashing is not an option -- but a stolen database dump must not
 *    hand over the ability to generate valid codes. AES-256-GCM with a key held outside
 *    the database, and an authentication tag so a tampered ciphertext is rejected rather
 *    than silently decrypted to garbage.
 *
 *  - **Fast hashing** for high-entropy tokens: session refresh tokens, password-reset
 *    tokens, MFA recovery codes. These are 32 random bytes we generated, so there is
 *    nothing to brute-force and a slow KDF would only add latency. SHA-256 is correct
 *    here, and Argon2id would be cargo-cult. (Passwords are the opposite case and live in
 *    `password.ts`.)
 *
 *  - **Constant-time comparison**, so comparing a presented token against a stored hash
 *    cannot be turned into a byte-by-byte oracle through response timing.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

import { config } from '../config/env.js';

const AES_ALGORITHM = 'aes-256-gcm';
/** 96 bits, the size GCM is specified for. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Version marker on every ciphertext. It costs one byte of prefix and makes key
 * rotation a migration rather than a rewrite: a future `v2` can use a new key while
 * `v1` values remain decryptable.
 */
const CIPHERTEXT_VERSION = 'v1';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Encrypt a secret for storage.
 *
 * Output format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64url. Self-describing,
 * so decryption needs nothing but the key.
 */
export function encryptSecret(
  plaintext: string,
  key: Buffer = config.auth.mfaEncryptionKey,
): string {
  if (key.length !== 32) {
    throw new CryptoError('Encryption key must be exactly 32 bytes for AES-256-GCM');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    CIPHERTEXT_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a stored secret.
 *
 * Throws on a tampered or truncated value rather than returning something plausible:
 * GCM's authentication tag turns "someone edited the ciphertext" into a hard failure,
 * which is the behaviour we want for an MFA secret.
 */
export function decryptSecret(encoded: string, key: Buffer = config.auth.mfaEncryptionKey): string {
  const parts = encoded.split('.');
  if (parts.length !== 4) {
    throw new CryptoError('Malformed ciphertext: expected four dot-separated parts');
  }

  const [version, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  if (version !== CIPHERTEXT_VERSION) {
    throw new CryptoError(`Unsupported ciphertext version: ${version}`);
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const authTag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new CryptoError('Malformed ciphertext: bad initialisation vector or tag length');
  }

  try {
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // The underlying message ("unable to authenticate data") says nothing useful to a
    // caller and would leak implementation detail into logs, so it is deliberately not
    // attached as a `cause`.
    throw new CryptoError('Could not decrypt the stored secret; it may have been tampered with');
  }
}

/* --------------------------------------------------------------------- tokens */

/** Bytes of entropy in a generated token. 256 bits: not guessable, not enumerable. */
const TOKEN_BYTES = 32;

/**
 * A fresh opaque token, base64url so it is safe in a URL, a header and a cookie.
 * Returned to the caller once and never stored in this form.
 */
export function generateToken(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash a high-entropy token for storage.
 *
 * SHA-256 rather than Argon2id, because the input is already 256 bits of randomness --
 * there is no dictionary to attack, so a slow hash buys nothing and costs latency on
 * every refresh. Passwords, which are low-entropy and human-chosen, use Argon2id.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Compare a presented token against a stored hash without leaking, through timing, how
 * many leading bytes matched.
 */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a signal; both
  // sides are fixed-length SHA-256 digests, so a mismatch means malformed input.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------- recovery codes */

/**
 * Alphabet for MFA recovery codes. Excludes characters people confuse when copying
 * from paper: 0/O, 1/I/L, 2/Z, 5/S, 8/B. Ten symbols per group over 20 characters still
 * leaves far more entropy than a password.
 */
const RECOVERY_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 5;

/**
 * Generate a recovery code such as `AC3EF-HJK4M-NPQ6R-TUVWX`.
 *
 * `randomInt` is used rather than `Math.random` or a modulo of random bytes: it is
 * cryptographically sourced and rejection-samples, so the distribution over the
 * alphabet is uniform.
 */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < RECOVERY_GROUPS; group += 1) {
    let text = '';
    for (let index = 0; index < RECOVERY_GROUP_LENGTH; index += 1) {
      text += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    groups.push(text);
  }
  return groups.join('-');
}

/**
 * Normalise a recovery code the way a user is likely to type it: any case, with or
 * without the separating dashes, with stray whitespace.
 */
export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Hash a recovery code for storage, after normalising it. */
export function hashRecoveryCode(code: string): string {
  return hashToken(normaliseRecoveryCode(code));
}
