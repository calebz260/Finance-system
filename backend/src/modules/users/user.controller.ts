/**
 * Account administration endpoints.
 *
 * Thin by the same rule as every other controller: it reads the validated request, calls
 * the service and shapes the response. Every authorisation decision — which accounts the
 * caller may see, which roles they may grant, whether they outrank the target — is made
 * in the service and the middleware, never here.
 */
import type { Request, Response } from 'express';

import type { CreatedUserAccount, RoleCatalogueEntry, UserAccount } from '@sfs/shared';

import {
  HttpStatus,
  resolvePagination,
  sendCreated,
  sendPaginated,
  sendSuccess,
} from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import type {
  CreateUserBody,
  ListUsersQuery,
  SetUserStatusBody,
  UpdateUserBody,
  UserIdParams,
  UserRoleParams,
} from './user.schema.js';
import {
  createUser,
  getUser,
  grantRole,
  listRoles,
  listUsers,
  revokeRole,
  setUserStatus,
  unlockUser,
  updateUser,
} from './user.service.js';

/** `GET /users` — paginated and scoped to the caller's school. */
export const listUsersHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { query } = validated<{ query: ListUsersQuery }>(req);

  const pagination = resolvePagination({ page: query.page, pageSize: query.pageSize });
  const result = await listUsers(
    principal,
    { search: query.search, status: query.status, roleKey: query.roleKey },
    pagination,
  );

  sendPaginated(res, {
    items: result.items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: result.totalItems,
  });
};

/** `GET /users/:userId` */
export const getUserHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: UserIdParams }>(req);

  sendSuccess(res, (await getUser(principal, params.userId)) satisfies UserAccount);
};

/**
 * `POST /users`
 *
 * `201` with the account and, when the server generated it, the temporary password —
 * returned exactly once, because only its hash is stored.
 */
export const createUserHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: CreateUserBody }>(req);

  const created = await createUser(principal, {
    email: body.email,
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    password: body.password,
    roleKeys: body.roleKeys,
    schoolId: body.schoolId,
  });

  sendCreated(res, created satisfies CreatedUserAccount, `/api/v1/users/${created.user.id}`);
};

/** `PATCH /users/:userId` — contact details only; status and roles have their own routes. */
export const updateUserHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: UserIdParams; body: UpdateUserBody }>(req);

  const updated = await updateUser(principal, {
    userId: params.userId,
    expectedVersion: body.expectedVersion,
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    email: body.email,
  });

  sendSuccess(res, updated satisfies UserAccount);
};

/** `PUT /users/:userId/status` — suspend, disable or restore. Ends sessions on the way out. */
export const setUserStatusHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{ params: UserIdParams; body: SetUserStatusBody }>(req);

  const updated = await setUserStatus(principal, {
    userId: params.userId,
    expectedVersion: body.expectedVersion,
    status: body.status,
    reason: body.reason,
  });

  sendSuccess(res, updated satisfies UserAccount);
};

/** `POST /users/:userId/unlock` — clear a brute-force lockout. */
export const unlockUserHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: UserIdParams }>(req);

  sendSuccess(res, (await unlockUser(principal, params.userId)) satisfies UserAccount);
};

/** `POST /users/:userId/roles` */
export const grantRoleHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params, body } = validated<{
    params: UserIdParams;
    body: { roleKey: UserRoleParams['roleKey'] };
  }>(req);

  const updated = await grantRole(principal, {
    userId: params.userId,
    roleKey: body.roleKey,
  });

  sendSuccess(res, updated satisfies UserAccount, { status: HttpStatus.OK });
};

/** `DELETE /users/:userId/roles/:roleKey` */
export const revokeRoleHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { params } = validated<{ params: UserRoleParams }>(req);

  const updated = await revokeRole(principal, {
    userId: params.userId,
    roleKey: params.roleKey,
  });

  sendSuccess(res, updated satisfies UserAccount);
};

/**
 * `GET /roles` — the catalogue, with the permissions each role carries.
 *
 * Read-only in Phase 2. `role.manage` exists in the catalogue but has no endpoint yet;
 * editing what a role may do changes the authorisation matrix for everyone holding it,
 * and that deserves its own design rather than being appended here.
 */
export const listRolesHandler = (_req: Request, res: Response): void => {
  sendSuccess(res, listRoles() satisfies readonly RoleCatalogueEntry[]);
};
