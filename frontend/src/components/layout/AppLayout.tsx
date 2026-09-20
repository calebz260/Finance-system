import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';

import type { PermissionKey } from '@sfs/shared';
import { PermissionKey as Permission } from '@sfs/shared';

import { useAuth } from '../../auth/auth-context';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';

export interface NavigationItem {
  readonly label: string;
  readonly to: string;
  /** Hidden unless the signed-in user holds this permission. */
  readonly permission?: PermissionKey;
}

/**
 * Only routes that actually exist are listed. Navigation grows as modules land in later
 * phases; a link to an unbuilt screen would be exactly the kind of fake completeness
 * Section 42 rules out.
 *
 * A link hidden for want of a permission is a courtesy, not a control: the route guard
 * repeats the check, and the server enforces it regardless of what the menu showed.
 */
const NAVIGATION: readonly NavigationItem[] = [
  { label: 'System status', to: '/' },
  { label: 'Students', to: '/students', permission: Permission.STUDENT_READ },
  { label: 'Academic setup', to: '/academic', permission: Permission.ACADEMIC_READ },
  { label: 'Fee setup', to: '/fees', permission: Permission.FEE_STRUCTURE_READ },
  { label: 'Raise charges', to: '/fees/charge-runs', permission: Permission.CHARGE_READ },
  { label: 'User accounts', to: '/users', permission: Permission.USER_READ },
  { label: 'Your account', to: '/account' },
];

export interface AppLayoutProps {
  readonly children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps): React.JSX.Element {
  const { status, user, can, signOut } = useAuth();
  const navigate = useNavigate();

  const signedIn = status === 'signed_in' && user !== null;
  const visibleItems = signedIn
    ? NAVIGATION.filter((item) => item.permission === undefined || can(item.permission))
    : [];

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

          {signedIn ? (
            <div className="flex items-center gap-3">
              <div className="hidden min-w-0 text-right sm:block">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {user.firstName} {user.lastName}
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {user.roleKeys.length > 0 ? user.roleKeys.join(', ') : 'No role assigned'}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void (async () => {
                    await signOut();
                    await navigate('/sign-in', { replace: true });
                  })();
                }}
              >
                Sign out
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
        {visibleItems.length > 0 ? (
          <nav aria-label="Main navigation" className="lg:w-56 lg:shrink-0">
            <ul className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
              {visibleItems.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
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
        ) : null}

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
