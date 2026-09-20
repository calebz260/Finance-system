/**
 * Bulk student import.
 *
 * Three steps, and the middle one is the point: choose a file, **see exactly what
 * would happen**, then decide. A registrar bringing in a thousand records typed over
 * several years needs to find the twelve bad rows before anything is written, not
 * afterwards.
 *
 * The screen is deliberately conservative about the commit. The default refuses a file
 * with any problem, because a partially applied import leaves someone reconciling
 * which rows landed; importing only the valid rows is available, but it is a choice
 * the person makes explicitly after seeing the count.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import type { ImportPreview, ImportResult } from '@sfs/shared';

import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as studentsApi from '../lib/students-api';

type Stage =
  | { readonly name: 'choose' }
  | { readonly name: 'previewed'; readonly preview: ImportPreview }
  | { readonly name: 'imported'; readonly result: ImportResult };

export function StudentImportPage(): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ name: 'choose' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);
  const [allowPartial, setAllowPartial] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(toFormError(cause));
    } finally {
      setBusy(false);
    }
  };

  const onPreview = (): void => {
    if (file === null) return;
    void run(async () => {
      const preview = await studentsApi.previewImport(file);
      setStage({ name: 'previewed', preview });
      setAllowPartial(false);
    });
  };

  const onCommit = (): void => {
    if (file === null) return;
    void run(async () => {
      const result = await studentsApi.commitImport(file, allowPartial);
      setStage({ name: 'imported', result });
    });
  };

  const reset = (): void => {
    setFile(null);
    setStage({ name: 'choose' });
    setError(null);
    setAllowPartial(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Import students from a file"
          description="Upload the school's existing list as a .csv or .xlsx file. Nothing is saved until you confirm."
        />
        <CardBody>
          {error !== null ? (
            <Alert
              variant="error"
              className="mb-4"
              {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
            >
              {error.message}
            </Alert>
          ) : null}

          {stage.name !== 'imported' ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="import-file"
                  className="text-sm font-medium text-slate-800 dark:text-slate-200"
                >
                  Student list
                </label>
                <input
                  id="import-file"
                  type="file"
                  accept=".csv,.xlsx"
                  className="text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-2 file:text-sm file:text-white dark:text-slate-300"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setStage({ name: 'choose' });
                    setError(null);
                  }}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  The first row must be headings. First name, last name and level are required;
                  section, gender, date of birth, guardian name and guardian phone are used if
                  present. Dates may be written 2012-04-18 or 18/04/2012.
                </p>
              </div>

              <div>
                <Button
                  onClick={onPreview}
                  disabled={file === null}
                  isLoading={busy}
                  loadingLabel="Checking"
                >
                  Check the file
                </Button>
              </div>
            </div>
          ) : null}

          {stage.name === 'previewed' ? (
            <PreviewReport
              preview={stage.preview}
              allowPartial={allowPartial}
              busy={busy}
              onAllowPartialChange={setAllowPartial}
              onCommit={onCommit}
            />
          ) : null}

          {stage.name === 'imported' ? (
            <ImportSummary result={stage.result} onReset={reset} />
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function PreviewReport({
  preview,
  allowPartial,
  busy,
  onAllowPartialChange,
  onCommit,
}: {
  readonly preview: ImportPreview;
  readonly allowPartial: boolean;
  readonly busy: boolean;
  readonly onAllowPartialChange: (value: boolean) => void;
  readonly onCommit: () => void;
}): React.JSX.Element {
  const hasIssues = preview.issues.length > 0;
  const canImport = preview.validRows > 0 && (!hasIssues || allowPartial);

  return (
    <section className="mt-6 flex flex-col gap-4 border-t border-slate-200 pt-6 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        What this file contains
      </h3>

      <dl className="grid grid-cols-3 gap-4 text-center">
        <Stat label="Rows" value={preview.totalRows} />
        <Stat label="Ready to import" value={preview.validRows} tone="ok" />
        <Stat
          label="Rows with problems"
          value={preview.rowsWithIssues}
          tone={preview.rowsWithIssues > 0 ? 'warn' : 'muted'}
        />
      </dl>

      {hasIssues ? (
        <div>
          <Alert variant="warning" title="Fix these rows, or import only the valid ones">
            The row numbers match the rows in your spreadsheet.
          </Alert>

          <div className="mt-3 max-h-80 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Problems found in the uploaded file</caption>
              <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Row
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Column
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Problem
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {preview.issues.map((issue, index) => (
                  <tr key={`${String(issue.row)}-${issue.column ?? 'row'}-${String(index)}`}>
                    <td className="px-3 py-2 font-mono text-xs">{issue.row}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                      {issue.column ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {issue.message}
                      {issue.value !== null ? (
                        <span className="ml-1 font-mono text-xs text-slate-500">
                          ({issue.value})
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.issuesTruncated ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Only the first {preview.issues.length} problems are listed. Fix these and check the
              file again.
            </p>
          ) : null}
        </div>
      ) : null}

      {preview.sample.length > 0 ? (
        <div>
          <h4 className="mb-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            The first rows, as they will be created
          </h4>
          <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">A sample of the rows that would be imported</caption>
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Level
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Class
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Guardian
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {preview.sample.map((row) => (
                  <tr key={row.row}>
                    <td className="px-3 py-2">
                      {row.lastName}, {row.firstName}
                    </td>
                    <td className="px-3 py-2">{row.levelCode}</td>
                    <td className="px-3 py-2">{row.classSectionCode ?? '—'}</td>
                    <td className="px-3 py-2">
                      {row.guardianName ?? '—'}
                      {row.guardianPhone !== null ? (
                        <span className="ml-1 text-xs text-slate-500">{row.guardianPhone}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {hasIssues ? (
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            className="mt-1"
            checked={allowPartial}
            onChange={(event) => {
              onAllowPartialChange(event.target.checked);
            }}
          />
          <span>
            Import the {preview.validRows} valid row{preview.validRows === 1 ? '' : 's'} and skip
            the rest. You will need to add the skipped students separately.
          </span>
        </label>
      ) : null}

      <div>
        <Button onClick={onCommit} disabled={!canImport} isLoading={busy} loadingLabel="Importing">
          Import {preview.validRows} student{preview.validRows === 1 ? '' : 's'}
        </Button>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone = 'muted',
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'ok' | 'warn' | 'muted';
}): React.JSX.Element {
  const tones = {
    ok: 'text-emerald-700 dark:text-emerald-300',
    warn: 'text-amber-700 dark:text-amber-300',
    muted: 'text-slate-900 dark:text-slate-100',
  } as const;

  return (
    <div className="rounded-md border border-slate-200 py-3 dark:border-slate-800">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={`text-2xl font-semibold ${tones[tone]}`}>{value}</dd>
    </div>
  );
}

function ImportSummary({
  result,
  onReset,
}: {
  readonly result: ImportResult;
  readonly onReset: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="success" title="Import complete">
        {result.studentsCreated} student{result.studentsCreated === 1 ? '' : 's'} added,{' '}
        {result.guardiansCreated} new guardian{result.guardiansCreated === 1 ? '' : 's'} created and{' '}
        {result.guardiansLinked} guardian link{result.guardiansLinked === 1 ? '' : 's'} recorded.
        Every student was enrolled into the current academic year.
      </Alert>

      {result.rowsRejected > 0 ? (
        <Alert variant="warning" title={`${String(result.rowsRejected)} row(s) were skipped`}>
          These students were not created. Fix them in your file and import it again, or add them
          one at a time.
        </Alert>
      ) : null}

      <div className="flex gap-2">
        <Link to="/students">
          <Button>See the students</Button>
        </Link>
        <Button variant="secondary" onClick={onReset}>
          Import another file
        </Button>
      </div>
    </div>
  );
}
