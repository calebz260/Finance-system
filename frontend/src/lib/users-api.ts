/**
 * Typed calls to the account-administration endpoints.
 *
 * `expectedVersion` travels on every mutation. It is the optimistic-locking token: if
 * two administrators open the same account and both save, the second is told to reload
 * rather than silently overwriting the first.
 */
import type {
  CreatedUserAccount,
  PaginatedResponse,
  RoleCatalogueEntry,
  RoleKey,
  UserAccount,
  UserAccountStatus,
} from '@sfs/shared';

import { api, requestPaginated } from './api-client';

export interface UserListQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly status?: UserAccountStatus;
  readonly roleKey?: RoleKey;
}

export function listUsers(query: UserListQuery = {}): Promise<PaginatedResponse<UserAccount>> {
  return requestPaginated<UserAccount>('/api/v1/users', { query: { ...query } });
}

export function getUser(userId: string): Promise<UserAccount> {
  return api.get<UserAccount>(`/api/v1/users/${userId}`);
}

export function createUser(body: {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  roleKeys: readonly RoleKey[];
}): Promise<CreatedUserAccount> {
  return api.post<CreatedUserAccount>('/api/v1/users', body);
}

export function updateUser(
  userId: string,
  body: {
    expectedVersion: number;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
    email?: string;
  },
): Promise<UserAccount> {
  return api.patch<UserAccount>(`/api/v1/users/${userId}`, body);
}

export function setUserStatus(
  userId: string,
  body: { expectedVersion: number; status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED'; reason?: string },
): Promise<UserAccount> {
  return api.put<UserAccount>(`/api/v1/users/${userId}/status`, body);
}

export function unlockUser(userId: string): Promise<UserAccount> {
  return api.post<UserAccount>(`/api/v1/users/${userId}/unlock`);
}

export function grantRole(userId: string, roleKey: RoleKey): Promise<UserAccount> {
  return api.post<UserAccount>(`/api/v1/users/${userId}/roles`, { roleKey });
}

export function revokeRole(userId: string, roleKey: RoleKey): Promise<UserAccount> {
  return api.delete<UserAccount>(`/api/v1/users/${userId}/roles/${roleKey}`);
}

export function listRoles(): Promise<readonly RoleCatalogueEntry[]> {
  return api.get<readonly RoleCatalogueEntry[]>('/api/v1/roles');
}
