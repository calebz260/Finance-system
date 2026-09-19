/**
 * Audit logging (Section 27).
 *
 * Design points that matter more than the shape of the row:
 *
 *  - **Actor and request context are picked up automatically** from the ambient request
 *    context, so a caller cannot forget to record who did something. Callers may
 *    override, which is needed for a failed sign-in: there is no authenticated actor, but
 *    the attempted email and the source IP are exactly what an investigation needs.
 *
 *  - **A write inside a transaction stays inside it.** When a financial operation rolls
 *    back, its audit entry must roll back too, or the log claims something happened that
 *    did not. Callers doing multi-step work pass the transaction client.
 *
 *  - **A failed audit write never breaks the request that it describes** for read-only or
 *    security-observation events, but it *does* fail loudly for state changes. Losing the
 *    record of a failed sign-in is bad; silently completing a payment whose audit entry
 *    was lost is worse. `record` throws; `recordSafely` does not.
 *
 *  - **Insert only.** There is no update or delete path here, and Phase 11 revokes those
 *    privileges from the database role so the application cannot regain one.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditResult } from '../../generated/prisma/enums.js';
import { getRequestContext } from '../../lib/request-context.js';
import { createLogger } from '../../lib/logger.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';
import type { AuditAction, AuditEntity } from './audit.actions.js';

const log = createLogger('audit');

export interface AuditEntryInput {
  readonly action: AuditAction;
  /**
   * Use an `AuditEntity` value wherever one fits. Left as `string` because a few entries
   * describe something that is not a domain row -- `authorize.ts` records a denied route
   * as `'Route'` -- and widening the union to `string` is what TypeScript does anyway.
   */
  readonly entityType: AuditEntity | (string & NonNullable<unknown>);
  readonly entityId?: string | null;
  readonly result?: AuditResult;
  /** Why a failure happened, or context for a success. Never secrets. */
  readonly reason?: string | null;

  /** Overrides the ambient actor. Used for unauthenticated events. */
  readonly actorUserId?: string | null;
  readonly actorRoleKey?: string | null;
  readonly schoolId?: string | null;

  /** State captured before and after a change, for financial and account edits. */
  readonly beforeState?: Prisma.InputJsonValue | null;
  readonly afterState?: Prisma.InputJsonValue | null;
  readonly metadata?: Prisma.InputJsonValue | null;
}

function buildRow(input: AuditEntryInput): Prisma.AuditLogUncheckedCreateInput {
  const context = getRequestContext();

  return {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    result: input.result ?? AuditResult.SUCCESS,
    reason: input.reason ?? null,

    // Explicit override wins; otherwise the ambient authenticated actor.
    actorUserId: input.actorUserId ?? context?.actorUserId ?? null,
    actorRoleKey: input.actorRoleKey ?? null,
    schoolId: input.schoolId ?? context?.schoolId ?? null,

    requestId: context?.requestId ?? null,
    ipAddress: context?.ipAddress ?? null,
    userAgent: context?.userAgent ?? null,

    ...(input.beforeState != null ? { beforeState: input.beforeState } : {}),
    ...(input.afterState != null ? { afterState: input.afterState } : {}),
    ...(input.metadata != null ? { metadata: input.metadata } : {}),
  };
}

/**
 * Write an audit entry. Throws if the write fails.
 *
 * Used for state changes, where a lost entry would leave the trail disagreeing with
 * reality. Pass `client` to join the caller's transaction.
 */
export async function record(
  input: AuditEntryInput,
  client: PrismaTransactionClient = prisma,
): Promise<void> {
  await client.auditLog.create({ data: buildRow(input) });
}

/**
 * Write an audit entry, logging rather than throwing on failure.
 *
 * For observations that must not turn into a user-visible error: a failed sign-in should
 * still return "invalid credentials" even if the audit insert fails, otherwise a database
 * hiccup becomes a 500 on the login screen.
 */
export async function recordSafely(
  input: AuditEntryInput,
  client: PrismaTransactionClient = prisma,
): Promise<void> {
  try {
    await record(input, client);
  } catch (error) {
    log.error(
      { err: error, action: input.action, entityType: input.entityType },
      'Failed to write an audit entry',
    );
  }
}

/**
 * Redact a user row down to what is safe and useful in an audit `beforeState` /
 * `afterState`.
 *
 * Password hashes, MFA secrets and tokens are never recorded: the audit log is read by
 * more people than the users table, and it is retained far longer.
 */
export function auditableUserFields(user: {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  status?: string;
  schoolId?: string | null;
  isSystemAdministrator?: boolean;
  mfaEnabled?: boolean;
  mustChangePassword?: boolean;
}): Prisma.InputJsonValue {
  const fields: Record<string, string | boolean | null> = {};
  if (user.email !== undefined) fields.email = user.email;
  if (user.firstName !== undefined) fields.firstName = user.firstName;
  if (user.lastName !== undefined) fields.lastName = user.lastName;
  if (user.phone !== undefined) fields.phone = user.phone;
  if (user.status !== undefined) fields.status = user.status;
  if (user.schoolId !== undefined) fields.schoolId = user.schoolId;
  if (user.isSystemAdministrator !== undefined) {
    fields.isSystemAdministrator = user.isSystemAdministrator;
  }
  if (user.mfaEnabled !== undefined) fields.mfaEnabled = user.mfaEnabled;
  if (user.mustChangePassword !== undefined) {
    fields.mustChangePassword = user.mustChangePassword;
  }
  return fields;
}
