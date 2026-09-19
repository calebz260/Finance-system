/**
 * Account administration.
 *
 * The screen is shaped by what an administrator actually does on a Monday morning:
 * unlock the bursar who mistyped their password five times, suspend an account for
 * someone who has left, and create one for someone who has arrived. Those three are
 * one click each; everything rarer costs a little more.
 *
 * Two things it shows that a plainer user list would not, because they are the
 * security state an administrator has to act on: whether an account is locked, and
 * whether it has enrolled a second factor.
 *
 * Buttons are hidden from callers who lack the permission, and that is a courtesy
 * only. Every action is enforced on the server, which re-reads permissions from the
 * database on every request.
 */
import { useState } from 'react';

import { PermissionKey, type RoleKey, type UserAccount } from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import { formatDateTime } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as usersApi from '../lib/users-api';

interface CreatedCredential {
  readonly email: string;
  readonly temporaryPassword: string;
}

export function UsersPage(): React.JSX.Element {
  const { can, user: currentUser } = useAuth();

  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [actionError, setActionError] = useState<FormErrorState | null>(null);
  const [created, setCreated] = useState<CreatedCredential | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const users = useAsyncResource(
    () => usersApi.listUsers({ search: appliedSearch, pageSize: 50 }),
    [appliedSearch],
  );
  const roles = useAsyncResource(() => usersApi.listRoles(), []);

  const mayAssignRoles = can(PermissionKey.USER_ASSIGN_ROLE);
  const mayDeactivate = can(PermissionKey.USER_DEACTIVATE);
  const mayUpdate = can(PermissionKey.USER_UPDATE);
  const mayCreate = can(PermissionKey.USER_CREATE);

  /** Run an action, surface any refusal, and reload the list either way. */
  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(toFormError(cause));
    } finally {
      users.refresh();
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="User accounts"
          description="Staff, parent and student accounts for your school."
          actions={
            mayCreate ? (
              <Button
                size="sm"
                onClick={() => {
                  setShowCreateForm((open) => !open);
                  setCreated(null);
                }}
              >
                {showCreateForm ? 'Cancel' : 'Add an account'}
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          {actionError !== null ? (
            <Alert
              variant="error"
              className="mb-4"
              {...(actionError.requestId !== undefined ? { requestId: actionError.requestId } : {})}
            >
              {actionError.message}
            </Alert>
          ) : null}

          {created !== null ? (
            <Alert variant="success" className="mb-4" title="Account created">
              Give this temporary password to {created.email} in person. It is shown once and cannot
              be retrieved again, and they will be asked to replace it when they first sign in.
              <p className="mt-2 font-mono text-sm break-all">{created.temporaryPassword}</p>
            </Alert>
          ) : null}

          {showCreateForm ? (
            <CreateUserForm
              roleKeys={(roles.data ?? []).map((role) => role.key)}
              onCreated={(result) => {
                setShowCreateForm(false);
                if (result.temporaryPassword !== undefined) {
                  setCreated({
                    email: result.user.email,
                    temporaryPassword: result.temporaryPassword,
                  });
                }
                users.refresh();
              }}
              onError={(formError) => {
                setActionError(formError);
              }}
            />
          ) : null}

          <form
            className="mb-4 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(search);
            }}
          >
            <div className="flex-1">
              <TextField
                label="Search"
                name="search"
                placeholder="Name or email address"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>

          <DataState
            status={users.status}
            data={users.data}
            error={users.error}
            onRetry={users.refresh}
            loadingLabel="Loading accounts"
            emptyTitle="No accounts match"
            emptyDescription="Try a different name or email address."
            isEmpty={(page) => page.data.length === 0}
          >
            {(page) => (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {page.data.map((account) => (
                  <UserRow
                    key={account.id}
                    account={account}
                    isSelf={account.id === currentUser?.id}
                    roleKeys={(roles.data ?? []).map((role) => role.key)}
                    mayAssignRoles={mayAssignRoles}
                    mayDeactivate={mayDeactivate}
                    mayUpdate={mayUpdate}
                    onAction={perform}
                  />
                ))}
              </ul>
            )}
          </DataState>
        </CardBody>
      </Card>
    </div>
  );
}

interface UserRowProps {
  readonly account: UserAccount;
  readonly isSelf: boolean;
  readonly roleKeys: readonly RoleKey[];
  readonly mayAssignRoles: boolean;
  readonly mayDeactivate: boolean;
  readonly mayUpdate: boolean;
  readonly onAction: (action: () => Promise<unknown>) => Promise<void>;
}

function UserRow({
  account,
  isSelf,
  roleKeys,
  mayAssignRoles,
  mayDeactivate,
  mayUpdate,
  onAction,
}: UserRowProps): React.JSX.Element {
  const [roleToGrant, setRoleToGrant] = useState<RoleKey | ''>('');

  const suspended = account.status === 'SUSPENDED' || account.status === 'DISABLED';

  return (
    <li className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {account.firstName} {account.lastName}
          {isSelf ? (
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">(you)</span>
          ) : null}
        </p>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{account.email}</p>

        <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
          <Badge tone={account.status === 'ACTIVE' ? 'ok' : 'muted'}>{account.status}</Badge>
          {account.locked ? <Badge tone="warn">Locked</Badge> : null}
          {account.mustChangePassword ? <Badge tone="muted">Must change password</Badge> : null}
          <Badge tone={account.mfaEnabled ? 'ok' : 'muted'}>
            {account.mfaEnabled ? 'Two-factor on' : 'Two-factor off'}
          </Badge>
          {account.roles.map((role) => (
            <span
              key={role.roleKey}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              {role.roleName}
              {mayAssignRoles && !isSelf ? (
                <button
                  type="button"
                  aria-label={`Remove the ${role.roleName} role from ${account.email}`}
                  className="ml-1 text-slate-500 hover:text-red-600"
                  onClick={() => {
                    void onAction(() => usersApi.revokeRole(account.id, role.roleKey));
                  }}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>

        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {account.lastLoginAt === null
            ? 'Never signed in'
            : `Last signed in ${formatDateTime(account.lastLoginAt)}`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {account.locked && mayUpdate ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void onAction(() => usersApi.unlockUser(account.id));
            }}
          >
            Unlock
          </Button>
        ) : null}

        {mayAssignRoles && !isSelf ? (
          <div className="flex items-center gap-1">
            <label className="sr-only" htmlFor={`grant-${account.id}`}>
              Role to grant to {account.email}
            </label>
            <select
              id={`grant-${account.id}`}
              className="h-8 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={roleToGrant}
              onChange={(event) => {
                setRoleToGrant(event.target.value as RoleKey | '');
              }}
            >
              <option value="">Add role…</option>
              {roleKeys
                .filter((key) => !account.roles.some((role) => role.roleKey === key))
                .map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={roleToGrant === ''}
              onClick={() => {
                if (roleToGrant === '') return;
                void onAction(() => usersApi.grantRole(account.id, roleToGrant));
                setRoleToGrant('');
              }}
            >
              Grant
            </Button>
          </div>
        ) : null}

        {mayDeactivate && !isSelf ? (
          <Button
            size="sm"
            variant={suspended ? 'secondary' : 'danger'}
            onClick={() => {
              void onAction(() =>
                usersApi.setUserStatus(account.id, {
                  expectedVersion: account.version,
                  status: suspended ? 'ACTIVE' : 'SUSPENDED',
                  ...(suspended ? {} : { reason: 'Suspended by an administrator' }),
                }),
              );
            }}
          >
            {suspended ? 'Reinstate' : 'Suspend'}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Badge({
  tone,
  children,
}: {
  readonly tone: 'ok' | 'warn' | 'muted';
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const tones = {
    ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
    muted: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  } as const;

  return <span className={`rounded px-1.5 py-0.5 ${tones[tone]}`}>{children}</span>;
}

interface CreateUserFormProps {
  readonly roleKeys: readonly RoleKey[];
  readonly onCreated: (result: { user: UserAccount; temporaryPassword?: string }) => void;
  readonly onError: (error: FormErrorState) => void;
}

/**
 * Create an account.
 *
 * No password field: the server generates a temporary one and returns it once, which
 * keeps "who has seen this credential" a short and answerable list.
 */
function CreateUserForm({ roleKeys, onCreated, onError }: CreateUserFormProps): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [roleKey, setRoleKey] = useState<RoleKey | ''>('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mb-6 grid gap-4 rounded-md border border-slate-200 p-4 sm:grid-cols-2 dark:border-slate-800"
      onSubmit={(event) => {
        event.preventDefault();
        if (roleKey === '') return;

        setBusy(true);
        void usersApi
          .createUser({ email, firstName, lastName, roleKeys: [roleKey] })
          .then((result) => {
            onCreated(result);
            setEmail('');
            setFirstName('');
            setLastName('');
            setRoleKey('');
          })
          .catch((cause: unknown) => {
            onError(toFormError(cause));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <TextField
        label="First name"
        name="firstName"
        required
        value={firstName}
        onChange={(event) => {
          setFirstName(event.target.value);
        }}
      />
      <TextField
        label="Last name"
        name="lastName"
        required
        value={lastName}
        onChange={(event) => {
          setLastName(event.target.value);
        }}
      />
      <TextField
        label="Email address"
        type="email"
        name="email"
        required
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="new-user-role"
          className="text-sm font-medium text-slate-800 dark:text-slate-200"
        >
          Role
        </label>
        <select
          id="new-user-role"
          required
          className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          value={roleKey}
          onChange={(event) => {
            setRoleKey(event.target.value as RoleKey | '');
          }}
        >
          <option value="">Choose a role…</option>
          {roleKeys.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-2">
        <Button type="submit" isLoading={busy} loadingLabel="Creating">
          Create account
        </Button>
      </div>
    </form>
  );
}
