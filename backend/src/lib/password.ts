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
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Argon2 accepts arbitrarily long input, but hashing a megabyte of text is a cheap way
 * for a caller to burn server CPU, so the length is capped.
 *
 * Exported alongside the minimum so request schemas can bound an incoming password at
 * the edge, before it reaches a hash call, without restating the numbers.
 */
export const MAX_PASSWORD_LENGTH = 256;

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

/* --------------------------------------------------------------- password policy */

/**
 * Passwords seen constantly in credential-stuffing lists, plus the ones this particular
 * deployment invites: a school in Rwanda will otherwise collect a pile of accounts using
 * the school's own name.
 *
 * A short embedded list rather than a downloaded corpus. It catches the genuinely common
 * choices at no operational cost; Phase 11 can add a breach-corpus check if the review
 * calls for one. Compared after the same normalisation the check applies to the
 * candidate, so `Password123!` and `password123!` are both caught.
 */
const FORBIDDEN_PASSWORDS: readonly string[] = [
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'administrator',
  'iloveyou',
  'abc123',
  'abcd1234',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'changeme',
  'secret',
  'school',
  'schoolfees',
  'bursar',
  'finance',
  'rwanda',
  'kigali',
];

/** Lower-cased, with separators removed, so cosmetic variation does not defeat a check. */
function normaliseForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Identity fragments a password must not be built from: the email local part, the email
 * domain's first label, and each name. Short fragments are dropped — refusing every
 * password containing a two-letter surname would reject sound passwords for no gain.
 */
function identityFragments(identity: PasswordIdentity): string[] {
  const fragments: string[] = [];
  const [localPart, domain] = identity.email.split('@');
  if (localPart !== undefined) fragments.push(localPart);
  const domainLabel = domain?.split('.')[0];
  if (domainLabel !== undefined) fragments.push(domainLabel);
  if (identity.firstName !== undefined) fragments.push(identity.firstName);
  if (identity.lastName !== undefined) fragments.push(identity.lastName);

  return fragments.map(normaliseForComparison).filter((fragment) => fragment.length >= 4);
}

export interface PasswordIdentity {
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

/**
 * The password policy applied wherever a password is *set*: creation, change and reset.
 *
 * Deliberately NIST SP 800-63B-shaped rather than the familiar
 * "uppercase-lowercase-digit-symbol" rule. Composition rules push people towards
 * `Password1!` — which satisfies every class and is among the first guesses any attacker
 * makes — while a length floor plus a blocklist raises the cost of the guesses that
 * actually get made. Length is what buys strength here; Argon2id covers the rest.
 *
 * Three refusals, each for a distinct attack:
 *
 *  - **Too short** — brute force. Twelve characters is the floor.
 *  - **A known-common password** — credential stuffing, which tries these first.
 *  - **Built from the account's own identity** — targeted guessing by someone who knows
 *    the user, which in a school is everyone.
 *
 * Never applied when a password is *presented* at sign-in: see `auth.schema.ts`.
 */
export function assertPasswordAcceptable(password: string, identity: PasswordIdentity): void {
  assertPasswordLength(password);

  const normalised = normaliseForComparison(password);

  if (FORBIDDEN_PASSWORDS.includes(normalised)) {
    throw new PasswordPolicyError(
      'That password is one of the most commonly used and is too easy to guess. Choose something else.',
    );
  }

  for (const fragment of identityFragments(identity)) {
    if (normalised.includes(fragment)) {
      throw new PasswordPolicyError(
        'Your password must not contain your name, email address or the school name.',
      );
    }
  }

  // A single repeated character satisfies any length floor while carrying no entropy.
  if (/^(.)\1*$/.test(password)) {
    throw new PasswordPolicyError('Your password must not be a single repeated character.');
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
