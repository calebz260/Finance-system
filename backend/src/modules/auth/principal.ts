/**
 * The authenticated caller, as the rest of the backend sees them.
 *
 * Loaded from the database on every authenticated request rather than read out of the
 * token. That costs one indexed query, and buys three things a token cannot:
 *
 *  - **Immediate revocation.** Suspending a bursar or revoking a role takes effect on
 *    their next request, not whenever their access token happens to expire. For a system
 *    where a role controls who can write off fees, fifteen minutes of stale authority is
 *    not acceptable.
 *  - **Authoritative grants.** Role permissions are editable at runtime through
 *    `role.manage`, so the database is the source of truth. A token minted before a
 *    change would carry the old answer.
 *  - **A smaller token.** Fifty-odd permission keys do not travel on every request.
 *
 * The shared catalogue in `@sfs/shared` remains the seeded default and the place the
 * intended matrix is reviewed; this is what is actually in force.
 */
import type { PermissionKey, RoleKey } from '@sfs/shared';

import type { UserStatus } from '../../generated/prisma/enums.js';
import { AccessScope } from '../../lib/access-scope.js';
import { prisma } from '../../lib/prisma.js';

export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly schoolId: string | null;
  readonly isSystemAdministrator: boolean;
  readonly status: UserStatus;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  /** Whether this session completed an MFA challenge. */
  readonly mfaSatisfied: boolean;
  readonly roleKeys: readonly RoleKey[];
  readonly permissions: ReadonlySet<string>;
  /** Highest rank among held roles. Used to stop a user granting a role above their own. */
  readonly highestRoleRank: number;
  /** Tenant scope for every query this request makes. */
  readonly scope: AccessScope;
}

export interface LoadedUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly schoolId: string | null;
  readonly isSystemAdministrator: boolean;
  readonly status: UserStatus;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  readonly roleKeys: readonly RoleKey[];
  readonly permissions: ReadonlySet<string>;
  readonly highestRoleRank: number;
}

/**
 * Load a user's identity and current grants.
 *
 * Returns null when the user does not exist or has been deleted, so callers treat "no
 * such user" and "deactivated user" through the same path.
 */
export async function loadUserWithGrants(userId: string): Promise<LoadedUser | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      schoolId: true,
      isSystemAdministrator: true,
      status: true,
      mustChangePassword: true,
      mfaEnabled: true,
      roleAssignments: {
        select: {
          role: {
            select: {
              key: true,
              rank: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });

  if (user === null) return null;

  const roleKeys: RoleKey[] = [];
  const permissions = new Set<string>();
  let highestRoleRank = 0;

  for (const assignment of user.roleAssignments) {
    roleKeys.push(assignment.role.key as RoleKey);
    highestRoleRank = Math.max(highestRoleRank, assignment.role.rank);
    for (const grant of assignment.role.permissions) {
      permissions.add(grant.permission.key);
    }
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    roleKeys,
    permissions,
    highestRoleRank,
  };
}

/**
 * Build the request principal from a loaded user and their session.
 *
 * The scope comes from the *user's* school, not from the token's claim: a token is
 * client-held, and deriving the tenant boundary from it would let a tampered — or merely
 * stale — claim widen access. A system administrator gets system scope; everyone else is
 * bound to their school.
 */
export function buildPrincipal(args: {
  user: LoadedUser;
  sessionId: string;
  mfaSatisfied: boolean;
}): Principal {
  const { user, sessionId, mfaSatisfied } = args;

  const scope =
    user.isSystemAdministrator && user.schoolId === null
      ? AccessScope.system()
      : AccessScope.forSchool(user.schoolId ?? '');

  return {
    userId: user.id,
    sessionId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    schoolId: user.schoolId,
    isSystemAdministrator: user.isSystemAdministrator,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    mfaSatisfied,
    roleKeys: user.roleKeys,
    permissions: user.permissions,
    highestRoleRank: user.highestRoleRank,
    scope,
  };
}

export function principalHasPermission(principal: Principal, permission: PermissionKey): boolean {
  return principal.permissions.has(permission);
}

export function principalHasRole(principal: Principal, role: RoleKey): boolean {
  return principal.roleKeys.includes(role);
}
