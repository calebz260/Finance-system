import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps {
  readonly variant?: AlertVariant;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  /** Rendered in small monospace so a user can read it out to support. */
  readonly requestId?: string;
  readonly actions?: ReactNode;
}

const VARIANTS: Record<AlertVariant, { container: string; icon: string; glyph: string }> = {
  info: {
    container:
      'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100',
    icon: 'text-blue-600 dark:text-blue-400',
    glyph: 'i',
  },
  success: {
    container:
      'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
    icon: 'text-emerald-600 dark:text-emerald-400',
    glyph: '✓',
  },
  warning: {
    container:
      'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
    icon: 'text-amber-600 dark:text-amber-400',
    glyph: '!',
  },
  error: {
    container:
      'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100',
    icon: 'text-red-600 dark:text-red-400',
    glyph: '!',
  },
};

export function Alert({
  variant = 'info',
  title,
  children,
  className,
  requestId,
  actions,
}: AlertProps): React.JSX.Element {
  const styles = VARIANTS[variant];
  // Errors and warnings interrupt; informational messages are announced politely.
  const role = variant === 'error' || variant === 'warning' ? 'alert' : 'status';

  return (
    <div
      role={role}
      className={cn('flex gap-3 rounded-md border px-4 py-3 text-sm', styles.container, className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-xs font-bold',
          styles.icon,
        )}
      >
        {styles.glyph}
      </span>
      <div className="min-w-0 flex-1">
        {title !== undefined ? <p className="font-semibold">{title}</p> : null}
        {children !== undefined ? (
          <div className={title !== undefined ? 'mt-1' : ''}>{children}</div>
        ) : null}
        {requestId !== undefined ? (
          <p className="mt-2 font-mono text-xs opacity-75">Reference: {requestId}</p>
        ) : null}
        {actions !== undefined ? <div className="mt-3 flex gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
