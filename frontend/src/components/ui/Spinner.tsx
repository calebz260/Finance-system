import { cn } from '../../lib/cn';

export interface SpinnerProps {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
  /** Announced to screen readers; describe what is loading, not "loading". */
  readonly label?: string;
}

const SIZES: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-10 w-10 border-[3px]',
};

export function Spinner({ size = 'md', className, label }: SpinnerProps): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          'inline-block animate-spin rounded-full border-slate-300 border-t-brand-600',
          'dark:border-slate-700 dark:border-t-brand-400',
          SIZES[size],
          className,
        )}
        aria-hidden="true"
      />
      <span className="sr-only">{label ?? 'Loading'}</span>
    </span>
  );
}
