/**
 * Account administration.
 *
 * Permissions get a caller through the door; the rules in this file decide what they may
 * then do with the accounts on the other side. Four of them are load-bearing:
 *
 *  - **Nobody edits their own role assignments.** Rank alone does not make this safe:
 *    a School Administrator outranks a Finance Manager (80 against 70) but does *not*
 *    hold `payment.reverse`, so a rank-only rule would let them grant themselves the
 *    lower-ranked role and acquire a permission they were never given. Self-assignment
 *    is refused outright, which turns every grant into an act by a second person.
 *
 *  - **Nobody grants a role above their own rank.** Otherwise `user.assign_role` is
 *    indistinguishable from Super Administrator: hand it to a bursar and they can
 *    appoint themselves anything.
 *
 *  - **Nobody deactivates their own account**, because the only outcome is a support
 *    call, and it is more likely a mis-click than an intention.
 *
 *  - **The last active Super Administrator cannot be removed or suspended.** There is no
 *    recovery path from an installation with nobody able to administer it.
 *
 * Tenant scoping is not a rule here so much as the ambient condition: every read and
 * write goes through the caller's `AccessScope`, so a School Administrator at one school
 * cannot see — let alone edit — an account at another, and an id from elsewhere reads as
 * "not found".
 */
import {
  ErrorCode,
  ROLE_DEFINITIONS,
  type CreatedUserAccount,
  type RoleCatalogueEntry,
  type RoleKey,
  type UserAccount,
  type UserAccountStatus,
  type UserRoleAssignment,
} from '@sfs/shared';

import type { UserStatus } from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import { generateToken } from '../../lib/crypto.js';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { createLogger } from '../../lib/logger.js';
import { assertPasswordAcceptable, hashPassword, PasswordPolicyError } from '../../lib/password.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { auditableUserFields, record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { SessionRevocationReason, revokeAllSessionsForUser } from '../auth/session.service.js';
import {
  userRepository,
  type UserListFilters,
  type UserRecord,
  type UserRepository,
} from './user.repository.js';

const log = createLogger('users.service');

/* ------------------------------------------------------------------ projection */

function toRoleAssignment(assignment: UserRecord['roleAssignments'][number]): UserRoleAssignment {
  return {
    roleKey: assignment.role.key as RoleKey,
    roleName: assignment.role.name,
    rank: assignment.role.rank,
    requiresMfa: assignment.role.requiresMfa,
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

/**
 * Project a row onto the wire type.
 *
 * `status` is assigned from the database enum into the shared union here, which is what
 * makes the two definitions impossible to drift apart without a compile error.
 */
export function toUserAccount(user: UserRecord): UserAccount {
  const status: UserAccountStatus = user.status;

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    schoolId: user.schoolId,
    status,
    isSystemAdministrator: user.isSystemAdministrator,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    mfaEnrolledAt: user.mfaEnrolledAt?.toISOString() ?? null,
    // Derived rather than stored: a lockout expires by the clock, and a `locked` column
    // would need a job to clear it and would be wrong in between.
    locked: user.lockedUntil !== null && user.lockedUntil > new Date(),
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    failedLoginAttempts: user.failedLoginAttempts,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    version: user.version,
    roles: user.roleAssignments.map(toRoleAssignment),
  };
}

/* ----------------------------------------------------------------------- rules */

/** Highest rank among the roles held by the account being acted on. */
function highestRank(user: UserRecord): number {
  return user.roleAssignments.reduce((rank, held) => Math.max(rank, held.role.rank), 0);
}

/**
 * Refuse an action against an account more privileged than the caller.
 *
 * Without this, `user.deactivate` held by a School Administrator would be enough to
 * suspend the Super Administrator and take the installation over.
 */
function assertMayActOn(actor: Principal, target: UserRecord, action: string): void {
  if (highestRank(target) > actor.highestRoleRank) {
    throw new ForbiddenError(
      'You cannot modify an account with a higher level of access than your own.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      {
        logContext: {
          action,
          actorUserId: actor.userId,
          actorRank: actor.highestRoleRank,
          targetUserId: target.id,
          targetRank: highestRank(target),
        },
      },
    );
  }
}

/**
 * Load an account within the caller's scope, or 404.
 *
 * Reads unscoped and then asserts, rather than filtering in the query, so that a
 * cross-school attempt is *recorded* as one — `assertPermits` tags the log entry while
 * still answering 404 (see `AccessScope`).
 */
async function loadInScope(
  repository: UserRepository,
  scope: AccessScope,
  userId: string,
): Promise<UserRecord> {
  const user = await repository.findByIdUnscoped(userId);
  scope.assertPermits(user, 'user account');
  if (user === null) throw new NotFoundError('The requested user account was not found.');
  return user;
}

/* ------------------------------------------------------------------------ reads */

export interface ListUsersResult {
  readonly items: readonly UserAccount[];
  readonly totalItems: number;
}

export async function listUsers(
  actor: Principal,
  filters: UserListFilters,
  pagination: ResolvedPagination,
  repository: UserRepository = userRepository,
): Promise<ListUsersResult> {
  const page = await repository.list(actor.scope, filters, pagination);
  return { items: page.items.map(toUserAccount), totalItems: page.totalItems };
}

export async function getUser(
  actor: Principal,
  userId: string,
  repository: UserRepository = userRepository,
): Promise<UserAccount> {
  return toUserAccount(await loadInScope(repository, actor.scope, userId));
}

/* --------------------------------------------------------------------- creation */

export interface CreateUserArgs {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone?: string | null;
  /** Omitted in the normal case, in which the server generates one. */
  readonly password?: string | undefined;
  readonly roleKeys: readonly RoleKey[];
  /** Only a system-scoped caller may name a school other than their own. */
  readonly schoolId?: string | undefined;
}

/**
 * A generated initial password.
 *
 * Long and random rather than memorable: it is transcribed once and replaced at first
 * sign-in, so there is no reason to trade entropy for typability. `base64url` keeps it
 * safe to copy out of a terminal or a chat message.
 */
function generateTemporaryPassword(): string {
  return generateToken(18);
}

/**
 * Create an account.
 *
 * Always created with `mustChangePassword`, whoever chose the password: an initial
 * credential has been handled by at least two people by the time it is used, so it is
 * not allowed to become the account's permanent one.
 */
export async function createUser(
  actor: Principal,
  args: CreateUserArgs,
  repository: UserRepository = userRepository,
): Promise<CreatedUserAccount> {
  const email = args.email.trim().toLowerCase();

  // Checked up front for a clear message. The unique index is still what guarantees it:
  // two concurrent creations both passing this check collide at the insert, which the
  // error handler renders as DUPLICATE_RESOURCE.
  if ((await repository.findIdByEmail(email)) !== null) {
    throw new ConflictError(
      'An account already exists for that email address.',
      ErrorCode.DUPLICATE_RESOURCE,
      { logContext: { email } },
    );
  }

  const schoolId = resolveTargetSchool(actor, args.schoolId);
  const roles = await resolveGrantableRoles(actor, args.roleKeys, repository);

  const generated = args.password === undefined;
  const password = args.password ?? generateTemporaryPassword();

  try {
    assertPasswordAcceptable(password, {
      email,
      firstName: args.firstName,
      lastName: args.lastName,
    });
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, error.message, {
        fieldErrors: [{ path: 'body.password', message: error.message }],
      });
    }
    throw error;
  }

  const passwordHash = await hashPassword(password);

  const created = await repository.create({
    schoolId,
    email,
    phone: args.phone ?? null,
    firstName: args.firstName,
    lastName: args.lastName,
    passwordHash,
    // INVITED, not ACTIVE: the account exists but its owner has not yet proved they
    // hold the credential. The first successful sign-in and password change is what
    // makes it active.
    status: 'INVITED',
    mustChangePassword: true,
  });

  for (const role of roles) {
    await repository.grantRole({
      userId: created.id,
      roleId: role.id,
      // A Super Administrator assignment is system-wide and carries no school.
      schoolId: role.key === 'SUPER_ADMIN' ? null : schoolId,
      assignedByUserId: actor.userId,
    });
  }

  await record({
    action: AuditAction.USER_CREATED,
    entityType: AuditEntity.USER,
    entityId: created.id,
    actorUserId: actor.userId,
    schoolId: created.schoolId,
    afterState: auditableUserFields({
      email: created.email,
      firstName: created.firstName,
      lastName: created.lastName,
      status: created.status,
      schoolId: created.schoolId,
      mustChangePassword: created.mustChangePassword,
    }),
    metadata: {
      roleKeys: roles.map((role) => role.key),
      passwordSource: generated ? 'generated' : 'supplied',
    },
  });

  const reloaded = await repository.findByIdUnscoped(created.id);

  return {
    user: toUserAccount(reloaded ?? created),
    // Returned exactly once, and only when the server chose it. An administrator who
    // supplied the password already knows it and does not need it echoed back.
    ...(generated ? { temporaryPassword: password } : {}),
  };
}

/**
 * Which school a new account belongs to.
 *
 * A school-scoped caller may only ever create within their own school, and naming
 * another one is refused rather than quietly redirected — silently ignoring the field
 * would let an administrator believe they had created an account somewhere they had not.
 */
function resolveTargetSchool(actor: Principal, requested: string | undefined): string | null {
  if (actor.scope.isSystem) {
    return requested ?? null;
  }

  const own = actor.scope.requireSchoolId();
  if (requested !== undefined && requested !== own) {
    throw new ForbiddenError(
      'You can only create accounts within your own school.',
      ErrorCode.SCHOOL_SCOPE_VIOLATION,
      { logContext: { actorUserId: actor.userId, ownSchoolId: own, requestedSchoolId: requested } },
    );
  }
  return own;
}

interface GrantableRole {
  readonly id: string;
  readonly key: RoleKey;
  readonly rank: number;
  readonly requiresMfa: boolean;
}

/** Resolve role keys to rows, refusing any the caller does not outrank. */
async function resolveGrantableRoles(
  actor: Principal,
  roleKeys: readonly RoleKey[],
  repository: UserRepository,
): Promise<GrantableRole[]> {
  const roles: GrantableRole[] = [];

  for (const key of roleKeys) {
    const role = await repository.findRoleByKey(key);
    if (role === null) {
      throw new NotFoundError(`No such role: ${key}.`);
    }
    assertMayGrantRank(actor, role.rank, key);
    roles.push({
      id: role.id,
      key: role.key as RoleKey,
      rank: role.rank,
      requiresMfa: role.requiresMfa,
    });
  }

  return roles;
}

/**
 * A caller may grant a role at or below their own rank, never above it.
 *
 * Equal is allowed deliberately: a School Administrator has to be able to appoint a
 * second School Administrator, or the school has exactly one person who can ever hold
 * the role and no way to replace them.
 */
function assertMayGrantRank(actor: Principal, rank: number, roleKey: string): void {
  if (rank > actor.highestRoleRank) {
    throw new ForbiddenError(
      'You cannot grant a role with a higher level of access than your own.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      {
        logContext: {
          actorUserId: actor.userId,
          actorRank: actor.highestRoleRank,
          roleKey,
          roleRank: rank,
        },
      },
    );
  }
}

/* ----------------------------------------------------------------------- updates */

export interface UpdateUserArgs {
  readonly userId: string;
  readonly expectedVersion: number;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly email?: string | undefined;
}

export async function updateUser(
  actor: Principal,
  args: UpdateUserArgs,
  repository: UserRepository = userRepository,
): Promise<UserAccount> {
  const existing = await loadInScope(repository, actor.scope, args.userId);
  assertMayActOn(actor, existing, 'user.update');

  if (args.email !== undefined) {
    const email = args.email.trim().toLowerCase();
    const holder = await repository.findIdByEmail(email);
    if (holder !== null && holder.id !== existing.id) {
      throw new ConflictError(
        'An account already exists for that email address.',
        ErrorCode.DUPLICATE_RESOURCE,
      );
    }
  }

  const changes = {
    ...(args.firstName !== undefined ? { firstName: args.firstName } : {}),
    ...(args.lastName !== undefined ? { lastName: args.lastName } : {}),
    ...(args.phone !== undefined ? { phone: args.phone } : {}),
    ...(args.email !== undefined ? { email: args.email } : {}),
  };

  const updated = await repository.update(actor.scope, {
    id: args.userId,
    expectedVersion: args.expectedVersion,
    changes,
  });

  await record({
    action: AuditAction.USER_UPDATED,
    entityType: AuditEntity.USER,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: updated.schoolId,
    beforeState: auditableUserFields(existing),
    afterState: auditableUserFields(updated),
  });

  return toUserAccount(updated);
}

/* ----------------------------------------------------------------- account status */

export interface SetUserStatusArgs {
  readonly userId: string;
  readonly expectedVersion: number;
  readonly status: Extract<UserStatus, 'ACTIVE' | 'SUSPENDED' | 'DISABLED'>;
  readonly reason?: string | undefined;
}

/**
 * Suspend, disable or restore an account.
 *
 * Suspending or disabling ends every session the account holds. Leaving them running
 * would mean "suspended" took effect only when an access token happened to expire —
 * except it would not even do that, because the refresh cookie would mint a new one.
 */
export async function setUserStatus(
  actor: Principal,
  args: SetUserStatusArgs,
  repository: UserRepository = userRepository,
): Promise<UserAccount> {
  const existing = await loadInScope(repository, actor.scope, args.userId);

  if (existing.id === actor.userId) {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      'You cannot change the status of your own account.',
    );
  }

  assertMayActOn(actor, existing, 'user.set_status');

  const losingAccess = args.status !== 'ACTIVE';
  if (losingAccess) {
    await assertNotLastSuperAdministrator(existing, repository);
  }

  const updated = await repository.setStatus(actor.scope, {
    id: args.userId,
    expectedVersion: args.expectedVersion,
    status: args.status,
  });

  if (losingAccess) {
    const revoked = await revokeAllSessionsForUser(
      updated.id,
      SessionRevocationReason.ACCOUNT_SUSPENDED,
    );
    log.info(
      { userId: updated.id, status: args.status, sessionsRevoked: revoked },
      'Account status changed; sessions revoked',
    );
  }

  await record({
    action: losingAccess ? AuditAction.USER_DEACTIVATED : AuditAction.USER_REACTIVATED,
    entityType: AuditEntity.USER,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: updated.schoolId,
    reason: args.reason ?? null,
    beforeState: auditableUserFields(existing),
    afterState: auditableUserFields(updated),
  });

  return toUserAccount(updated);
}

/**
 * Clear a brute-force lockout so the account's owner can try again.
 *
 * Deliberately does not touch the password: an administrator unlocking an account is
 * saying "this person is who they say they are and got it wrong five times", not
 * "issue them a new credential".
 */
export async function unlockUser(
  actor: Principal,
  userId: string,
  repository: UserRepository = userRepository,
): Promise<UserAccount> {
  const existing = await loadInScope(repository, actor.scope, userId);
  assertMayActOn(actor, existing, 'user.unlock');

  const updated = await repository.clearLockout(actor.scope, userId);

  await record({
    action: AuditAction.USER_UNLOCKED,
    entityType: AuditEntity.USER,
    entityId: updated.id,
    actorUserId: actor.userId,
    schoolId: updated.schoolId,
    metadata: { clearedFailedAttempts: existing.failedLoginAttempts },
  });

  return toUserAccount(updated);
}

/* ------------------------------------------------------------- role assignments */

/**
 * Refuse any change that would leave nobody able to administer the system.
 *
 * Counted across all schools and only over active accounts, because a suspended Super
 * Administrator is not a way back in either.
 */
async function assertNotLastSuperAdministrator(
  target: UserRecord,
  repository: UserRepository,
): Promise<void> {
  const holdsSuperAdmin = target.roleAssignments.some(
    (assignment) => assignment.role.key === 'SUPER_ADMIN',
  );
  if (!holdsSuperAdmin) return;

  const role = await repository.findRoleByKey('SUPER_ADMIN');
  if (role === null) return;

  const holders = await repository.countHoldersOfRole(role.id);
  if (holders <= 1) {
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      'This is the only active Super Administrator. Appoint another one before removing this access.',
    );
  }
}

export interface ChangeRoleArgs {
  readonly userId: string;
  readonly roleKey: RoleKey;
}

export async function grantRole(
  actor: Principal,
  args: ChangeRoleArgs,
  repository: UserRepository = userRepository,
): Promise<UserAccount> {
  const target = await loadInScope(repository, actor.scope, args.userId);
  assertNotSelf(actor, target, 'grant');
  assertMayActOn(actor, target, 'user.grant_role');

  const role = await repository.findRoleByKey(args.roleKey);
  if (role === null) throw new NotFoundError(`No such role: ${args.roleKey}.`);
  assertMayGrantRank(actor, role.rank, args.roleKey);

  if (await repository.hasRole(target.id, role.id)) {
    throw new ConflictError('This account already holds that role.', ErrorCode.CONFLICT);
  }

  await repository.grantRole({
    userId: target.id,
    roleId: role.id,
    schoolId: args.roleKey === 'SUPER_ADMIN' ? null : target.schoolId,
    assignedByUserId: actor.userId,
  });

  await record({
    action: AuditAction.USER_ROLE_GRANTED,
    entityType: AuditEntity.USER,
    entityId: target.id,
    actorUserId: actor.userId,
    schoolId: target.schoolId,
    metadata: { roleKey: args.roleKey, requiresMfa: role.requiresMfa },
  });

  // No session revocation: `authenticate` re-reads roles and permissions on every
  // request, so a grant takes effect immediately. If the new role requires MFA and the
  // live session never satisfied one, that same middleware refuses the next request and
  // the user signs in again — which is the intended outcome, not a gap.
  return toUserAccount(await loadInScope(repository, actor.scope, args.userId));
}

export async function revokeRole(
  actor: Principal,
  args: ChangeRoleArgs,
  repository: UserRepository = userRepository,
): Promise<UserAccount> {
  const target = await loadInScope(repository, actor.scope, args.userId);
  assertNotSelf(actor, target, 'revoke');
  assertMayActOn(actor, target, 'user.revoke_role');

  const role = await repository.findRoleByKey(args.roleKey);
  if (role === null) throw new NotFoundError(`No such role: ${args.roleKey}.`);
  assertMayGrantRank(actor, role.rank, args.roleKey);

  if (args.roleKey === 'SUPER_ADMIN') {
    await assertNotLastSuperAdministrator(target, repository);
  }

  const removed = await repository.revokeRole(target.id, role.id);
  if (!removed) {
    throw new NotFoundError('This account does not hold that role.');
  }

  await record({
    action: AuditAction.USER_ROLE_REVOKED,
    entityType: AuditEntity.USER,
    entityId: target.id,
    actorUserId: actor.userId,
    schoolId: target.schoolId,
    metadata: { roleKey: args.roleKey },
  });

  return toUserAccount(await loadInScope(repository, actor.scope, args.userId));
}

/**
 * Refuse a role change against the caller's own account.
 *
 * This is the rule that makes `user.assign_role` a delegation rather than a blank
 * cheque. Rank is not enough on its own: role ranks order privilege, but they do not
 * nest permissions — a School Administrator (rank 80) does not hold `payment.reverse`,
 * which a Finance Manager (rank 70) does. Allowing self-assignment of a lower-ranked
 * role would therefore be a genuine escalation, and it is the one an insider would
 * actually attempt.
 */
function assertNotSelf(actor: Principal, target: UserRecord, action: string): void {
  if (target.id !== actor.userId) return;

  throw new ForbiddenError(
    'You cannot change the roles on your own account. Ask another administrator.',
    ErrorCode.INSUFFICIENT_PERMISSION,
    { logContext: { actorUserId: actor.userId, action, selfAssignment: true } },
  );
}

/* --------------------------------------------------------------- role catalogue */

/**
 * The role catalogue, read from the shared definitions rather than the database.
 *
 * The seeded rows and this catalogue are generated from the same source, and Phase 2
 * does not yet offer runtime editing of a role's permissions — `role.manage` exists but
 * has no endpoint. When it does, this reads from the database instead, and the shared
 * catalogue reverts to being the seeded default it already describes itself as.
 */
export function listRoles(): readonly RoleCatalogueEntry[] {
  return ROLE_DEFINITIONS.map((definition) => ({
    key: definition.key,
    name: definition.name,
    description: definition.description,
    rank: definition.rank,
    requiresMfa: definition.requiresMfa,
    permissions: definition.permissions,
  }));
}
