import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncResource<TData> {
  readonly status: AsyncStatus;
  readonly data: TData | undefined;
  readonly error: unknown;
  /** Re-runs the fetcher, keeping the previously loaded data visible until it resolves. */
  readonly refresh: () => void;
  readonly isRefreshing: boolean;
}

/**
 * Minimal data-loading hook.
 *
 * Deliberately not a caching library: the system's screens are mostly
 * bursar-initiated queries where staleness is a correctness problem, not a performance
 * one. A payment total that is 30 seconds out of date is worse than a brief spinner.
 *
 * It does handle the things that actually cause bugs:
 *  - aborts the in-flight request when the component unmounts or the key changes, so a
 *    late response cannot overwrite fresher state;
 *  - keeps the previous data visible while refreshing, avoiding a flash of empty table;
 *  - never swallows an error -- it is surfaced for `DataState` to render.
 */
export function useAsyncResource<TData>(
  fetcher: (signal: AbortSignal) => Promise<TData>,
  dependencies: readonly unknown[] = [],
): AsyncResource<TData> {
  const [status, setStatus] = useState<AsyncStatus>('idle');
  const [data, setData] = useState<TData | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Keeping the fetcher in a ref means an inline arrow function does not retrigger the
  // effect on every render; the dependency array stays the explicit contract.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const hasDataRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    if (hasDataRef.current) {
      setIsRefreshing(true);
    } else {
      setStatus('loading');
    }

    void (async (): Promise<void> => {
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        hasDataRef.current = true;
        setError(undefined);
        setStatus('success');
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        setError(caught);
        setStatus('error');
      } finally {
        if (!cancelled) setIsRefreshing(false);
      }
    })();

    return (): void => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller owns the key
  }, [reloadToken, ...dependencies]);

  const refresh = useCallback((): void => {
    setReloadToken((token) => token + 1);
  }, []);

  return { status, data, error, refresh, isRefreshing };
}
