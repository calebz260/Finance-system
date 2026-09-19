import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '../../lib/cn';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: ReactNode;
  /** Server-side field error, keyed to this input by `fieldErrorsByPath`. */
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
}

/**
 * A labelled text input.
 *
 * Centralised for the reason `DataState` is: the accessible wiring — a real `<label>`,
 * `aria-invalid`, and an error message referenced by `aria-describedby` — is easy to
 * get right once and easy to forget on the fifth form. A parent using a screen reader
 * has to be told *which* field was rejected, not merely that something was.
 */
export function TextField({
  label,
  error,
  hint,
  className,
  required,
  ...rest
}: TextFieldProps): React.JSX.Element {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy = [error !== undefined ? errorId : null, hint !== undefined ? hintId : null]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        {label}
        {required === true ? (
          <span aria-hidden="true" className="ml-0.5 text-red-600">
            *
          </span>
        ) : null}
      </label>

      <input
        id={id}
        required={required}
        aria-invalid={error !== undefined}
        {...(describedBy !== '' ? { 'aria-describedby': describedBy } : {})}
        className={cn(
          'h-10 rounded-md border px-3 text-sm text-slate-900 shadow-sm outline-none transition-colors',
          'placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500',
          'dark:bg-slate-900 dark:text-slate-100',
          error === undefined
            ? 'border-slate-300 dark:border-slate-700'
            : 'border-red-500 dark:border-red-500',
          className,
        )}
        {...rest}
      />

      {hint !== undefined ? (
        <p id={hintId} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}

      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
