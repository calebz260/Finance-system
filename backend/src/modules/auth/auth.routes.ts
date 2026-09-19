/**
 * `/api/v1/auth` routes.
 *
 * The split that matters here is which routes run *before* authentication and which run
 * behind it:
 *
 *  - **Public**: sign-in, the second-factor step, the enrolment a sign-in forces, and the
 *    refresh exchange. None of these can require a session, because their whole job is to
 *    produce one. Each carries its own credential instead -- a password, an intermediate
 *    token, or the refresh cookie.
 *
 *  - **Authenticated**: everything about an account that already has a session.
 *
 * Every public route is behind `authRateLimiter` (10 per 15 minutes per IP, successful
 * requests not counted). Per-account lockout already exists in the service, but it is
 * keyed on the account: without an IP limit, an attacker could spray one guess each
 * across hundreds of accounts and never trip it. The two limits cover different attacks
 * and neither replaces the other.
 *
 * `requireUsablePassword` is deliberately *not* applied. A user who must change their
 * password still has to be able to sign in, read `/auth/me`, change that password and
 * sign out; that middleware belongs on the ordinary application routes, which is where
 * later phases will apply it.
 */
import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireMfaSatisfied } from '../../middleware/authorize.js';
import { authRateLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import {
  confirmEnrolmentHandler,
  confirmOwnEnrolmentHandler,
  disableMfaHandler,
  listSessionsHandler,
  loginHandler,
  logoutAllHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  regenerateRecoveryCodesHandler,
  revokeSessionHandler,
  startEnrolmentHandler,
  startOwnEnrolmentHandler,
  verifyMfaHandler,
} from './auth.controller.js';
import {
  confirmEnrolmentSchema,
  confirmOwnEnrolmentSchema,
  disableMfaSchema,
  loginSchema,
  sessionIdParamsSchema,
  startEnrolmentSchema,
  verifyMfaSchema,
} from './auth.schema.js';
import {
  changePasswordHandler,
  requestPasswordResetHandler,
  resetPasswordHandler,
} from './password.controller.js';
import {
  changePasswordSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from './password.schema.js';

export function createAuthRouter(): Router {
  const router = Router();

  /* ------------------------------------------------------------------- public */

  router.post('/login', authRateLimiter, validate({ body: loginSchema }), loginHandler);

  router.post(
    '/mfa/verify',
    authRateLimiter,
    validate({ body: verifyMfaSchema }),
    verifyMfaHandler,
  );

  // Enrolment forced by a sign-in: the account holds a role that requires MFA but has
  // never enrolled, so there is no session yet and the enrolment token is the authority.
  router.post(
    '/mfa/enrolment/start',
    authRateLimiter,
    validate({ body: startEnrolmentSchema }),
    startEnrolmentHandler,
  );
  router.post(
    '/mfa/enrolment/confirm',
    authRateLimiter,
    validate({ body: confirmEnrolmentSchema }),
    confirmEnrolmentHandler,
  );

  // Rate-limited like the rest: the refresh cookie is a credential, and a stolen one
  // should not be usable to mint access tokens in a tight loop.
  router.post('/refresh', authRateLimiter, refreshHandler);

  // Forgotten-password recovery. Both steps are public by necessity -- the whole point
  // is that the user cannot sign in -- so both are rate-limited, and the request step
  // answers identically whether or not the address is known.
  router.post(
    '/password/reset-request',
    authRateLimiter,
    validate({ body: requestPasswordResetSchema }),
    requestPasswordResetHandler,
  );
  router.post(
    '/password/reset',
    authRateLimiter,
    validate({ body: resetPasswordSchema }),
    resetPasswordHandler,
  );

  /* ------------------------------------------------------ requires a session */

  router.get('/me', authenticate, meHandler);

  router.post('/logout', authenticate, logoutHandler);
  router.post('/logout-all', authenticate, logoutAllHandler);

  // Not behind `requireUsablePassword`: an account flagged `mustChangePassword` has to
  // be able to reach exactly this route, and nothing else.
  router.post(
    '/password/change',
    authenticate,
    validate({ body: changePasswordSchema }),
    changePasswordHandler,
  );

  router.get('/sessions', authenticate, listSessionsHandler);
  router.delete(
    '/sessions/:sessionId',
    authenticate,
    validate({ params: sessionIdParamsSchema }),
    revokeSessionHandler,
  );

  // Voluntary enrolment by a role that does not mandate MFA.
  router.post('/mfa/enable/start', authenticate, startOwnEnrolmentHandler);
  router.post(
    '/mfa/enable/confirm',
    authenticate,
    validate({ body: confirmOwnEnrolmentSchema }),
    confirmOwnEnrolmentHandler,
  );

  router.post(
    '/mfa/disable',
    authenticate,
    validate({ body: disableMfaSchema }),
    disableMfaHandler,
  );

  // Behind `requireMfaSatisfied`: recovery codes bypass the second factor, so a session
  // that never proved one must not be able to mint a fresh set.
  router.post(
    '/mfa/recovery-codes',
    authenticate,
    requireMfaSatisfied(),
    regenerateRecoveryCodesHandler,
  );

  return router;
}
