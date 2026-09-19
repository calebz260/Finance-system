/**
 * Password endpoints.
 *
 * Thin, like every controller here. The one judgement it makes is about what a reset
 * request is allowed to say: the answer is the same — `202`, with the same body —
 * whether the address belongs to an account, an account that is suspended, or nobody at
 * all. Anything else turns the form into a way to test whether a given parent or member
 * of staff has an account.
 *
 * The reset token itself is never in a response. It goes to the account's own contact
 * details through the delivery port, or nowhere.
 */
import type { Request, Response } from 'express';

import { HttpStatus, sendSuccess } from '../../lib/http.js';
import { requirePrincipal } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import type {
  ChangePasswordBody,
  RequestPasswordResetBody,
  ResetPasswordBody,
} from './password.schema.js';
import { changePassword, requestPasswordReset, resetPassword } from './password.service.js';

/**
 * `POST /auth/password/change`
 *
 * Requires a session *and* the current password. The calling session survives; every
 * other one is ended.
 */
export const changePasswordHandler = async (req: Request, res: Response): Promise<void> => {
  const principal = requirePrincipal(req);
  const { body } = validated<{ body: ChangePasswordBody }>(req);

  await changePassword({
    userId: principal.userId,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    currentSessionId: principal.sessionId,
  });

  res.status(HttpStatus.NO_CONTENT).send();
};

/**
 * `POST /auth/password/reset-request`
 *
 * Always `202 Accepted`. "Accepted" is also the honest status: what happened is that a
 * message was queued for an address that may or may not exist, which is precisely what
 * the client is being told.
 */
export const requestPasswordResetHandler = async (req: Request, res: Response): Promise<void> => {
  const { body } = validated<{ body: RequestPasswordResetBody }>(req);

  await requestPasswordReset({
    email: body.email,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  });

  sendSuccess(
    res,
    {
      message:
        'If an account exists for that email address, a password reset link has been sent to it.',
    },
    { status: HttpStatus.ACCEPTED },
  );
};

/**
 * `POST /auth/password/reset`
 *
 * Consumes the token and sets the new password. Every session for the account is ended:
 * whoever completed this could not sign in, so no live session belongs to them.
 */
export const resetPasswordHandler = async (req: Request, res: Response): Promise<void> => {
  const { body } = validated<{ body: ResetPasswordBody }>(req);

  await resetPassword({ token: body.token, newPassword: body.newPassword });

  res.status(HttpStatus.NO_CONTENT).send();
};
