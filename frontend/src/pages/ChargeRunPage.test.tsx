/**
 * The charge-run screen.
 *
 * What these assert is the promise this screen makes to a bursar, which matters more
 * here than on any other page in the system: previewing writes nothing, a term cannot be
 * billed without first being shown what that would do, and an overlapping configuration
 * blocks the run rather than warning about it.
 *
 * One click on this screen can create a thousand financial obligations. These are the
 * tests that stop that happening by accident.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PermissionKey,
  type AcademicYearSummary,
  type AuthenticatedUser,
  type ChargeRunPreview,
  type ChargeRunResult,
} from '@sfs/shared';

import { AuthContext, type AuthContextValue } from '../auth/auth-context';
import { clearAccessToken, setRefreshHandler } from '../lib/auth-token';
import { ChargeRunPage } from './ChargeRunPage';

const YEAR: AcademicYearSummary = {
  id: 'year-1',
  name: '2026',
  startDate: '2026-01-12',
  endDate: '2026-11-06',
  status: 'ACTIVE',
  isCurrent: true,
  terms: [
    {
      id: 'term-1',
      academicYearId: 'year-1',
      name: 'Term 1',
      sequence: 1,
      startDate: '2026-01-12',
      endDate: '2026-04-03',
      status: 'ACTIVE',
      isCurrent: true,
      version: 0,
    },
  ],
  version: 0,
};

const CLEAN_PREVIEW: ChargeRunPreview = {
  academicYearId: 'year-1',
  termId: 'term-1',
  studentsMatched: 2,
  chargesToCreate: 2,
  chargesToSkip: 0,
  totalAmount: '190000.00',
  conflicts: [],
  sample: [
    {
      studentId: 'student-1',
      studentNumber: 'STU-2026-00001',
      studentName: 'Aline Uwase',
      feeStructureId: 'structure-1',
      feeStructureName: 'S1 Term 1',
      feeCategoryName: 'Tuition',
      description: 'Tuition — Term 1',
      amount: '95000.00',
      alreadyCharged: false,
    },
  ],
  sampleTruncated: false,
};

const CONFLICTED_PREVIEW: ChargeRunPreview = {
  ...CLEAN_PREVIEW,
  conflicts: [
    {
      feeCategoryName: 'Tuition',
      feeStructureIds: ['structure-1', 'structure-2'],
      feeStructureNames: ['S1 Term 1', 'Programme-wide'],
      affectedStudentCount: 42,
    },
  ],
};

const APPLIED: ChargeRunResult = {
  chargeRunId: 'run-1',
  studentsMatched: 2,
  chargesCreated: 2,
  chargesSkipped: 0,
  totalAmount: '190000.00',
};

const financeUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'finance@gskicukiro.invalid',
  firstName: 'Grace',
  lastName: 'Ingabire',
  schoolId: 'school-1',
  isSystemAdministrator: false,
  mustChangePassword: false,
  mfaEnabled: true,
  mfaSatisfied: true,
  roleKeys: ['FINANCE_MANAGER'],
  permissions: [PermissionKey.CHARGE_READ, PermissionKey.CHARGE_CREATE],
};

/** A bursar who may look but, for this test, not raise. */
const readOnlyUser: AuthenticatedUser = {
  ...financeUser,
  permissions: [PermissionKey.CHARGE_READ],
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

/** Routes the stub by URL: years, preview and apply are three different endpoints. */
function stubApi(responses: {
  preview?: { status: number; body: unknown };
  apply?: { status: number; body: unknown };
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string) => {
    const chosen = url.includes('/charge-runs/preview')
      ? (responses.preview ?? { status: 200, body: { data: CLEAN_PREVIEW } })
      : url.includes('/charge-runs')
        ? (responses.apply ?? { status: 201, body: { data: APPLIED } })
        : { status: 200, body: { data: [YEAR] } };

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

function renderPage(user: AuthenticatedUser = financeUser): void {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={contextFor(user)}>
        <ChargeRunPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

async function choosePeriodAndPreview(): Promise<void> {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: /academic year/i })).toBeInTheDocument();
  });
  await user.selectOptions(screen.getByRole('combobox', { name: /academic year/i }), 'year-1');
  await user.selectOptions(screen.getByRole('combobox', { name: /term/i }), 'term-1');
  await user.click(screen.getByRole('button', { name: /preview/i }));
}

afterEach(() => {
  clearAccessToken();
  setRefreshHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChargeRunPage', () => {
  it('cannot preview until a period is chosen', async () => {
    stubApi({});
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preview/i })).toBeDisabled();
    });
  });

  it('shows what the run would do without raising anything', async () => {
    const fetchMock = stubApi({});
    renderPage();

    await choosePeriodAndPreview();

    expect(await screen.findByText(/what this run would do/i)).toBeInTheDocument();
    expect(screen.getByText('Aline Uwase')).toBeInTheDocument();

    // The apply endpoint was never called: previewing writes nothing.
    const applied = fetchMock.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/charge-runs') &&
        !call[0].includes('/preview'),
    );
    expect(applied).toHaveLength(0);
  });

  it('offers no way to raise charges before a preview has been run', async () => {
    stubApi({});
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /academic year/i })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /raise .* charge/i })).not.toBeInTheDocument();
  });

  it('blocks the run when two structures would charge the same category', async () => {
    stubApi({ preview: { status: 200, body: { data: CONFLICTED_PREVIEW } } });
    renderPage();

    await choosePeriodAndPreview();

    expect(await screen.findByText(/two fee structures overlap/i)).toBeInTheDocument();
    expect(screen.getByText(/42 student\(s\) affected/i)).toBeInTheDocument();
    // No way forward: the conflict is a block, not a warning.
    expect(screen.queryByRole('button', { name: /raise .* charge/i })).not.toBeInTheDocument();
  });

  it('asks for confirmation before raising, and does nothing if declined', async () => {
    const fetchMock = stubApi({});
    // Held in a local rather than asserted through `window.confirm`, which the linter
    // reads as an unbound method.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();

    await choosePeriodAndPreview();

    const raise = await screen.findByRole('button', { name: /raise 2 charge/i });
    await userEvent.setup().click(raise);

    expect(confirmSpy).toHaveBeenCalled();
    const applied = fetchMock.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/charge-runs') &&
        !call[0].includes('/preview'),
    );
    expect(applied).toHaveLength(0);
  });

  it('raises the charges once confirmed and reports the total', async () => {
    stubApi({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await choosePeriodAndPreview();
    await userEvent.setup().click(await screen.findByRole('button', { name: /raise 2 charge/i }));

    expect(await screen.findByText(/raised 2 charge\(s\)/i)).toBeInTheDocument();
  });

  it('surfaces a server-side refusal rather than claiming success', async () => {
    stubApi({
      apply: {
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Two fee structures would charge the same category.',
          },
        },
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await choosePeriodAndPreview();
    await userEvent.setup().click(await screen.findByRole('button', { name: /raise 2 charge/i }));

    expect(await screen.findByText(/the run did not proceed/i)).toBeInTheDocument();
  });

  it('hides the raise button from someone who may only read', async () => {
    stubApi({});
    renderPage(readOnlyUser);

    await choosePeriodAndPreview();

    expect(await screen.findByText(/what this run would do/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /raise .* charge/i })).not.toBeInTheDocument();
  });
});
