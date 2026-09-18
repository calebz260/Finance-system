import type { ReactNode } from 'react';

import { ApiError } from '../../lib/api-client';
import { Alert } from './Alert';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';

export interface DataStateProps<TData> {
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly data: TData | undefined;
  readonly error: unknown;
  readonly onRetry?: () => void;
  /** Called with loaded data to decide whether the empty state applies. */
  readonly isEmpty?: (data: TData) => boolean;
  readonly loadingLabel?: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: ReactNode;
  readonly children: (data: TData) => ReactNode;
}

function describe(error: unknown): { message: string; requestId?: string; retryable: boolean } {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      retryable: error.isRetryable,
    };
  }
  return {
    message: 'Something went wrong while loading this information.',
    retryable: true,
  };
}

/**
 * The single place the four data states are rendered, so every screen in the system
 * handles loading, error, empty and success consistently (Section 30) and no page can
 * accidentally ship without one of them.
 */
export function DataState<TData>({
  status,
  data,
  error,
  onRetry,
  isEmpty,
  loadingLabel,
  emptyTitle,
  emptyDescription,
  children,
}: DataStateProps<TData>): React.JSX.Element {
  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex items-center justify-center py-12" aria-live="polite">
        <Spinner size="lg" label={loadingLabel ?? 'Loading information'} />
      </div>
    );
  }

  if (status === 'error') {
    const described = describe(error);
    return (
      <Alert
        variant="error"
        title="Could not load this information"
        {...(described.requestId !== undefined ? { requestId: described.requestId } : {})}
        {...(onRetry !== undefined && described.retryable
          ? {
              actions: (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                  Try again
                </Button>
              ),
            }
          : {})}
      >
        {described.message}
      </Alert>
    );
  }

  // No data at all, or data the caller considers empty: both are the empty state.
  if (data === undefined || isEmpty?.(data) === true) {
    return (
      <EmptyState
        title={emptyTitle ?? 'Nothing to show yet'}
        {...(emptyDescription !== undefined ? { description: emptyDescription } : {})}
      />
    );
  }

  return <>{children(data)}</>;
}
