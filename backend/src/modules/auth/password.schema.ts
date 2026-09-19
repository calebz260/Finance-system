/**
 * Request schemas for the password routes.
 *
 * The asymmetry with `auth.schema.ts` is deliberate and is the point of keeping these
 * separate: a password being *presented* is only bounded above, while a password being
 * *set* is held to the full policy. The length floor is stated here so the user gets a
 * field error under the box they are typing in, rather than a domain error after the
 * request has travelled; the substantive checks — common passwords, the account's own
 * name and email — stay in `assertPasswordAcceptable`, which is the single place the
 * policy is defined.
 */
import { z } from 'zod';

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../lib/password.js';

/** A password being set, bounded at both ends. */
const newPassword = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `Choose a password of at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
  )
  .max(MAX_PASSWORD_LENGTH, 'That password is too long.');

/** A password being presented, bounded only above. */
const presentedPassword = z
  .string()
  .min(1, 'Enter your current password.')
  .max(MAX_PASSWORD_LENGTH, 'That password is too long.');

export const changePasswordSchema = z.strictObject({
  currentPassword: presentedPassword,
  newPassword,
});

export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

export const requestPasswordResetSchema = z.strictObject({
  email: z
    .email({ error: 'Enter a valid email address.' })
    .max(320, 'That email address is too long.')
    .transform((value) => value.trim().toLowerCase()),
});

export type RequestPasswordResetBody = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.strictObject({
  /**
   * The opaque token from the reset link. Bounded so a caller cannot make the server
   * hash an arbitrarily long string looking for a match.
   */
  token: z
    .string()
    .min(1, 'This reset link is missing its token. Request a new one.')
    .max(512, 'That reset token is not valid.'),
  newPassword,
});

export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
