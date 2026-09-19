/**
 * Two-factor enrolment.
 *
 * Used in two places with the same shape but different authority: during a sign-in,
 * where an enrolment token stands in for the session that does not exist yet, and from
 * the account screen, where the caller's own session is the authority.
 *
 * Three things the screen has to get right, all of them about not stranding the user:
 *
 *  - **The secret is offered as text as well as a QR code.** A bursar on a desktop with
 *    no camera, or an authenticator that cannot scan, still has to be able to enrol.
 *  - **Recovery codes are shown once and said to be shown once.** They are stored only
 *    as hashes; if the user closes the page without saving them and later loses their
 *    phone, the account needs an administrator.
 *  - **The user must confirm they have saved them** before the screen moves on. A
 *    single click is a low bar, but it is the difference between "we told you" and "we
 *    made you look".
 */
import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';

import type { MfaEnrolmentStartPayload, SessionPayload } from '@sfs/shared';

import * as authApi from '../../lib/auth-api';
import { toFormError, type FormErrorState } from '../../lib/form-errors';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { TextField } from '../ui/TextField';

export interface MfaEnrolmentProps {
  /**
   * Present when enrolling mid-sign-in. Omitted when the caller already has a session,
   * in which case the authenticated endpoints are used instead.
   */
  readonly enrolmentToken?: string;
  /**
   * Called once the user has confirmed they have saved their recovery codes.
   *
   * `session` is present only for enrolment during a sign-in, where completing it
   * establishes the session outright — the caller adopts it rather than sending the
   * user back to type their password again.
   */
  readonly onComplete: (result: {
    reauthenticationRequired: boolean;
    session?: SessionPayload;
  }) => void;
}

export function MfaEnrolment({ enrolmentToken, onComplete }: MfaEnrolmentProps): React.JSX.Element {
  const [offer, setOffer] = useState<MfaEnrolmentStartPayload | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [session, setSession] = useState<SessionPayload | null>(null);

  // Start enrolment as soon as the step is shown: the user has already decided, and an
  // extra "begin" button would only add a click.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const started =
          enrolmentToken === undefined
            ? await authApi.startOwnEnrolment()
            : await authApi.startEnrolment(enrolmentToken);
        if (!cancelled) setOffer(started);
      } catch (cause) {
        if (!cancelled) setError(toFormError(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enrolmentToken]);

  // Rendered in the browser rather than fetched: the URI contains the shared secret,
  // and sending it to an image service would hand the second factor to a third party.
  useEffect(() => {
    if (offer === null) return;
    let cancelled = false;

    void QRCode.toDataURL(offer.otpauthUri, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        // The secret is shown as text regardless, so a failed QR render is a
        // degradation rather than a dead end.
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [offer]);

  const confirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result =
        enrolmentToken === undefined
          ? await authApi.confirmOwnEnrolment(code)
          : await authApi.confirmEnrolment({ enrolmentToken, code });

      setRecoveryCodes(result.recoveryCodes);
      setReauthenticationRequired(result.reauthenticationRequired);
      setSession(result.session ?? null);
    } catch (cause) {
      setError(toFormError(cause));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success" title="Two-factor authentication is on">
          Save these recovery codes somewhere safe and private. Each one works once, and they are
          the only way back into your account if you lose your phone.{' '}
          <strong>They will not be shown again.</strong>
        </Alert>

        <ul className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-4 font-mono text-sm dark:bg-slate-800">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>{recoveryCode}</li>
          ))}
        </ul>

        {reauthenticationRequired ? (
          <Alert variant="info">
            You have been signed out of every device, including this one. Sign in again using the
            code from your authenticator app.
          </Alert>
        ) : null}

        <Button
          fullWidth
          onClick={() => {
            onComplete({
              reauthenticationRequired,
              ...(session !== null ? { session } : {}),
            });
          }}
        >
          I have saved my recovery codes
        </Button>
      </div>
    );
  }

  if (offer === null) {
    return (
      <div className="flex flex-col gap-4">
        {error !== null ? <Alert variant="error">{error.message}</Alert> : null}
        {error === null ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" label="Preparing two-factor setup" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void confirm(event);
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

      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700 dark:text-slate-300">
        <li>
          Install an authenticator app if you do not have one: Google Authenticator, Microsoft
          Authenticator, Authy or FreeOTP.
        </li>
        <li>Scan this code, or type the key below into the app by hand.</li>
        <li>Enter the six-digit code the app shows.</li>
      </ol>

      {qrDataUrl !== null ? (
        <img
          src={qrDataUrl}
          alt="QR code for setting up two-factor authentication"
          className="mx-auto rounded-md bg-white p-2"
          width={200}
          height={200}
        />
      ) : null}

      <div className="rounded-md bg-slate-50 p-3 text-center dark:bg-slate-800">
        <p className="text-xs text-slate-500 dark:text-slate-400">Setup key</p>
        <p className="font-mono text-sm break-all text-slate-900 dark:text-slate-100">
          {offer.secret}
        </p>
      </div>

      <TextField
        label="Six-digit code"
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        required
        value={code}
        error={error?.fieldErrors.code}
        onChange={(event) => {
          setCode(event.target.value);
        }}
      />

      <Button type="submit" fullWidth isLoading={busy} loadingLabel="Confirming">
        Turn on two-factor authentication
      </Button>
    </form>
  );
}
