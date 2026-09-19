/**
 * Express request augmentations.
 *
 * Kept deliberately small: only values the framework layer attaches. Domain data is
 * passed through services, not smuggled on the request object.
 */
import type { ParsedRequestData } from '../middleware/validate.js';
import type { Principal } from '../modules/auth/principal.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id assigned by `requestContextMiddleware`. */
      requestId: string;
      /** Output of `validate(...)`: parsed and coerced body/query/params. */
      valid?: ParsedRequestData;
      /**
       * The authenticated caller, set by the `authenticate` middleware. Optional because
       * public routes have none; read it through `requirePrincipal(req)`, which turns a
       * missing middleware into an immediate error rather than a silent undefined.
       */
      principal?: Principal;
    }
  }
}

export {};
