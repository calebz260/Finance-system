import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * Shown when a request succeeded but there is nothing to display. Deliberately distinct
 * from an error: "no payments recorded today" is normal, and a bursar must be able to
 * tell it apart from "payments failed to load".
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 px-6 py-12 text-center',
        'dark:border-slate-700',
        className,
      )}
    >
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{title}</p>
      {description !== undefined ? (
        <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-400">{description}</p>
      ) : null}
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
