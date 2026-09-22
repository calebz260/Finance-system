/**
 * The reconciliation screen.
 *
 * What these assert is that the screen never turns a suggestion into a decision: a
 * candidate whose amount differs cannot be accepted at all, crediting is a separate button
 * from matching, and a bursar without the verification permission is not offered it.
 *
 * The summary assertions matter for a different reason — a reconciliation screen that
 * reported only unattributed bank lines would let unconfirmed claims pile up invisibly, so
 * both figures are expected to be on the page.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PermissionKey,
  type AuthenticatedUser,
  type ReconciliationSummary,
  type StatementLineWorklist,
} from '@sfs/shared';

import { AuthContext, type AuthContextValue } from '../auth/auth-context';
import { clearAccessToken, setRefreshHandler } from '../lib/auth-token';
import { ReconciliationPage } from './ReconciliationPage';

const SUMMARY: ReconciliationSummary = {
  from: null,
  to: null,
  currency: 'RWF',
  statementLines: 3,
  matchedLines: 1,
  unmatchedLines: 1,
  ambiguousLines: 0,
  ignoredLines: 1,
  matchedTotal: '50000.00',
  unmatchedTotal: '17000.00',
  unreconciledPayments: 2,
  unreconciledPaymentTotal: '81000.00',
};

const WORKLIST: StatementLineWorklist = {
  lines: [
    {
      id: 'line-1',
      importId: 'import-1',
      lineNumber: 2,
      valueDate: '2026-09-21',
      narrative: 'RTGS INWARD FROM JEAN UWASE',
      reference: 'BK-99881',
      amount: '50000.00',
      currency: 'RWF',
      direction: 'MONEY_IN',
      matchStatus: 'UNMATCHED',
      matchedPaymentId: null,
      matchedPaymentReference: null,
      matchedStudentName: null,
      matchedByName: null,
      matchedAt: null,
      matchNote: null,
      version: 0,
    },
  ],
  suggestions: {
    'line-1': [
      {
        paymentId: 'payment-1',
        reference: 'PAY-2026-000000123',
        studentId: 'student-1',
        studentName: 'Aline Uwase',
        studentNumber: 'STU-2026-00001',
        amount: '50000.00',
        status: 'PENDING',
        payerName: 'Jean Uwase',
        initiatedAt: '2026-09-20T08:00:00.000Z',
        reason: 'the amount is exactly the same; the payer’s name appears on the line',
        amountMatches: true,
      },
      {
        paymentId: 'payment-2',
        reference: 'PAY-2026-000000124',
        studentId: 'student-2',
        studentName: 'Eric Habimana',
        studentNumber: 'STU-2026-00002',
        amount: '45000.00',
        status: 'PENDING',
        payerName: 'Jean Uwase',
        initiatedAt: '2026-09-19T08:00:00.000Z',
        reason: 'the payer’s name appears on the line',
        amountMatches: false,
      },
    ],
  },
};

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
  permissions: [
    PermissionKey.RECONCILIATION_READ,
    PermissionKey.RECONCILIATION_PERFORM,
    PermissionKey.RECONCILIATION_IMPORT_STATEMENT,
    PermissionKey.PAYMENT_VERIFY_MANUAL,
  ],
};

/** Somebody who may reconcile but not verify a payment. */
const matcherOnly: AuthenticatedUser = {
  ...bursar,
  permissions: [PermissionKey.RECONCILIATION_READ, PermissionKey.RECONCILIATION_PERFORM],
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

/** Routes by URL: the summary, the worklist and the match are three endpoints. */
function stubApi(
  match: { status: number; body: unknown } = {
    status: 200,
    body: {
      data: {
        line: { ...WORKLIST.lines[0], matchStatus: 'MATCHED' },
        payment: null,
        credited: true,
        message: 'Matched and credited.',
      },
    },
  },
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string, init?: { method?: string }) => {
    const chosen =
      init?.method === 'POST'
        ? match
        : url.includes('/summary')
          ? { status: 200, body: { data: SUMMARY } }
          : { status: 200, body: { data: WORKLIST } };

    return Promise.resolve({
      ok: chosen.status >= 200 && chosen.status < 300,
      status: chosen.status,
      headers: { get: (): string | null => null },
      text: (): Promise<string> => Promise.resolve(JSON.stringify(chosen.body)),
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderPage(user: AuthenticatedUser = bursar): void {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={contextFor(user)}>
        <ReconciliationPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function postBodies(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls
    .filter((call) => (call[1] as { method?: string } | undefined)?.method === 'POST')
    .map((call) => JSON.parse((call[1] as { body: string }).body));
}

afterEach(() => {
  clearAccessToken();
  setRefreshHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReconciliationPage', () => {
  it('reports both sides of the reconciliation', async () => {
    stubApi();
    renderPage();

    // Money the school holds and cannot explain...
    expect(await screen.findByText(/not attributed/i)).toBeInTheDocument();
    expect(screen.getByText(/17,000/)).toBeInTheDocument();
    // ...and claims the bank has no record of.
    expect(screen.getByText(/claims the bank has not confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/81,000/)).toBeInTheDocument();
  });

  it('shows why each candidate is being suggested', async () => {
    stubApi();
    renderPage();

    expect(await screen.findByText(/the amount is exactly the same/i)).toBeInTheDocument();
    expect(screen.getByText('RTGS INWARD FROM JEAN UWASE')).toBeInTheDocument();
  });

  it('will not let a candidate with a different amount be accepted', async () => {
    stubApi();
    renderPage();

    await screen.findByText(/the amounts differ/i);

    // Two candidates, and the one whose amount disagrees has both its buttons disabled:
    // they are not the same money, whatever else matches.
    const matchButtons = screen.getAllByRole('button', { name: /^match$/i });
    expect(matchButtons).toHaveLength(2);
    expect(matchButtons[0]).toBeEnabled();
    expect(matchButtons[1]).toBeDisabled();
  });

  it('sends a match without crediting when only Match is pressed', async () => {
    const fetchMock = stubApi();
    renderPage();

    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /^match$/i }))[0]!);

    await waitFor(() => {
      expect(postBodies(fetchMock)).toHaveLength(1);
    });
    expect(postBodies(fetchMock)[0]).toMatchObject({
      paymentId: 'payment-1',
      confirmPayment: false,
      expectedVersion: 0,
    });
  });

  it('asks before crediting, and does not send when the bursar declines', async () => {
    const fetchMock = stubApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();

    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /match and credit/i }))[0]!);

    expect(postBodies(fetchMock)).toHaveLength(0);
  });

  it('sends the credit when the bursar confirms it', async () => {
    const fetchMock = stubApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /match and credit/i }))[0]!);

    await waitFor(() => {
      expect(postBodies(fetchMock)).toHaveLength(1);
    });
    expect(postBodies(fetchMock)[0]).toMatchObject({ confirmPayment: true });
  });

  it('does not offer crediting to somebody who may only reconcile', async () => {
    stubApi();
    renderPage(matcherOnly);

    expect(await screen.findAllByRole('button', { name: /^match$/i })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /match and credit/i })).not.toBeInTheDocument();
    // Nor the import controls, which need their own permission.
    expect(screen.queryByRole('button', { name: /^import$/i })).not.toBeInTheDocument();
  });

  it('will not set a line aside without a reason', async () => {
    const fetchMock = stubApi();
    vi.spyOn(window, 'prompt').mockReturnValue('  ');
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /not a student payment/i }));

    expect(postBodies(fetchMock)).toHaveLength(0);
  });
});
