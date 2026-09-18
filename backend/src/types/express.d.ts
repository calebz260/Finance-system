/**
 * Express request augmentations.
 *
 * Kept deliberately small: only values the framework layer attaches. Domain data is
 * passed through services, not smuggled on the request object.
 */
import type { ParsedRequestData } from '../middleware/validate.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id assigned by `requestContextMiddleware`. */
      requestId: string;
      /** Output of `validate(...)`: parsed and coerced body/query/params. */
      valid?: ParsedRequestData;
    }
  }
}

export {};
