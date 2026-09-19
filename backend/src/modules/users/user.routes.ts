/**
 * `/api/v1/users` and `/api/v1/roles`.
 *
 * Every route here is behind `authenticate` *and* an explicit permission. The permission
 * named on each line is the one a reviewer should be able to check against the matrix in
 * `shared/src/authorization.ts` without reading the handler.
 *
 * Two deliberate choices:
 *
 *  - **`requireUsablePassword` is applied to the whole router.** An account that has not
 *    yet replaced its initial password can sign in and change it; it cannot administer
 *    other people's accounts in the meantime.
 *
 *  - **Role changes additionally require `requireMfaSatisfied`.** Granting a role is how
 *    privilege is escalated, so it must never be reachable from a session that only ever
 *    proved a password — even for a role whose own holders are not required to use MFA.
 */
import { Router } from 'express';

import { PermissionKey } from '@sfs/shared';

import { authenticate } from '../../middleware/authenticate.js';
import {
  requireMfaSatisfied,
  requirePermission,
  requireUsablePassword,
} from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  createUserHandler,
  getUserHandler,
  grantRoleHandler,
  listRolesHandler,
  listUsersHandler,
  revokeRoleHandler,
  setUserStatusHandler,
  unlockUserHandler,
  updateUserHandler,
} from './user.controller.js';
import {
  createUserSchema,
  grantRoleSchema,
  listUsersQuerySchema,
  setUserStatusSchema,
  updateUserSchema,
  userIdParamsSchema,
  userRoleParamsSchema,
} from './user.schema.js';

export function createUserRouter(): Router {
  const router = Router();

  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.USER_READ),
    validate({ query: listUsersQuerySchema }),
    listUsersHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.USER_CREATE),
    validate({ body: createUserSchema }),
    createUserHandler,
  );

  router.get(
    '/:userId',
    requirePermission(PermissionKey.USER_READ),
    validate({ params: userIdParamsSchema }),
    getUserHandler,
  );

  router.patch(
    '/:userId',
    requirePermission(PermissionKey.USER_UPDATE),
    validate({ params: userIdParamsSchema, body: updateUserSchema }),
    updateUserHandler,
  );

  // Suspension and reinstatement, not a field edit: separate permission, separate audit
  // action, and every session of the affected account ends.
  router.put(
    '/:userId/status',
    requirePermission(PermissionKey.USER_DEACTIVATE),
    validate({ params: userIdParamsSchema, body: setUserStatusSchema }),
    setUserStatusHandler,
  );

  // Unlocking restores access after failed sign-ins. `user.update` rather than
  // `user.deactivate`: it is the everyday helpdesk action, not a change of standing.
  router.post(
    '/:userId/unlock',
    requirePermission(PermissionKey.USER_UPDATE),
    validate({ params: userIdParamsSchema }),
    unlockUserHandler,
  );

  router.post(
    '/:userId/roles',
    requirePermission(PermissionKey.USER_ASSIGN_ROLE),
    requireMfaSatisfied(),
    validate({ params: userIdParamsSchema, body: grantRoleSchema }),
    grantRoleHandler,
  );

  router.delete(
    '/:userId/roles/:roleKey',
    requirePermission(PermissionKey.USER_ASSIGN_ROLE),
    requireMfaSatisfied(),
    validate({ params: userRoleParamsSchema }),
    revokeRoleHandler,
  );

  return router;
}

/** The role catalogue. Read-only in Phase 2; see `listRolesHandler`. */
export function createRoleRouter(): Router {
  const router = Router();

  router.use(authenticate, requireUsablePassword());
  router.get('/', requirePermission(PermissionKey.ROLE_READ), listRolesHandler);

  return router;
}
