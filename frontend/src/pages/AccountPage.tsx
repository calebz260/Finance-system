/**
 * Your account: who you are signed in as, where else you are signed in, and your
 * second factor.
 *
 * The session list exists because "am I still signed in on the school computer?" is a
 * question a bursar should be able to answer themselves, and because an unexpected
 * entry in that list is how a user discovers a compromise before anyone else does.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import type { SessionSummary } from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { MfaEnrolment } from '../components/auth/MfaEnrolment';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { useAsyncResource } from '../hooks/use-async-resource';
import * as authApi from '../lib/auth-api';
import { formatDateTime } from '../lib/format';
import { toFormError } from '../lib/form-errors';

export function AccountPage(): React.JSX.Element {
  const { user, signOut, reload } = useAuth();
  const [enrolling, setEnrolling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const sessions = useAsyncResource<readonly SessionSummary[]>(() => authApi.listSessions(), []);

  const revoke = async (sessionId: string): Promise<void> => {
    setActionError(null);
    try {
      await authApi.revokeSession(sessionId);
      sessions.refresh();
    } catch (cause) {
      setActionError(toFormError(cause).message);
    }
  };

  const signOutEverywhere = async (): Promise<void> => {
    setActionError(null);
    try {
      await authApi.logoutEverywhere();
    } catch (cause) {
      setActionError(toFormError(cause).message);
      return;
    }
    // Includes this device, so the local session goes too.
    await signOut();
  };

  if (user === null) return <></>;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Your account" />
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Name</dt>
              <dd className="text-sm text-slate-900 dark:text-slate-100">
                {user.firstName} {user.lastName}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Email</dt>
              <dd className="text-sm text-slate-900 dark:text-slate-100">{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Roles</dt>
              <dd className="text-sm text-slate-900 dark:text-slate-100">
                {user.roleKeys.length > 0 ? user.roleKeys.join(', ') : 'None assigned'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                Two-factor authentication
              </dt>
              <dd className="text-sm text-slate-900 dark:text-slate-100">
                {user.mfaEnabled ? 'On' : 'Off'}
              </dd>
            </div>
          </dl>
        </CardBody>
        <CardFooter>
          <Link
            to="/account/password"
            className="text-sm text-brand-700 underline dark:text-brand-300"
          >
            Change your password
          </Link>
        </CardFooter>
      </Card>

      {!user.mfaEnabled ? (
        <Card>
          <CardHeader
            title="Two-factor authentication"
            description="A second factor means a stolen password is not enough to reach your account."
          />
          <CardBody>
            {enrolling ? (
              <MfaEnrolment
                onComplete={({ reauthenticationRequired }) => {
                  setEnrolling(false);
                  // Enabling MFA ends every session, including this one, because a
                  // session that never proved a second factor cannot be upgraded.
                  if (reauthenticationRequired) void signOut();
                  else void reload();
                }}
              />
            ) : (
              <Button
                onClick={() => {
                  setEnrolling(true);
                }}
              >
                Set up two-factor authentication
              </Button>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Where you are signed in"
          description="Sign out anything you do not recognise, then change your password."
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void signOutEverywhere();
              }}
            >
              Sign out everywhere
            </Button>
          }
        />
        <CardBody>
          {actionError !== null ? (
            <Alert variant="error" className="mb-4">
              {actionError}
            </Alert>
          ) : null}

          <DataState
            status={sessions.status}
            data={sessions.data}
            error={sessions.error}
            onRetry={sessions.refresh}
            loadingLabel="Loading your sessions"
            emptyTitle="No other sessions"
            isEmpty={(items) => items.length === 0}
          >
            {(items) => (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-900 dark:text-slate-100">
                        {item.userAgent ?? 'Unknown device'}
                        {item.current ? (
                          <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-200">
                            This device
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {item.ipAddress ?? 'Unknown address'} · last active{' '}
                        {formatDateTime(item.lastSeenAt)}
                        {item.mfaSatisfied ? ' · two-factor verified' : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void revoke(item.id);
                      }}
                    >
                      Sign out
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </CardBody>
      </Card>
    </div>
  );
}
