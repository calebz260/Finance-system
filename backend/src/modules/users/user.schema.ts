/**
 * Request schemas for account administration.
 *
 * Two things are worth noting about what is *not* here:
 *
 *  - **No `status` field on the update schema.** A status change carries a different
 *    permission, a different audit action and a session revocation, so it has its own
 *    endpoint. Allowing it as a field on a general update would make "suspend this
 *    account" reachable by anyone holding `user.update`.
 *
 *  - **No `password` on the update schema either.** An administrator does not set
 *    another person's password: they unlock the account, or the owner resets it. That
 *    keeps "who knew this credential" answerable.
 *
 * `expectedVersion` is required on every mutation of an existing row, so a concurrent
 * edit is rejected with `RECORD_MODIFIED` rather than silently overwritten (ADR on
 * optimistic locking).
 */
import { RoleKey } from '@sfs/shared';
import { z } from 'zod';

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../lib/password.js';

const roleKey = z.enum(Object.values(RoleKey) as [RoleKey, ...RoleKey[]], {
  error: 'That is not a role in this system.',
});

const email = z
  .email({ error: 'Enter a valid email address.' })
  .max(320, 'That email address is too long.')
  .transform((value) => value.trim().toLowerCase());

const personName = z
  .string()
  .trim()
  .min(1, 'This field is required.')
  .max(100, 'That name is too long.');

/** Optional, and explicitly clearable by sending null. */
const phone = z.string().trim().max(30, 'That phone number is too long.').nullable().optional();

const expectedVersion = z.coerce
  .number({ error: 'The record version is required so concurrent edits can be detected.' })
  .int()
  .min(0);

export const listUsersQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().max(200).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED']).optional(),
  roleKey: roleKey.optional(),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const userIdParamsSchema = z.strictObject({
  userId: z.uuid({ error: 'That is not a valid user id.' }),
});

export type UserIdParams = z.infer<typeof userIdParamsSchema>;

export const userRoleParamsSchema = z.strictObject({
  userId: z.uuid({ error: 'That is not a valid user id.' }),
  roleKey,
});

export type UserRoleParams = z.infer<typeof userRoleParamsSchema>;

export const createUserSchema = z.strictObject({
  email,
  firstName: personName,
  lastName: personName,
  phone,
  /**
   * Omitted in the normal case: the server generates a temporary password and returns
   * it once. Supplying one is for the rare situation where the administrator is sitting
   * with the person and wants to agree it there and then.
   */
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Choose a password of at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    )
    .max(MAX_PASSWORD_LENGTH, 'That password is too long.')
    .optional(),
  /** At least one role: an account with none can sign in and do nothing at all. */
  roleKeys: z
    .array(roleKey)
    .min(1, 'Choose at least one role for this account.')
    .max(5, 'That is more roles than any one account should hold.'),
  /** Only a Super Administrator may name a school other than their own. */
  schoolId: z.uuid({ error: 'That is not a valid school id.' }).optional(),
});

export type CreateUserBody = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .strictObject({
    expectedVersion,
    firstName: personName.optional(),
    lastName: personName.optional(),
    phone,
    email: email.optional(),
  })
  .refine(
    (value) =>
      value.firstName !== undefined ||
      value.lastName !== undefined ||
      value.phone !== undefined ||
      value.email !== undefined,
    'Provide at least one field to change.',
  );

export type UpdateUserBody = z.infer<typeof updateUserSchema>;

export const setUserStatusSchema = z.strictObject({
  expectedVersion,
  /**
   * `LOCKED` is absent on purpose: a lockout is something the system does after failed
   * sign-ins, not something an administrator applies by hand. Suspension is the manual
   * equivalent, and it is the one that appears in the audit trail as a decision.
   */
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED'], {
    error: 'Choose active, suspended or disabled.',
  }),
  /** Recorded on the audit entry. Required for anything other than reactivation. */
  reason: z.string().trim().min(1).max(500).optional(),
});

export type SetUserStatusBody = z.infer<typeof setUserStatusSchema>;

export const grantRoleSchema = z.strictObject({
  roleKey,
});

export type GrantRoleBody = z.infer<typeof grantRoleSchema>;
