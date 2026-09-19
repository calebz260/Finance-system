/**
 * Request a password reset link.
 *
 * The confirmation is deliberately non-committal — "if an account exists" — and is
 * shown for every syntactically valid address. The server answers identically whether
 * or not the address is registered, and a screen that said "we have sent you an email"
 * only for real accounts would undo that in one line of UI copy.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import * as authApi from '../lib/auth-api';
import { toFormError, type FormErrorState } from '../lib/form-errors';

export function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await authApi.requestPasswordReset(email);
      setSent(true);
    } catch (cause) {
      // Only a malformed address or an unreachable server reaches here; an unknown
      // account is a success as far as this screen is concerned.
      setError(toFormError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <Card>
        <CardHeader
          title="Reset your password"
          description="We will send a link to the email address registered for your account."
        />
        <CardBody>
          {sent ? (
            <div className="flex flex-col gap-4">
              <Alert variant="success" title="Check your email">
                If an account exists for {email}, a password reset link is on its way. The link is
                valid for one hour and can be used once.
              </Alert>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Nothing arrived? Check the spam folder, or ask the school office to confirm which
                address is on your account.
              </p>
              <Link
                to="/sign-in"
                className="text-center text-sm text-brand-700 underline dark:text-brand-300"
              >
                Back to sign in
              </Link>
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
                label="Email address"
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                error={error?.fieldErrors.email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />

              <Button type="submit" fullWidth isLoading={busy} loadingLabel="Sending">
                Send reset link
              </Button>

              <p className="text-center text-sm">
                <Link to="/sign-in" className="text-brand-700 underline dark:text-brand-300">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
