/**
 * The payment screen a bursar verifies from.
 *
 * What these assert is the promise the screen makes about money: that the amount on the
 * statement is typed rather than pre-filled, that confirming sends the version the screen
 * was showing, that a rejection cannot be sent without a reason, and that a payment which
 * has not been verified is never presented as paid.
 *
 * One click on this screen credits a family's account. These are the tests that stop it
 * happening on the strength of a figure nobody read.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PermissionKey,
  type AuthenticatedUser,
  type PaymentDetail,
  type PaymentStatusValue,
} from '@sfs/shared';

import { AuthContext, type AuthContextValue } from '../auth/auth-context';
import { clearAccessToken, setRefreshHandler } from '../lib/auth-token';
import { PaymentDetailPage } from './PaymentDetailPage';

const PENDING_CLAIM: PaymentDetail = {
  payment: {
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
  },
  transactions: [],
  statusHistory: [
    {
      id: 'history-1',
      fromStatus: null,
      toStatus: 'PENDING',
      source: 'USER',
      reason: 'Payment claim recorded, awaiting verification against a statement.',
      actorName: 'Beata Mukama',
      occurredAt: '2026-09-21T08:30:00.000Z',
    },
  ],
  evidence: [
    {
      id: 'evidence-1',
      kind: 'BANK_SLIP',
      fileName: 'deposit-slip.pdf',
      contentType: 'application/pdf',
      byteSize: 48_211,
      checksum: 'a'.repeat(64),
      uploadedByName: 'Jean Uwase',
      uploadedAt: '2026-09-21T08:35:00.000Z',
      isCurrent: true,
    },
  ],
  entries: [],
};

function withStatus(
  status: PaymentStatusValue,
  overrides: Partial<PaymentDetail> = {},
): PaymentDetail {
  return {
    ...PENDING_CLAIM,
    payment: { ...PENDING_CLAIM.payment, status },
    ...overrides,
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
  permissions: [
    PermissionKey.PAYMENT_READ,
    PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM,
    PermissionKey.PAYMENT_VERIFY_MANUAL,
  ],
};

/** A parent: their own payment, and none of the decisions about it. */
const parent: AuthenticatedUser = {
  ...bursar,
  roleKeys: ['PARENT'],
  permissions: [PermissionKey.OWN_FINANCIALS_READ, PermissionKey.OWN_PAYMENT_INITIATE],
};

/** A Finance Manager, who is the only role that may undo a credited payment. */
const financeManager: AuthenticatedUser = {
  ...bursar,
  roleKeys: ['FINANCE_MANAGER'],
  permissions: [
    PermissionKey.PAYMENT_READ,
    PermissionKey.PAYMENT_VERIFY_MANUAL,
    PermissionKey.PAYMENT_REVERSE,
    PermissionKey.PAYMENT_REFUND,
  ],
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

/** Routes the stub by URL and method: the read and the decision are two endpoints. */
function stubApi(
  detail: PaymentDetail,
  verification: { status: number; body: unknown } = {
    status: 200,
    body: {
      data: {
        payment: { ...detail.payment, status: 'SUCCESSFUL' },
        outcome: 'CREDITED',
        ledgerEntryId: 'entry-1',
        message: 'Payment confirmed.',
      },
    },
  },
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((_url: string, init?: { method?: string }) => {
    const chosen = init?.method === 'POST' ? verification : { status: 200, body: { data: detail } };

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
    <MemoryRouter initialEntries={['/payments/payment-1']}>
      <AuthContext.Provider value={contextFor(user)}>
        <PaymentDetailPage />
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

describe('PaymentDetailPage', () => {
  it('says plainly that a pending payment has credited nothing', async () => {
    stubApi(PENDING_CLAIM);
    renderPage();

    expect(await screen.findByText(/nothing has been credited yet/i)).toBeInTheDocument();
  });

  it('asks the verifier to type the statement amount, and does not pre-fill it', async () => {
    stubApi(PENDING_CLAIM);
    renderPage();

    const field = await screen.findByLabelText(/amount on the statement/i);

    // Empty on purpose: pre-filling the claimed amount would turn the comparison the
    // server performs into a formality.
    expect(field).toHaveValue('');
  });

  it('sends the typed amount and the version the screen was showing', async () => {
    const fetchMock = stubApi(PENDING_CLAIM);
    renderPage();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/amount on the statement/i), '50000.00');
    await user.click(screen.getByRole('button', { name: /confirm and credit/i }));

    await waitFor(() => {
      expect(postBodies(fetchMock)).toHaveLength(1);
    });

    expect(postBodies(fetchMock)[0]).toMatchObject({
      decision: 'CONFIRM',
      confirmedAmount: '50000.00',
      // The optimistic-lock guard: a payment that changed since it was loaded is refused
      // rather than decided on stale information.
      expectedVersion: 3,
    });
  });

  it('does not send a rejection when no reason is given', async () => {
    const fetchMock = stubApi(PENDING_CLAIM);
    vi.spyOn(window, 'prompt').mockReturnValue('');
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^reject$/i }));

    expect(postBodies(fetchMock)).toHaveLength(0);
  });

  it('sends a rejection with the reason the verifier gave', async () => {
    const fetchMock = stubApi(PENDING_CLAIM, {
      status: 200,
      body: {
        data: {
          payment: { ...PENDING_CLAIM.payment, status: 'FAILED' },
          outcome: 'FAILED',
          ledgerEntryId: null,
          message: 'Rejected.',
        },
      },
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Not on the statement for that week.');
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^reject$/i }));

    await waitFor(() => {
      expect(postBodies(fetchMock)).toHaveLength(1);
    });
    expect(postBodies(fetchMock)[0]).toMatchObject({
      decision: 'REJECT',
      reason: 'Not on the statement for that week.',
    });
  });

  it('offers no verification controls to a parent looking at their own payment', async () => {
    stubApi(PENDING_CLAIM);
    renderPage(parent);

    expect(await screen.findByText(/PAY-2026-000000123/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm and credit/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/amount on the statement/i)).not.toBeInTheDocument();
  });

  it('offers reversal and refund only on a credited payment, and only to the role that may', async () => {
    stubApi(withStatus('SUCCESSFUL'));
    renderPage(financeManager);

    expect(await screen.findByRole('button', { name: /reverse/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refund/i })).toBeInTheDocument();
    // Nothing to verify on a payment that is already credited.
    expect(screen.queryByRole('button', { name: /confirm and credit/i })).not.toBeInTheDocument();
  });

  it('does not offer a bursar the reversal controls', async () => {
    stubApi(withStatus('SUCCESSFUL'));
    renderPage();

    expect(await screen.findByText(/PAY-2026-000000123/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reverse/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
  });

  it('lists attached proof of payment without exposing a link to the file', async () => {
    stubApi(PENDING_CLAIM);
    renderPage();

    expect(await screen.findByText('deposit-slip.pdf')).toBeInTheDocument();
    // A download button, not an anchor: the file is fetched with the viewer's credentials.
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /deposit-slip/i })).not.toBeInTheDocument();
  });

  it('shows how a payment reached its current state', async () => {
    stubApi(PENDING_CLAIM);
    renderPage();

    expect(await screen.findByText(/created/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting verification against a statement/i)).toBeInTheDocument();
  });
});
