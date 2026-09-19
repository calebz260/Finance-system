/**
 * The authorisation middleware.
 *
 * Every decision is made from the principal the server loaded, never from anything the
 * client sent — these tests exist to keep that true, and to keep the denial path
 * audited. The audit writer is stubbed so this stays a unit test: what is asserted is
 * that a denial *is* recorded, not what the row looks like in PostgreSQL.
 */
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode, PermissionKey, RoleKey } from '@sfs/shared';

/**
 * Typed so the recorded calls can be read back. An untyped `vi.fn()` records its calls as
 * `[]`, and what these tests assert is precisely what the denial path wrote.
 */
interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly result: string;
  readonly metadata: Record<string, unknown>;
}

const recordSafely = vi.fn((_entry: AuditEntry): Promise<void> => Promise.resolve());

vi.mock('../../src/modules/audit/audit.service.js', () => ({
  record: vi.fn(() => Promise.resolve()),
  recordSafely,
}));

const { AccessScope } = await import('../../src/lib/access-scope.js');
const { AppError } = await import('../../src/lib/errors.js');
const {
  requireAnyPermission,
  requireMfaSatisfied,
  requirePermission,
  requireRole,
  requireUsablePassword,
} = await import('../../src/middleware/authorize.js');
const { requirePrincipal } = await import('../../src/middleware/authenticate.js');

type Principal = NonNullable<Request['principal']>;

function principalWith(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    email: 'bursar@gskicukiro.invalid',
    firstName: 'Bursar',
    lastName: 'One',
    schoolId: 'school-1',
    isSystemAdministrator: false,
    status: 'ACTIVE',
    mustChangePassword: false,
    mfaEnabled: true,
    mfaSatisfied: true,
    roleKeys: [RoleKey.BURSAR],
    permissions: new Set<string>([PermissionKey.PAYMENT_READ, PermissionKey.STUDENT_READ]),
    highestRoleRank: 60,
    scope: AccessScope.forSchool('school-1'),
    ...overrides,
  };
}

function requestWith(principal: Principal | undefined): Request {
  return {
    method: 'POST',
    path: '/api/v1/payments/reverse',
    principal,
  } as unknown as Request;
}

/** Runs a middleware and reports how it finished. */
async function run(
  middleware: ReturnType<typeof requirePermission>,
  principal: Principal | undefined,
): Promise<{ allowed: boolean; error?: unknown }> {
  const req = requestWith(principal);
  let outcome: { allowed: boolean; error?: unknown } | undefined;

  const next: NextFunction = (error?: unknown) => {
    outcome = error === undefined ? { allowed: true } : { allowed: false, error };
  };

  middleware(req, {} as Response, next);

  // The denial path awaits the audit write before calling next.
  await vi.waitFor(() => {
    expect(outcome).toBeDefined();
  });

  return outcome as { allowed: boolean; error?: unknown };
}

function assertDenied(result: { allowed: boolean; error?: unknown }, code: ErrorCode): void {
  expect(result.allowed).toBe(false);
  expect(result.error).toBeInstanceOf(AppError);
  const error = result.error as InstanceType<typeof AppError>;
  expect(error.httpStatus).toBe(403);
  expect(error.code).toBe(code);
}

beforeEach(() => {
  recordSafely.mockClear();
});

describe('requirePermission', () => {
  it('admits a caller holding every listed permission', async () => {
    const result = await run(
      requirePermission(PermissionKey.PAYMENT_READ, PermissionKey.STUDENT_READ),
      principalWith(),
    );

    expect(result.allowed).toBe(true);
    expect(recordSafely).not.toHaveBeenCalled();
  });

  it('refuses a caller holding only some of them', async () => {
    // All-of is the safe reading: a route needing both `payment.read` and
    // `payment.verify_manual` must not admit someone holding one.
    const result = await run(
      requirePermission(PermissionKey.PAYMENT_READ, PermissionKey.PAYMENT_VERIFY_MANUAL),
      principalWith(),
    );

    assertDenied(result, ErrorCode.INSUFFICIENT_PERMISSION);
  });

  it('records the denial, so a pattern of probing is visible', async () => {
    await run(requirePermission(PermissionKey.PAYMENT_REVERSE), principalWith());

    expect(recordSafely).toHaveBeenCalledTimes(1);
    const entry = recordSafely.mock.calls[0]?.[0];
    expect(entry?.action).toBe('auth.access_denied');
    expect(entry?.result).toBe('FAILURE');
    expect(entry?.entityId).toBe('POST /api/v1/payments/reverse');
  });

  it('never reveals which permission was missing to the caller', async () => {
    // The requirement is in the logs, where it helps an administrator; in the response
    // it would tell an attacker exactly what to go after.
    const result = await run(requirePermission(PermissionKey.PAYMENT_REVERSE), principalWith());
    const error = result.error as InstanceType<typeof AppError>;

    expect(error.message).toBe('You do not have permission to perform this action.');
    expect(error.message).not.toContain('payment.reverse');
    expect(error.fieldErrors).toBeUndefined();
    expect(error.details).toBeUndefined();
  });

  it('refuses to be constructed with no permission, which would admit everyone', () => {
    expect(() => requirePermission()).toThrow(/at least one permission/);
  });
});

describe('requireAnyPermission', () => {
  it('admits a caller holding one of the listed permissions', async () => {
    const result = await run(
      requireAnyPermission(PermissionKey.PAYMENT_READ, PermissionKey.OWN_FINANCIALS_READ),
      principalWith(),
    );

    expect(result.allowed).toBe(true);
  });

  it('refuses a caller holding none of them', async () => {
    const result = await run(
      requireAnyPermission(PermissionKey.PAYMENT_REFUND, PermissionKey.PAYMENT_REVERSE),
      principalWith(),
    );

    assertDenied(result, ErrorCode.INSUFFICIENT_PERMISSION);
  });
});

describe('requireRole', () => {
  it('admits a caller holding one of the listed roles', async () => {
    const result = await run(requireRole(RoleKey.BURSAR, RoleKey.FINANCE_MANAGER), principalWith());
    expect(result.allowed).toBe(true);
  });

  it('refuses a caller who does not, whatever permissions they hold', async () => {
    const result = await run(
      requireRole(RoleKey.SUPER_ADMIN),
      principalWith({ permissions: new Set(Object.values(PermissionKey)) }),
    );

    assertDenied(result, ErrorCode.INSUFFICIENT_PERMISSION);
  });
});

describe('requireMfaSatisfied', () => {
  it('admits a session that completed a second factor', async () => {
    const result = await run(requireMfaSatisfied(), principalWith({ mfaSatisfied: true }));
    expect(result.allowed).toBe(true);
  });

  it('refuses a session that never proved one, even for a permitted caller', async () => {
    // The stronger case: an operation that must not happen on a single factor no matter
    // who asks -- a reversal, a refund, a change to a role's permissions.
    const result = await run(requireMfaSatisfied(), principalWith({ mfaSatisfied: false }));

    assertDenied(result, ErrorCode.INSUFFICIENT_PERMISSION);
    expect(recordSafely).toHaveBeenCalledTimes(1);
  });
});

describe('requireUsablePassword', () => {
  it('admits a caller whose password does not need changing', async () => {
    const result = await run(requireUsablePassword(), principalWith());
    expect(result.allowed).toBe(true);
  });

  it('refuses a caller who must change their password first', async () => {
    // Without this, an administrator-created account could be used indefinitely on the
    // initial password that two people have already seen.
    const result = await run(requireUsablePassword(), principalWith({ mustChangePassword: true }));

    assertDenied(result, ErrorCode.PASSWORD_CHANGE_REQUIRED);
  });
});

describe('requirePrincipal', () => {
  it('throws immediately when a route forgot the authenticate middleware', () => {
    // A wiring bug must surface as an error, not as an unauthenticated request that
    // quietly proceeds with `undefined` where the caller should be.
    expect(() => requirePrincipal(requestWith(undefined))).toThrow(/wiring bug/);
  });

  it('returns the principal when one is present', () => {
    const principal = principalWith();
    expect(requirePrincipal(requestWith(principal))).toBe(principal);
  });
});
