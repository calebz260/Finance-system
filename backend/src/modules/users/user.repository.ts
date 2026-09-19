/**
 * User-account data access.
 *
 * Follows the conventions the student repository established — every method takes an
 * `AccessScope`, lists are paginated, updates are conditional on `version` — with one
 * addition specific to accounts:
 *
 * **Credential columns are never selected.** `passwordHash`, `mfaSecretEncrypted` and
 * `mfaPendingSecretEncrypted` do not appear in any projection here, so an administration
 * screen cannot leak them through a shape that grew a field. The authentication service
 * reads those columns itself, by name, where it genuinely needs them.
 *
 * The email uniqueness check is the one deliberately unscoped query: `users.email` is
 * globally unique, so "is this address taken?" cannot be answered within one school
 * without reporting a false negative that the insert would then reject anyway.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { UserStatus } from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { requireVersionedUpdate } from '../../lib/optimistic-lock.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

/** The columns an administration screen may see. Credentials are absent by design. */
const USER_PROJECTION = {
  id: true,
  schoolId: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  status: true,
  isSystemAdministrator: true,
  mustChangePassword: true,
  mfaEnabled: true,
  mfaEnrolledAt: true,
  failedLoginAttempts: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  roleAssignments: {
    select: {
      assignedAt: true,
      role: { select: { key: true, name: true, rank: true, requiresMfa: true } },
    },
  },
} as const satisfies Prisma.UserSelect;

export type UserRecord = Prisma.UserGetPayload<{ select: typeof USER_PROJECTION }>;

export interface UserListFilters {
  /** Free-text across name and email. */
  readonly search?: string | undefined;
  readonly status?: UserStatus | undefined;
  readonly roleKey?: string | undefined;
}

export interface CreateUserInput {
  readonly schoolId: string | null;
  readonly email: string;
  readonly phone?: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
  readonly mustChangePassword: boolean;
}

export interface UpdateUserInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string | null;
  readonly email?: string;
}

export interface PagedResult<TItem> {
  readonly items: TItem[];
  readonly totalItems: number;
}

export class UserRepository {
  constructor(private readonly db: PrismaTransactionClient = prisma) {}

  withTransaction(tx: PrismaTransactionClient): UserRepository {
    return new UserRepository(tx);
  }

  /**
   * Fetch by primary key within the scope.
   *
   * Soft-deleted accounts are excluded everywhere in this repository: they are retained
   * for audit history, not for administration, and an administrator acting on one would
   * be editing a record the rest of the system treats as gone.
   */
  async findById(scope: AccessScope, id: string): Promise<UserRecord | null> {
    return this.db.user.findFirst({
      where: scope.where({ id, deletedAt: null }),
      select: USER_PROJECTION,
    });
  }

  /**
   * Fetch by primary key *without* a scope filter, for the caller that needs to
   * distinguish "no such account" from "an account in another school".
   *
   * The result is passed to `AccessScope.assertPermits`, which answers 404 either way —
   * the distinction is recorded in the logs, not in the response.
   */
  async findByIdUnscoped(id: string): Promise<UserRecord | null> {
    return this.db.user.findFirst({ where: { id, deletedAt: null }, select: USER_PROJECTION });
  }

  /** Unscoped on purpose: `users.email` is unique across the whole system. */
  async findIdByEmail(email: string): Promise<{ id: string } | null> {
    return this.db.user.findFirst({
      where: { email: email.trim().toLowerCase() },
      select: { id: true },
    });
  }

  async list(
    scope: AccessScope,
    filters: UserListFilters,
    pagination: ResolvedPagination,
  ): Promise<PagedResult<UserRecord>> {
    const where = this.buildWhere(scope, filters);

    const [items, totalItems] = await Promise.all([
      this.db.user.findMany({
        where,
        select: USER_PROJECTION,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { email: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.db.user.count({ where }),
    ]);

    return { items, totalItems };
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    return this.db.user.create({
      data: {
        schoolId: input.schoolId,
        email: input.email.trim().toLowerCase(),
        phone: input.phone ?? null,
        firstName: input.firstName,
        lastName: input.lastName,
        passwordHash: input.passwordHash,
        status: input.status,
        mustChangePassword: input.mustChangePassword,
      },
      select: USER_PROJECTION,
    });
  }

  /** Update, conditional on the version the caller last read. */
  async update(
    scope: AccessScope,
    args: { id: string; expectedVersion: number; changes: UpdateUserInput },
  ): Promise<UserRecord> {
    const changes: Prisma.UserUpdateManyMutationInput = { ...args.changes };
    if (args.changes.email !== undefined) {
      changes.email = args.changes.email.trim().toLowerCase();
    }

    await requireVersionedUpdate(
      this.db.user.updateMany({
        where: scope.where({ id: args.id, deletedAt: null, version: args.expectedVersion }),
        data: { ...changes, version: { increment: 1 } },
      }),
      'user account',
    );

    return this.requireById(scope, args.id);
  }

  /**
   * Change an account's status, conditional on version.
   *
   * Separate from `update` because a status change is not a field edit: it carries its
   * own permission, its own audit action, and — for a suspension — a session revocation
   * the caller performs alongside it.
   */
  async setStatus(
    scope: AccessScope,
    args: { id: string; expectedVersion: number; status: UserStatus },
  ): Promise<UserRecord> {
    await requireVersionedUpdate(
      this.db.user.updateMany({
        where: scope.where({ id: args.id, deletedAt: null, version: args.expectedVersion }),
        data: { status: args.status, version: { increment: 1 } },
      }),
      'user account',
    );

    return this.requireById(scope, args.id);
  }

  /**
   * Clear a brute-force lockout.
   *
   * Not version-conditional: it is idempotent, it removes a restriction rather than
   * overwriting anything an administrator might be editing concurrently, and being made
   * to reload the page to unlock a bursar who is standing at the desk waiting would be
   * an unhelpful kind of rigour.
   */
  async clearLockout(scope: AccessScope, id: string): Promise<UserRecord> {
    await this.db.user.updateMany({
      where: scope.where({ id, deletedAt: null }),
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    return this.requireById(scope, id);
  }

  /* ------------------------------------------------------------ role assignments */

  async findRoleByKey(
    key: string,
  ): Promise<{ id: string; key: string; rank: number; requiresMfa: boolean } | null> {
    return this.db.role.findUnique({
      where: { key },
      select: { id: true, key: true, rank: true, requiresMfa: true },
    });
  }

  async hasRole(userId: string, roleId: string): Promise<boolean> {
    const existing = await this.db.userRole.findFirst({
      where: { userId, roleId },
      select: { id: true },
    });
    return existing !== null;
  }

  async grantRole(args: {
    userId: string;
    roleId: string;
    schoolId: string | null;
    assignedByUserId: string;
  }): Promise<void> {
    await this.db.userRole.create({
      data: {
        userId: args.userId,
        roleId: args.roleId,
        schoolId: args.schoolId,
        assignedByUserId: args.assignedByUserId,
      },
    });
  }

  /** Returns false when the user did not hold the role, so the caller can 404. */
  async revokeRole(userId: string, roleId: string): Promise<boolean> {
    const result = await this.db.userRole.deleteMany({ where: { userId, roleId } });
    return result.count > 0;
  }

  /**
   * How many accounts hold a role, system-wide.
   *
   * Unscoped deliberately: it exists to answer "is this the last Super Administrator?",
   * and a scoped count would answer a different question and cheerfully allow the last
   * one to be removed.
   */
  async countHoldersOfRole(roleId: string): Promise<number> {
    return this.db.userRole.count({
      where: { roleId, user: { deletedAt: null, status: 'ACTIVE' } },
    });
  }

  private async requireById(scope: AccessScope, id: string): Promise<UserRecord> {
    const user = await this.findById(scope, id);
    if (user === null) {
      // Cannot normally happen: the write above just succeeded within this scope.
      throw new Error(`User ${id} disappeared immediately after a successful write`);
    }
    return user;
  }

  private buildWhere(scope: AccessScope, filters: UserListFilters): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = { ...scope.filter, deletedAt: null };

    if (filters.status !== undefined) where.status = filters.status;
    if (filters.roleKey !== undefined) {
      where.roleAssignments = { some: { role: { key: filters.roleKey } } };
    }

    if (filters.search !== undefined && filters.search.trim() !== '') {
      const term = filters.search.trim();
      where.OR = [
        { email: { contains: term, mode: 'insensitive' } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ];
    }

    return where;
  }
}

export const userRepository = new UserRepository();
