/**
 * The import wizard.
 *
 * What these assert is the promise the screen makes to a registrar: checking a file
 * writes nothing, every problem is shown against the row number in their spreadsheet,
 * and a file with problems cannot be imported by accident.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImportPreview, ImportResult } from '@sfs/shared';

import { clearAccessToken, setRefreshHandler } from '../lib/auth-token';
import { StudentImportPage } from './StudentImportPage';

const CLEAN_PREVIEW: ImportPreview = {
  fileName: 'students.csv',
  totalRows: 2,
  validRows: 2,
  rowsWithIssues: 0,
  issues: [],
  issuesTruncated: false,
  sample: [
    {
      row: 2,
      firstName: 'Aline',
      lastName: 'Mutesi',
      otherNames: null,
      gender: 'FEMALE',
      dateOfBirth: '2012-04-18',
      admissionDate: '2026-01-12',
      levelCode: 'S1',
      programCode: 'OLEVEL',
      classSectionCode: 'B',
      residency: 'DAY',
      guardianName: 'Jean Mutesi',
      guardianPhone: '+250788123456',
      guardianRelationship: 'FATHER',
    },
  ],
};

const PROBLEM_PREVIEW: ImportPreview = {
  ...CLEAN_PREVIEW,
  totalRows: 3,
  validRows: 2,
  rowsWithIssues: 1,
  issues: [
    { row: 4, column: 'levelCode', message: 'No level with that code exists.', value: 'GHOST' },
  ],
};

const RESULT: ImportResult = {
  studentsCreated: 2,
  guardiansCreated: 1,
  guardiansLinked: 2,
  enrollmentsCreated: 2,
  rowsRejected: 0,
  issues: [],
  issuesTruncated: false,
};

/** Routes the stub by URL: preview and commit are different endpoints. */
function stubUploads(responses: {
  preview?: { status: number; body: unknown };
  commit?: { status: number; body: unknown };
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string) => {
    const stub = url.includes('/import/preview') ? responses.preview : responses.commit;
    const chosen = stub ?? { status: 404, body: { error: { code: 'NOT_FOUND' } } };

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

function renderPage(): void {
  render(
    <MemoryRouter>
      <StudentImportPage />
    </MemoryRouter>,
  );
}

async function chooseFile(): Promise<void> {
  const user = userEvent.setup();
  const file = new File(['First Name,Last Name,Level\nAline,Mutesi,S1'], 'students.csv', {
    type: 'text/csv',
  });
  await user.upload(screen.getByLabelText(/student list/i), file);
}

afterEach(() => {
  clearAccessToken();
  setRefreshHandler(null);
});

describe('StudentImportPage', () => {
  it('will not check a file before one is chosen', () => {
    stubUploads({});
    renderPage();

    expect(screen.getByRole('button', { name: /check the file/i })).toBeDisabled();
  });

  it('shows what the file contains and writes nothing yet', async () => {
    const fetchMock = stubUploads({ preview: { status: 200, body: { data: CLEAN_PREVIEW } } });
    renderPage();

    await chooseFile();
    await userEvent.setup().click(screen.getByRole('button', { name: /check the file/i }));

    expect(await screen.findByText('Ready to import')).toBeInTheDocument();
    // The sample shows the row as it would be created, surname first.
    expect(screen.getByText('Mutesi, Aline')).toBeInTheDocument();

    // Exactly one call, and it was the preview: nothing has been imported.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/import/preview');
  });

  it('lists each problem against the row number in the spreadsheet', async () => {
    stubUploads({ preview: { status: 200, body: { data: PROBLEM_PREVIEW } } });
    renderPage();

    await chooseFile();
    await userEvent.setup().click(screen.getByRole('button', { name: /check the file/i }));

    expect(await screen.findByText('No level with that code exists.')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('levelCode')).toBeInTheDocument();
    expect(screen.getByText('(GHOST)')).toBeInTheDocument();
  });

  it('refuses to import a file with problems until that is chosen deliberately', async () => {
    // A partially applied import leaves someone reconciling which rows landed, so it
    // is never the default.
    stubUploads({ preview: { status: 200, body: { data: PROBLEM_PREVIEW } } });
    renderPage();

    await chooseFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /check the file/i }));

    const importButton = await screen.findByRole('button', { name: /import 2 students/i });
    expect(importButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(importButton).toBeEnabled();
  });

  it('imports straight away when the file is clean', async () => {
    stubUploads({
      preview: { status: 200, body: { data: CLEAN_PREVIEW } },
      commit: { status: 200, body: { data: RESULT } },
    });
    renderPage();

    await chooseFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /check the file/i }));

    const importButton = await screen.findByRole('button', { name: /import 2 students/i });
    expect(importButton).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(importButton);

    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText(/2 students added/i)).toBeInTheDocument();
  });

  it('reports a file the server could not read, without losing the reference', async () => {
    stubUploads({
      preview: {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message:
              'The file is missing required column(s): firstName. The first row must be a header.',
            requestId: 'req-42',
            timestamp: '2026-09-19T10:00:00.000Z',
          },
        },
      },
    });
    renderPage();

    await chooseFile();
    await userEvent.setup().click(screen.getByRole('button', { name: /check the file/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/missing required column/i);
    expect(alert).toHaveTextContent('req-42');
  });

  it('sends the file as multipart, without setting the content type by hand', async () => {
    // Setting Content-Type manually drops the multipart boundary, and the server then
    // cannot parse the upload at all.
    const fetchMock = stubUploads({ preview: { status: 200, body: { data: CLEAN_PREVIEW } } });
    renderPage();

    await chooseFile();
    await userEvent.setup().click(screen.getByRole('button', { name: /check the file/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(init.credentials).toBe('include');
  });
});
