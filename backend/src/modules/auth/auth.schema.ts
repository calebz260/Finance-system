/**
 * Request schemas for the authentication routes.
 *
 * Two rules shape what is validated here, and both are about not leaking information:
 *
 *  - **A sign-in never enforces the password policy.** The minimum length applies when a
 *    password is *set*, not when one is presented: rejecting a short password at sign-in
 *    would tell an attacker that the policy changed, and would lock out an account whose
 *    password predates the current rule. Only an upper bound is enforced, because hashing
 *    an unbounded string is a cheap way to burn server CPU.
 *
 *  - **Codes are accepted the way people actually type them.** A six-digit TOTP code gets
 *    pasted with a space in the middle; a recovery code gets typed in lower case, with or
 *    without its dashes. Both are normalised downstream (`verifyTotp` strips whitespace,
 *    `hashRecoveryCode` normalises case and separators), so the schema only has to accept
 *    the shape rather than reject a legitimate user over formatting.
 *
 * Every body is a `strictObject`: an unrecognised field is rejected rather than ignored,
 * so a client sending `{ email, passwrod }` gets told, instead of being reported as a
 * wrong password.
 */
import { z } from 'zod';

import { MAX_PASSWORD_LENGTH } from '../../lib/password.js';

/** Bounded so a caller cannot make the server hash an arbitrarily long string. */
const presentedPassword = z
  .string()
  .min(1, 'Enter your password.')
  .max(MAX_PASSWORD_LENGTH, 'That password is too long.');

const email = z
  .email({ error: 'Enter a valid email address.' })
  .max(320, 'That email address is too long.')
  // Normalised here so the service compares against what the database stores. Doing it in
  // one place stops "Bursar@school.rw" and "bursar@school.rw" behaving as two accounts.
  .transform((value) => value.trim().toLowerCase());

/** Six digits, tolerating the space people paste from an authenticator app. */
const totpCode = z
  .string()
  .min(1, 'Enter the 6-digit code from your authenticator app.')
  .max(20, 'That code is not valid.')
  .refine((value) => /^\d{6}$/.test(value.replace(/\s+/g, '')), 'Enter the 6-digit code.');

/** Four groups of five characters, but accepted in any case and with any separators. */
const recoveryCode = z
  .string()
  .min(1, 'Enter a recovery code.')
  .max(64, 'That recovery code is not valid.')
  .refine(
    (value) => value.replace(/[^A-Za-z0-9]/g, '').length === 20,
    'A recovery code has 20 characters.',
  );

/** An opaque intermediate token from a sign-in step. Never a session token. */
const challengeToken = z
  .string()
  .min(1, 'This verification step is missing its token. Sign in again.')
  .max(4096);

export const loginSchema = z.strictObject({
  email,
  password: presentedPassword,
});

export type LoginBody = z.infer<typeof loginSchema>;

/**
 * Verifying the second factor. Exactly one of `code` or `recoveryCode` must be present --
 * the service refuses both-or-neither too, but catching it here turns a domain error into
 * a field error the form can point at.
 */
export const verifyMfaSchema = z
  .strictObject({
    challengeToken,
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
  })
  .refine(
    (value) => (value.code === undefined) !== (value.recoveryCode === undefined),
    'Provide either an authenticator code or a recovery code, not both.',
  );

export type VerifyMfaBody = z.infer<typeof verifyMfaSchema>;

/** Starting enrolment during a sign-in, authorised by the token `login` handed back. */
export const startEnrolmentSchema = z.strictObject({
  enrolmentToken: challengeToken,
});

export type StartEnrolmentBody = z.infer<typeof startEnrolmentSchema>;

/** Confirming enrolment during a sign-in. Establishes the session on success. */
export const confirmEnrolmentSchema = z.strictObject({
  enrolmentToken: challengeToken,
  code: totpCode,
});

export type ConfirmEnrolmentBody = z.infer<typeof confirmEnrolmentSchema>;

/** Confirming voluntary enrolment, authorised by the caller's existing session. */
export const confirmOwnEnrolmentSchema = z.strictObject({
  code: totpCode,
});

export type ConfirmOwnEnrolmentBody = z.infer<typeof confirmOwnEnrolmentSchema>;

/**
 * Turning MFA off needs the password *and* a current code: disabling the second factor is
 * exactly what an attacker holding a hijacked session would do, so a session alone is not
 * sufficient authority.
 */
export const disableMfaSchema = z.strictObject({
  password: presentedPassword,
  code: totpCode,
});

export type DisableMfaBody = z.infer<typeof disableMfaSchema>;

export const sessionIdParamsSchema = z.strictObject({
  sessionId: z.uuid({ error: 'That is not a valid session id.' }),
});

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
