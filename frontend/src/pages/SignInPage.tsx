/**
 * Sign in.
 *
 * One screen, three steps, because they are one task: a correct password is not
 * necessarily a session. For a Bursar, Finance Manager, School Administrator or Super
 * Administrator it is the first of two steps, and for such an account that has never
 * enrolled, it leads into enrolment rather than into the application.
 *
 * What the screen deliberately does not do is tell the user anything the server
 * withheld. "The email address or password is incorrect" is shown exactly as sent,
 * whether the address is unknown or the password is wrong — a friendlier, more specific
 * message here would turn the form into a way to discover who has an account.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { useAuth } from '../auth/auth-context';
import { MfaEnrolment } from '../components/auth/MfaEnrolment';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import { toFormError, type FormErrorState } from '../lib/form-errors';

type Step =
  | { readonly name: 'password' }
  | { readonly name: 'mfa'; readonly challengeToken: string }
  | { readonly name: 'enrolment'; readonly enrolmentToken: string };

interface LocationState {
  readonly from?: string;
}

export function SignInPage(): React.JSX.Element {
  const { status, signIn, completeMfa, adoptSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ name: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);

  // Where the user was heading when their session ran out, if anywhere.
  const destination = (location.state as LocationState | null)?.from ?? '/';

  const submitPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const outcome = await signIn({ email, password });

      if (outcome.kind === 'mfa_required') {
        setStep({ name: 'mfa', challengeToken: outcome.challengeToken });
      } else if (outcome.kind === 'mfa_enrolment_required') {
        setStep({ name: 'enrolment', enrolmentToken: outcome.enrolmentToken });
      } else {
        await navigate(destination, { replace: true });
      }
    } catch (cause) {
      setError(toFormError(cause));
      // Cleared on every failure: the next attempt starts from an empty box rather
      // than from a value the user cannot see and may not have typed.
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (step.name !== 'mfa') return;

    setBusy(true);
    setError(null);

    try {
      await completeMfa({
        challengeToken: step.challengeToken,
        ...(useRecoveryCode ? { recoveryCode: code } : { code }),
      });
      await navigate(destination, { replace: true });
    } catch (cause) {
      setError(toFormError(cause));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'signed_in') {
    return <Navigate to={destination} replace />;
  }

  const description =
    step.name === 'password'
      ? 'Use the email address the school registered for you.'
      : step.name === 'mfa'
        ? 'Enter the code from your authenticator app.'
        : 'Your role requires two-factor authentication.';

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <Card>
        <CardHeader title="Sign in" description={description} />
        <CardBody>
          {error !== null ? (
            <Alert
              variant="error"
              className="mb-4"
              {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
            >
              {error.message}
            </Alert>
          ) : null}

          {step.name === 'password' ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                void submitPassword(event);
              }}
            >
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
              <TextField
                label="Password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                error={error?.fieldErrors.password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />

              <Button type="submit" fullWidth isLoading={busy} loadingLabel="Signing in">
                Sign in
              </Button>

              <p className="text-center text-sm">
                <Link
                  to="/forgot-password"
                  className="text-brand-700 underline dark:text-brand-300"
                >
                  Forgotten your password?
                </Link>
              </p>
            </form>
          ) : null}

          {step.name === 'mfa' ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                void submitCode(event);
              }}
            >
              <TextField
                label={useRecoveryCode ? 'Recovery code' : 'Authenticator code'}
                name={useRecoveryCode ? 'recoveryCode' : 'code'}
                // One-time-code autofill only applies to the six-digit case.
                autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                required
                autoFocus
                value={code}
                error={error?.fieldErrors.code ?? error?.fieldErrors.recoveryCode}
                hint={
                  useRecoveryCode
                    ? 'One of the codes you saved when you set up two-factor authentication. Each one works once.'
                    : 'Six digits, from Google Authenticator, Microsoft Authenticator, Authy or FreeOTP.'
                }
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />

              <Button type="submit" fullWidth isLoading={busy} loadingLabel="Checking">
                Verify
              </Button>

              <Button
                variant="ghost"
                onClick={() => {
                  setUseRecoveryCode((current) => !current);
                  setCode('');
                  setError(null);
                }}
              >
                {useRecoveryCode
                  ? 'Use your authenticator app instead'
                  : 'Use a recovery code instead'}
              </Button>
            </form>
          ) : null}

          {step.name === 'enrolment' ? (
            <MfaEnrolment
              enrolmentToken={step.enrolmentToken}
              onComplete={({ session }) => {
                // Completing enrolment mid-sign-in establishes the session outright, so
                // it is adopted here rather than sending the user back to the password
                // form they filled in a minute ago.
                if (session !== undefined) adoptSession(session);
                void navigate(destination, { replace: true });
              }}
            />
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
