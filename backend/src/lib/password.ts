/**
 * Password hashing.
 *
 * Argon2id, the current recommendation for password storage: memory-hard, so a GPU or
 * ASIC attacker gains far less than against a purely iterative hash, and side-channel
 * resistant on the data-independent half.
 *
 * Parameters follow OWASP's guidance (19 MiB memory, 2 passes, 1 degree of parallelism).
 * That is a deliberate balance: a bursar signing in on a modest server should not wait a
 * second, while an attacker working from a stolen dump is slowed by orders of magnitude.
 *
 * The cost is recorded inside the PHC hash string, so raising it later does not
 * invalidate existing passwords -- `needsRehash` detects hashes made with weaker
 * parameters, and they are upgraded on the owner's next successful sign-in.
 */
import { type Algorithm, hash, parseOptions, verify } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`, inlined as its numeric value: the package declares Algorithm as
 * an ambient `const enum`, which cannot be imported as a value under
 * `verbatimModuleSyntax`. Typed as `Algorithm` so a wrong number would not compile.
 */
const ARGON2ID: Algorithm = 2;

/** OWASP-recommended Argon2id parameters. Raise, never lower. */
const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Rejected outright, so a truncation bug cannot yield a trivially crackable hash. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Argon2 accepts arbitrarily long input, but hashing a megabyte of text is a cheap way
 * for a caller to burn server CPU, so the length is capped.
 */
const MAX_PASSWORD_LENGTH = 256;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

export function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters long.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at most ${String(MAX_PASSWORD_LENGTH)} characters long.`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  return hash(password, HASH_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * No options are passed: Argon2 reads the cost parameters and salt from the stored PHC
 * string, which is what allows an old hash to keep verifying after the policy is raised.
 *
 * Returns false rather than throwing on a malformed or unrecognised hash. A corrupt
 * stored value must read as "wrong password", not as a 500 that tells a caller something
 * unusual about this particular account.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (password.length === 0 || storedHash.length === 0) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was produced with weaker parameters than the current policy
 * and should be re-hashed after a successful sign-in.
 *
 * An unparseable hash also returns true: whatever it is, it is not a hash made to the
 * current policy, so it should be replaced at the next opportunity.
 */
export function needsRehash(storedHash: string): boolean {
  try {
    const parsed = parseOptions(storedHash);
    return (
      parsed.algorithm !== ARGON2ID ||
      parsed.memoryCost < HASH_OPTIONS.memoryCost ||
      parsed.timeCost < HASH_OPTIONS.timeCost ||
      parsed.parallelism < HASH_OPTIONS.parallelism
    );
  } catch {
    return true;
  }
}
