import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Renders the card as a <section>, which needs an accessible name. */
  readonly ariaLabelledBy?: string;
}

export function Card({ children, className, ariaLabelledBy }: CardProps): React.JSX.Element {
  return (
    <section
      {...(ariaLabelledBy !== undefined ? { 'aria-labelledby': ariaLabelledBy } : {})}
      className={cn(
        'rounded-lg border border-slate-200 bg-white shadow-sm',
        'dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      {children}
    </section>
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly titleId?: string;
  readonly className?: string;
}

export function CardHeader({
  title,
  description,
  actions,
  titleId,
  className,
}: CardHeaderProps): React.JSX.Element {
  return (
    <header
      className={cn(
        'flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6',
        'dark:border-slate-800',
        className,
      )}
    >
      <div className="min-w-0">
        <h2
          {...(titleId !== undefined ? { id: titleId } : {})}
          className="truncate text-base font-semibold text-slate-900 dark:text-slate-100"
        >
          {title}
        </h2>
        {description !== undefined ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return <div className={cn('px-4 py-4 sm:px-6', className)}>{children}</div>;
}

export function CardFooter({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <footer
      className={cn('border-t border-slate-200 px-4 py-3 sm:px-6 dark:border-slate-800', className)}
    >
      {children}
    </footer>
  );
}
