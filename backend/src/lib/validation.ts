/**
 * Request-validation primitives shared by every module's Zod schemas.
 *
 * The money rule is the one worth reading, and it is the reason this file exists rather
 * than a copy of these validators in each module.
 *
 * **Monetary amounts arrive as strings and are validated by `Money` itself, never by
 * `z.number()`.** A JSON number has already lost precision by the time Zod sees it —
 * `150000.10` parses to `150000.09999999999`, and a validator that accepts it has
 * accepted a wrong amount. Rejecting numbers at the edge means the float never enters the
 * system at all (ADR-001, Section 13A).
 *
 * `Money.isValid` applies the same parsing, scale and maximum the storage layer uses, so
 * anything that validates here is storable without a second rounding step: there is no
 * "valid in the API, too large for the column" gap. The `transform` then normalises to
 * scale 2, so the service and the database always see the same string whatever the client
 * typed.
 *
 * Two copies of this rule would be one copy too many. A money validator that drifts
 * between modules is a payment endpoint quietly accepting an amount the fee endpoints
 * refuse.
 */
import { z } from 'zod';

import { Money } from '@sfs/shared';

export const uuidField = z.uuid({ error: 'That is not a valid id.' });

export const nameField = z
  .string()
  .trim()
  .min(1, 'This field is required.')
  .max(120, 'That name is too long.');

export const descriptionField = z.string().trim().max(500, 'That description is too long.');

/** A reason someone will read years later. Short enough to be a sentence, not an essay. */
export const reasonField = z
  .string()
  .trim()
  .min(3, 'A reason is required, and it is recorded permanently.')
  .max(500, 'That reason is too long.');

export const codeField = z
  .string()
  .trim()
  .min(1, 'A code is required.')
  .max(30, 'That code is too long.')
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only.')
  .transform((value) => value.toUpperCase());

export const expectedVersionField = z.coerce
  .number({ error: 'The record version is required so concurrent edits can be detected.' })
  .int()
  .min(0);

/** A monetary amount as a decimal string. See the module comment. */
export const moneyField = z
  .string()
  .trim()
  .min(1, 'An amount is required.')
  .refine((value) => Money.isValid(value), 'That is not a valid amount.')
  .transform((value) => Money.of(value).toString());

/** Non-negative: a fee line of zero is legitimate, a negative one is a hidden discount. */
export const nonNegativeMoneyField = moneyField.refine(
  (value) => !Money.of(value).isNegative(),
  'An amount cannot be negative.',
);

/** Strictly positive: an amount of zero moves nothing and should not be recorded. */
export const positiveMoneyField = moneyField.refine(
  (value) => Money.of(value).isPositive(),
  'An amount must be greater than zero.',
);

export const percentageField = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a percentage such as 25 or 12.5.')
  .refine((value) => {
    const parsed = Number(value);
    return parsed > 0 && parsed <= 100;
  }, 'A percentage must be above 0 and at most 100.');

/**
 * ISO-4217 currency code.
 *
 * Shape only. Whether the school *accepts* that currency is a domain decision made
 * against the account the money is going to, not something a regular expression can
 * answer — and getting it wrong means a silent conversion, which is never done
 * (Section 21).
 */
export const currencyField = z
  .string()
  .trim()
  .length(3, 'A currency code is three letters.')
  .regex(/^[A-Za-z]{3}$/, 'A currency code is three letters.')
  .transform((value) => value.toUpperCase());

export const paginationQueryFields = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
} as const;
