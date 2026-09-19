/**
 * Set a new password from a reset link.
 *
 * The token arrives in the query string, which is where a link can carry it — and also
 * why it is single-use and short-lived: a URL ends up in browser history, in a
 * forwarded message, and sometimes in a proxy log.
 *
 * The confirmation field is checked here rather than on the server. It is not a
 * security rule, it is a typing check, and there is no reason to spend a request on it.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import * as authApi from '../lib/auth-api';
import { toFormError, type FormErrorState } from '../lib/form-errors';

const MIN_PASSWORD_LENGTH = 12;

export function ResetPasswordPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);

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
      await authApi.resetPassword({ token, newPassword });
      setDone(true);
    } catch (cause) {
      setError(toFormError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (token === '') {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <Card>
          <CardHeader title="Reset your password" />
          <CardBody>
            <Alert variant="error" title="This link is incomplete">
              Open the link from your email exactly as it was sent, or request a new one.
            </Alert>
            <p className="mt-4 text-center text-sm">
              <Link to="/forgot-password" className="text-brand-700 underline dark:text-brand-300">
                Request a new link
              </Link>
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <Card>
        <CardHeader
          title="Choose a new password"
          description="You will be signed out of every device once it is set."
        />
        <CardBody>
          {done ? (
            <div className="flex flex-col gap-4">
              <Alert variant="success" title="Your password has been changed">
                Sign in with your new password. If you had an account lockout, it has been cleared.
              </Alert>
              <Button
                fullWidth
                onClick={() => {
                  void navigate('/sign-in', { replace: true });
                }}
              >
                Go to sign in
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
                label="New password"
                type="password"
                name="newPassword"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                error={error?.fieldErrors.newPassword}
                hint="At least 12 characters. A short phrase you will remember is stronger than a short password with symbols in it."
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
                Set new password
              </Button>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
