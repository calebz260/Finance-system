import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { cn } from '../../lib/cn';

export interface NavigationItem {
  readonly label: string;
  readonly to: string;
}

/**
 * Only routes that actually exist are listed. Navigation grows as modules land in later
 * phases; a link to an unbuilt screen would be exactly the kind of fake completeness
 * Section 42 rules out.
 */
const NAVIGATION: readonly NavigationItem[] = [{ label: 'System status', to: '/' }];

export interface AppLayoutProps {
  readonly children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps): React.JSX.Element {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
            >
              SF
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                School Finance System
              </p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                Fees, payments and financial records
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
        <nav aria-label="Main navigation" className="lg:w-56 lg:shrink-0">
          <ul className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {NAVIGATION.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }): string =>
                    cn(
                      'block rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                      isActive
                        ? 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main id="main-content" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <footer className="mx-auto max-w-7xl px-4 py-6 text-xs text-slate-500 sm:px-6 dark:text-slate-400">
        <p>
          All times shown in Kigali time (UTC+2). Financial figures are calculated and verified on
          the server.
        </p>
      </footer>
    </div>
  );
}
