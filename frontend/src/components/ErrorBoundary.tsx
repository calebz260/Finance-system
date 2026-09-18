import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last line of defence for a render-time crash.
 *
 * Without it, a single bad value in a payments table blanks the whole page. It shows a
 * recoverable message instead, and never renders the error text itself -- a React error
 * can contain props, which here may include student or financial data.
 */
interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept on the console for now; wired to the error-tracking service in Phase 14.
    console.error('Unhandled rendering error', error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            The page could not be displayed. No changes were saved. Please reload and try again, or
            contact the bursar&rsquo;s office if it keeps happening.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
