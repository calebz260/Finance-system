/**
 * Change your own password.
 *
 * Reached two ways: voluntarily from the account screen, and compulsorily by an
 * account still on the password an administrator issued. In the second case the route
 * guard sends the user here and will keep doing so until it is changed — which matches
 * the server, where `requireUsablePassword` refuses everything else.
 *
 * The current password is required even though the user is signed in. A hijacked
 * session must not be enough to lock the real owner out of their own account.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import * as authApi from '../lib/auth-api';
import { toFormError, type FormErrorState } from '../lib/form-errors';

const MIN_PASSWORD_LENGTH = 12;

export function ChangePasswordPage(): React.JSX.Element {
  const { user, reload } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);

  const forced = user?.mustChangePassword ?? false;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    if (newPassword !== confirmation) {
      setMismatch('The two passwords do not match.');
      return;
    }
    setMismatch(undefined);
    setBusy(true);
    setError(null);

    try {
      await authApi.changePassword({ currentPassword, newPassword });
      // The `mustChangePassword` flag has just been cleared server-side; re-reading it
      // is what releases the route guard.
      await reload();
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
    } catch (cause) {
      setError(toFormError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <Card>
        <CardHeader
          title="Change your password"
          description={
            forced
              ? 'Your account is still using the password you were issued. Choose your own before continuing.'
              : 'You will stay signed in here. Every other device will be signed out.'
          }
        />
        <CardBody>
          {forced && !done ? (
            <Alert variant="warning" className="mb-4">
              Until this is done, the rest of the system is unavailable to your account.
            </Alert>
          ) : null}

          {done ? (
            <div className="flex flex-col gap-4">
              <Alert variant="success" title="Your password has been changed">
                Any other device signed in to this account has been signed out.
              </Alert>
              <Button
                fullWidth
                onClick={() => {
                  void navigate('/', { replace: true });
                }}
              >
                Continue
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              {error !== null ? (
                <Alert
                  variant="error"
                  {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
                >
                  {error.message}
                </Alert>
              ) : null}

              <TextField
                label="Current password"
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                required
                value={currentPassword}
                error={error?.fieldErrors.currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                }}
              />

              <TextField
                label="New password"
                type="password"
                name="newPassword"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                error={error?.fieldErrors.newPassword}
                hint="At least 12 characters, and not your name, email address or a password you use elsewhere."
                onChange={(event) => {
                  setNewPassword(event.target.value);
                }}
              />

              <TextField
                label="Confirm new password"
                type="password"
                name="confirmation"
                autoComplete="new-password"
                required
                value={confirmation}
                error={mismatch}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                }}
              />

              <Button type="submit" fullWidth isLoading={busy} loadingLabel="Saving">
                Change password
              </Button>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
