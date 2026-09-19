/**
 * Turning an `ApiError` into something a form can render.
 *
 * Two rules, both about not making the user guess:
 *
 *  - A field-level problem attaches to its input. The server sends `body.newPassword`;
 *    the form field is `newPassword`, which `fieldErrorsByPath` already reconciles.
 *  - Anything else becomes one banner message, with the request id, so a user can
 *    quote it to the bursar's office.
 */
import { ApiError } from './api-client';

export interface FormErrorState {
  readonly message: string;
  readonly fieldErrors: Record<string, string>;
  readonly requestId?: string;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

export function toFormError(error: unknown): FormErrorState {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      fieldErrors: error.fieldErrorsByPath,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    };
  }

  // A non-`ApiError` here means a bug in the client rather than a rejection from the
  // server, so nothing about it is safe or useful to show.
  return { message: GENERIC_MESSAGE, fieldErrors: {} };
}
