import { describe, expect, it } from 'vitest';

import {
  MFA_REQUIRED_ROLE_KEYS,
  PERMISSIONS,
  PermissionKey,
  ROLE_DEFINITIONS,
  RoleKey,
  getRoleDefinition,
  permissionsForRoles,
  rolesRequireMfa,
} from '../src/authorization.js';

describe('permission catalogue', () => {
  it('has no duplicate keys', () => {
    const keys = PERMISSIONS.map((permission) => permission.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('defines every key declared in PermissionKey', () => {
    // Catches the easy mistake of adding a key to the enum and forgetting the definition,
    // which would leave a permission that no role can ever be granted.
    const defined = new Set(PERMISSIONS.map((permission) => permission.key));
    for (const key of Object.values(PermissionKey)) {
      expect(defined.has(key), `missing definition for ${key}`).toBe(true);
    }
  });

  it('derives resource and action from the key', () => {
    const verify = PERMISSIONS.find((p) => p.key === PermissionKey.PAYMENT_VERIFY_MANUAL);
    expect(verify).toMatchObject({ resource: 'payment', action: 'verify_manual' });
  });

  it('marks the money-moving permissions sensitive', () => {
    const sensitive = new Set(
      PERMISSIONS.filter((permission) => permission.isSensitive).map((p) => p.key),
    );

    for (const key of [
      PermissionKey.PAYMENT_VERIFY_MANUAL,
      PermissionKey.PAYMENT_REVERSE,
      PermissionKey.PAYMENT_REFUND,
      PermissionKey.ADJUSTMENT_APPROVE,
      PermissionKey.CHARGE_VOID,
      PermissionKey.CLEARANCE_GRANT,
      PermissionKey.FEE_STRUCTURE_MANAGE,
      PermissionKey.PROMOTION_EXECUTE,
    ]) {
      expect(sensitive.has(key), `${key} should be sensitive`).toBe(true);
    }
  });

  it('does not mark plain reads sensitive', () => {
    const readPermission = PERMISSIONS.find((p) => p.key === PermissionKey.PAYMENT_READ);
    expect(readPermission?.isSensitive).toBe(false);
  });
});

describe('role catalogue', () => {
  it('defines every role declared in RoleKey, with no duplicates', () => {
    const keys = ROLE_DEFINITIONS.map((role) => role.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(Object.values(RoleKey)));
  });

  it('grants only permissions that exist in the catalogue', () => {
    const defined = new Set(PERMISSIONS.map((permission) => permission.key));
    for (const role of ROLE_DEFINITIONS) {
      for (const permission of role.permissions) {
        expect(defined.has(permission), `${role.key} grants unknown ${permission}`).toBe(true);
      }
    }
  });

  it('ranks roles so a lower role cannot out-rank a higher one', () => {
    const rank = (key: RoleKey): number => getRoleDefinition(key).rank;
    expect(rank(RoleKey.SUPER_ADMIN)).toBeGreaterThan(rank(RoleKey.SCHOOL_ADMIN));
    expect(rank(RoleKey.SCHOOL_ADMIN)).toBeGreaterThan(rank(RoleKey.FINANCE_MANAGER));
    expect(rank(RoleKey.FINANCE_MANAGER)).toBeGreaterThan(rank(RoleKey.BURSAR));
    expect(rank(RoleKey.BURSAR)).toBeGreaterThan(rank(RoleKey.DOS));
    expect(rank(RoleKey.DOS)).toBeGreaterThan(rank(RoleKey.PARENT));
    expect(rank(RoleKey.PARENT)).toBeGreaterThan(rank(RoleKey.STUDENT));
  });

  it('throws for an unknown role key', () => {
    // @ts-expect-error -- guarding the runtime path reached from stored data
    expect(() => getRoleDefinition('NOT_A_ROLE')).toThrow(/Unknown role key/);
  });
});

describe('separation of duties', () => {
  const permissionsOf = (key: RoleKey): Set<string> => new Set(getRoleDefinition(key).permissions);

  it('lets a bursar verify a manual payment but not approve an adjustment', () => {
    // The person handling daily cash must not also be able to write off what is owed.
    const bursar = permissionsOf(RoleKey.BURSAR);
    expect(bursar.has(PermissionKey.PAYMENT_VERIFY_MANUAL)).toBe(true);
    expect(bursar.has(PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM)).toBe(true);
    expect(bursar.has(PermissionKey.ADJUSTMENT_APPROVE)).toBe(false);
    expect(bursar.has(PermissionKey.PAYMENT_REVERSE)).toBe(false);
    expect(bursar.has(PermissionKey.PAYMENT_REFUND)).toBe(false);
  });

  it('gives the finance manager the approvals a bursar lacks', () => {
    const manager = permissionsOf(RoleKey.FINANCE_MANAGER);
    expect(manager.has(PermissionKey.ADJUSTMENT_APPROVE)).toBe(true);
    expect(manager.has(PermissionKey.PAYMENT_REVERSE)).toBe(true);
    expect(manager.has(PermissionKey.PAYMENT_REFUND)).toBe(true);
  });

  it('keeps the DOS out of payment and adjustment operations', () => {
    const dos = permissionsOf(RoleKey.DOS);
    expect(dos.has(PermissionKey.STUDENT_READ)).toBe(true);
    expect(dos.has(PermissionKey.CLEARANCE_READ)).toBe(true);
    expect(dos.has(PermissionKey.PAYMENT_READ)).toBe(false);
    expect(dos.has(PermissionKey.PAYMENT_VERIFY_MANUAL)).toBe(false);
    expect(dos.has(PermissionKey.ADJUSTMENT_APPROVE)).toBe(false);
    expect(dos.has(PermissionKey.CLEARANCE_GRANT)).toBe(false);
  });

  it('restricts parents and students to their own records', () => {
    for (const key of [RoleKey.PARENT, RoleKey.STUDENT]) {
      const permissions = permissionsOf(key);
      expect(permissions.has(PermissionKey.OWN_FINANCIALS_READ)).toBe(true);
      // Crucially, no school-wide read of other students' data.
      expect(permissions.has(PermissionKey.STUDENT_READ)).toBe(false);
      expect(permissions.has(PermissionKey.PAYMENT_READ)).toBe(false);
      expect(permissions.has(PermissionKey.REPORT_READ_FINANCIAL)).toBe(false);
      expect(permissions.has(PermissionKey.AUDIT_LOG_READ)).toBe(false);
    }
  });

  it('does not let a student initiate a payment, only a parent', () => {
    expect(permissionsOf(RoleKey.STUDENT).has(PermissionKey.OWN_PAYMENT_INITIATE)).toBe(false);
    expect(permissionsOf(RoleKey.PARENT).has(PermissionKey.OWN_PAYMENT_INITIATE)).toBe(true);
  });

  it('gives the super administrator every permission', () => {
    const superAdmin = permissionsOf(RoleKey.SUPER_ADMIN);
    expect(superAdmin.size).toBe(PERMISSIONS.length);
  });
});

describe('MFA requirements', () => {
  it('requires MFA for exactly the four financially sensitive roles (Section 6)', () => {
    expect(new Set(MFA_REQUIRED_ROLE_KEYS)).toEqual(
      new Set([RoleKey.SUPER_ADMIN, RoleKey.SCHOOL_ADMIN, RoleKey.FINANCE_MANAGER, RoleKey.BURSAR]),
    );
  });

  it('does not require MFA for DOS, parents or students', () => {
    expect(rolesRequireMfa([RoleKey.DOS])).toBe(false);
    expect(rolesRequireMfa([RoleKey.PARENT, RoleKey.STUDENT])).toBe(false);
  });

  it('requires MFA when any held role requires it', () => {
    // A DOS who is also a bursar must still complete the challenge.
    expect(rolesRequireMfa([RoleKey.DOS, RoleKey.BURSAR])).toBe(true);
    expect(rolesRequireMfa([])).toBe(false);
  });
});

describe('permissionsForRoles', () => {
  it('unions the permissions of several roles', () => {
    const combined = permissionsForRoles([RoleKey.BURSAR, RoleKey.DOS]);
    expect(combined.has(PermissionKey.PAYMENT_VERIFY_MANUAL)).toBe(true);
    expect(combined.has(PermissionKey.STUDENT_UPDATE)).toBe(true);
    // Still not an approval: neither role grants it.
    expect(combined.has(PermissionKey.ADJUSTMENT_APPROVE)).toBe(false);
  });

  it('returns an empty set for no roles', () => {
    expect(permissionsForRoles([]).size).toBe(0);
  });

  it('ignores an unknown role rather than throwing', () => {
    // Stored role data could name a role removed from the catalogue; the safe reading is
    // "grants nothing", not a crash on every request.
    const combined = permissionsForRoles(['GHOST_ROLE' as RoleKey, RoleKey.STUDENT]);
    expect(combined.has(PermissionKey.OWN_FINANCIALS_READ)).toBe(true);
    expect(combined.size).toBe(getRoleDefinition(RoleKey.STUDENT).permissions.length);
  });
});
