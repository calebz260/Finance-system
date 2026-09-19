/**
 * Authorisation middleware (Section 26).
 *
 * Authorisation is decided here, on the backend, from permissions loaded out of the
 * database for this request. Nothing the client sends contributes to the decision — not a
 * role name in a header, not a flag in the token, not a hidden form field. The web client
 * uses the same permission list only to decide what to render.
 *
 * Denials are audited. A single 403 is usually a misconfigured account; a pattern of them
 * is someone probing, and that distinction only exists if the attempts are recorded.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ErrorCode, type PermissionKey, type RoleKey } from '@sfs/shared';

import { ForbiddenError } from '../lib/errors.js';
import { AuditAction } from '../modules/audit/audit.actions.js';
import { recordSafely } from '../modules/audit/audit.service.js';
import { requirePrincipal } from './authenticate.js';

async function denyAndAudit(
  req: Request,
  next: NextFunction,
  args: { required: readonly string[]; mode: 'all' | 'any' | 'role' | 'mfa'; message: string },
): Promise<void> {
  const principal = req.principal;

  await recordSafely({
    action: AuditAction.ACCESS_DENIED,
    entityType: 'Route',
    entityId: `${req.method} ${req.path}`,
    result: 'FAILURE',
    reason: args.message,
    metadata: {
      mode: args.mode,
      required: [...args.required],
      heldRoles: principal === undefined ? [] : [...principal.roleKeys],
    },
  });

  next(
    new ForbiddenError(
      'You do not have permission to perform this action.',
      ErrorCode.INSUFFICIENT_PERMISSION,
      {
        logContext: {
          userId: principal?.userId,
          required: [...args.required],
          mode: args.mode,
          route: `${req.method} ${req.path}`,
        },
      },
    ),
  );
}

/**
 * Require every listed permission.
 *
 * All-of is the default because it is the safe reading: a route that needs both
 * `payment.read` and `payment.verify_manual` must not admit someone holding only one.
 */
export function requirePermission(...permissions: PermissionKey[]): RequestHandler {
  if (permissions.length === 0) {
    throw new Error('requirePermission() needs at least one permission');
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = requirePrincipal(req);
    const missing = permissions.filter((permission) => !principal.permissions.has(permission));

    if (missing.length > 0) {
      void denyAndAudit(req, next, {
        required: missing,
        mode: 'all',
        message: `Missing permission(s): ${missing.join(', ')}`,
      });
      return;
    }
    next();
  };
}

/**
 * Require at least one of the listed permissions.
 *
 * For routes reachable two ways — a bursar reading any student's balance via
 * `payment.read`, a parent reading their own child's via `own.financials_read`. The route
 * then still has to check *which* records the caller may see; this only gets them through
 * the door.
 */
export function requireAnyPermission(...permissions: PermissionKey[]): RequestHandler {
  if (permissions.length === 0) {
    throw new Error('requireAnyPermission() needs at least one permission');
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = requirePrincipal(req);
    const held = permissions.some((permission) => principal.permissions.has(permission));

    if (!held) {
      void denyAndAudit(req, next, {
        required: permissions,
        mode: 'any',
        message: `None of the required permissions held: ${permissions.join(', ')}`,
      });
      return;
    }
    next();
  };
}

/**
 * Require one of the listed roles.
 *
 * Prefer `requirePermission`: a permission says what a route needs, whereas a role says
 * who happens to have it today, and role checks are what make a permission matrix
 * impossible to change later. Kept for the few genuinely role-shaped rules, such as
 * actions only a Super Administrator may take.
 */
export function requireRole(...roles: RoleKey[]): RequestHandler {
  if (roles.length === 0) throw new Error('requireRole() needs at least one role');

  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = requirePrincipal(req);
    const held = roles.some((role) => principal.roleKeys.includes(role));

    if (!held) {
      void denyAndAudit(req, next, {
        required: roles,
        mode: 'role',
        message: `None of the required roles held: ${roles.join(', ')}`,
      });
      return;
    }
    next();
  };
}

/**
 * Require that this session completed an MFA challenge.
 *
 * `authenticate` already enforces MFA for roles that require it. This is for the stronger
 * case: an operation that must never happen on a single factor regardless of who asks —
 * a payment reversal, a refund, a change to a role's permissions.
 */
export function requireMfaSatisfied(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = requirePrincipal(req);

    if (!principal.mfaSatisfied) {
      void denyAndAudit(req, next, {
        required: ['mfa'],
        mode: 'mfa',
        message: 'This action requires two-factor authentication.',
      });
      return;
    }
    next();
  };
}

/**
 * Block a user whose password must be changed from doing anything except changing it.
 *
 * Applied to ordinary routes, not to the password-change endpoint itself. Without it, an
 * administrator-created or seeded account could be used indefinitely on its initial
 * password.
 */
export function requireUsablePassword(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = requirePrincipal(req);

    if (principal.mustChangePassword) {
      next(
        new ForbiddenError(
          'You must change your password before continuing.',
          ErrorCode.PASSWORD_CHANGE_REQUIRED,
          { logContext: { userId: principal.userId } },
        ),
      );
      return;
    }
    next();
  };
}
