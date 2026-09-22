/**
 * The payments table.
 *
 * Two behaviours are worth pinning down, and both are about what somebody sees *first*: a
 * verifier lands on the claims waiting for them, because a pending claim is money sitting
 * unrecognised; and everybody else lands on the history they came to search.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PermissionKey,
  type AuthenticatedUser,
  type PaginatedResponse,
  type PaymentSummary,
} from '@sfs/shared';

import { AuthContext, type AuthContextValue } from '../auth/auth-context';
import { clearAccessToken, setRefreshHandler } from '../lib/auth-token';
import { PaymentsPage } from './PaymentsPage';

const CLAIM: PaymentSummary = {
  id: 'payment-1',
  reference: 'PAY-2026-000000123',
  studentId: 'student-1',
  studentNumber: 'STU-2026-00001',
  studentName: 'Aline Uwase',
  amount: '50000.00',
  currency: 'RWF',
  method: 'BANK_TRANSFER',
  verificationMethod: 'MANUAL',
  providerKey: 'BANK_OF_KIGALI',
  status: 'PENDING',
  academicYearId: 'year-1',
  academicYearName: '2026',
  termId: 'term-1',
  termName: 'Term 1',
  payerName: 'Jean Uwase',
  externalReference: 'BK-99881',
  failureReason: null,
  initiatedByName: 'Beata Mukama',
  initiatedAt: '2026-09-21T08:30:00.000Z',
  completedAt: null,
  verifiedByName: null,
  verifiedAt: null,
  reversedByName: null,
  reversedAt: null,
  reversalReason: null,
  ledgerEntryId: null,
  evidenceCount: 1,
  version: 3,
};

function page(items: readonly PaymentSummary[]): PaginatedResponse<PaymentSummary> {
  return {
    data: items,
    meta: {
      page: 1,
      pageSize: 25,
      totalItems: items.length,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    },
  };
}

const bursar: AuthenticatedUser = {
  id: 'user-1',
  email: 'bursar@gskicukiro.invalid',
  firstName: 'Beata',
  lastName: 'Mukama',
  schoolId: 'school-1',
  isSystemAdministrator: false,
  mustChangePassword: false,
  mfaEnabled: true,
  mfaSatisfied: true,
  roleKeys: ['BURSAR'],
  permissions: [PermissionKey.PAYMENT_READ, PermissionKey.PAYMENT_VERIFY_MANUAL],
};

const parent: AuthenticatedUser = {
  ...bursar,
  roleKeys: ['PARENT'],
  permissions: [PermissionKey.OWN_FINANCIALS_READ],
};

function contextFor(user: AuthenticatedUser): AuthContextValue {
  return {
    status: 'signed_in',
    user,
    signIn: () => Promise.resolve({ kind: 'authenticated' }),
    completeMfa: () => Promise.resolve(),
    adoptSession: () => undefined,
    signOut: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    can: (permission) => user.permissions.includes(permission),
    hasRole: (role) => user.roleKeys.includes(role),
  };
}

function stubApi(items: readonly PaymentSummary[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (): string | null => null },
      text: (): Promise<string> => Promise.resolve(JSON.stringify(page(items))),
    }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderPage(user: AuthenticatedUser = bursar): void {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={contextFor(user)}>
        <PaymentsPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function urls(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  clearAccessToken();
  setRefreshHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PaymentsPage', () => {
  it('opens a verifier on the claims waiting to be verified', async () => {
    const fetchMock = stubApi([CLAIM]);
    renderPage();

    await waitFor(() => {
      expect(urls(fetchMock)).toHaveLength(1);
    });

    const requested = urls(fetchMock)[0] ?? '';
    expect(requested).toContain('verificationMethod=MANUAL');
    expect(requested).toContain('status=PENDING');
  });

  it('opens everyone else on the whole history', async () => {
    const fetchMock = stubApi([CLAIM]);
    renderPage(parent);

    await waitFor(() => {
      expect(urls(fetchMock)).toHaveLength(1);
    });

    const requested = urls(fetchMock)[0] ?? '';
    expect(requested).not.toContain('status=PENDING');
  });

  it('shows the amount and the status as the server reported them', async () => {
    stubApi([CLAIM]);
    renderPage();

    expect(await screen.findByText('PAY-2026-000000123')).toBeInTheDocument();

    // Scoped to the table, because "Awaiting verification" is also the name of the view
    // the bursar is looking at.
    const row = within(screen.getByRole('table'));
    expect(row.getByText('Aline Uwase')).toBeInTheDocument();
    expect(row.getByText(/50,000/)).toBeInTheDocument();
    // Never "paid": a pending claim has credited nothing.
    expect(row.getByText(/awaiting verification/i)).toBeInTheDocument();
    expect(row.queryByText(/^paid$/i)).not.toBeInTheDocument();
  });

  it('says what an empty queue means rather than showing a blank table', async () => {
    stubApi([]);
    renderPage();

    expect(await screen.findByText(/nothing is waiting to be verified/i)).toBeInTheDocument();
  });
});
