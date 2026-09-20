/**
 * Raising a term's charges.
 *
 * The highest-consequence screen in Phase 4: one click can create a thousand financial
 * obligations. It is therefore built as preview-then-apply, and the apply button does
 * not appear until a preview has been run — you cannot bill a term from this page
 * without first having been shown what it would do.
 *
 * Conflicts are rendered as a blocking error rather than a warning. Two structures
 * charging the same category to the same student is a configuration mistake, and the
 * run refuses it server-side; showing it as something dismissible would misrepresent
 * what happens next.
 */
import { useState } from 'react';

import { PermissionKey, type ChargeRunPreview } from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { useAsyncResource } from '../hooks/use-async-resource';
import * as academicApi from '../lib/academic-api';
import * as feesApi from '../lib/fees-api';
import { formatMoney } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';

export function ChargeRunPage(): React.JSX.Element {
  const { can } = useAuth();
  const mayRaise = can(PermissionKey.CHARGE_CREATE);

  const years = useAsyncResource(() => academicApi.listAcademicYears(), []);

  const [yearId, setYearId] = useState('');
  const [termId, setTermId] = useState('');
  const [preview, setPreview] = useState<ChargeRunPreview | null>(null);
  const [error, setError] = useState<FormErrorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedYear = (years.data ?? []).find((year) => year.id === yearId) ?? null;
  const currentYear = (years.data ?? []).find((year) => year.isCurrent) ?? null;

  /**
   * `keepNotice` is set when this runs as the refresh after a successful apply: the
   * refresh must not wipe the message telling the bursar what was just raised.
   */
  const runPreview = (options: { keepNotice?: boolean } = {}): void => {
    setError(null);
    if (options.keepNotice !== true) setNotice(null);
    setBusy(true);
    void feesApi
      .previewChargeRun({ academicYearId: yearId, termId: termId === '' ? null : termId })
      .then((result) => {
        setPreview(result);
      })
      .catch((cause: unknown) => {
        setPreview(null);
        setError(toFormError(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const apply = (): void => {
    if (preview === null) return;
    if (
      !window.confirm(
        `Raise ${String(preview.chargesToCreate)} charge(s) totalling ${formatMoney(preview.totalAmount)}?\n\n` +
          'This creates real financial obligations for these students. Charges raised in error must be voided individually by a Finance Manager.',
      )
    ) {
      return;
    }

    setError(null);
    setBusy(true);
    void feesApi
      .applyChargeRun({ academicYearId: yearId, termId: termId === '' ? null : termId })
      .then((result) => {
        setNotice(
          `Raised ${String(result.chargesCreated)} charge(s) totalling ${formatMoney(result.totalAmount)}. ` +
            `${String(result.chargesSkipped)} already existed and were skipped.`,
        );
        // Re-previewed so the screen now shows the post-run state: everything skipped,
        // nothing left to create. Leaving the old preview up would invite a second run.
        runPreview({ keepNotice: true });
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="flex flex-col gap-6">
      {error !== null ? (
        <Alert
          variant="error"
          title="The run did not proceed"
          {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
        >
          {error.message}
        </Alert>
      ) : null}

      {notice !== null ? <Alert variant="success">{notice}</Alert> : null}

      <Card>
        <CardHeader
          title="Raise charges"
          description="Applies every published fee structure for the period to the students it matches. Running it twice is safe — a student already charged is skipped."
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-200">Academic year</span>
              <select
                className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                value={yearId}
                onChange={(event) => {
                  setYearId(event.target.value);
                  setTermId('');
                  setPreview(null);
                }}
              >
                <option value="">Select a year</option>
                {(years.data ?? []).map((year) => (
                  <option key={year.id} value={year.id}>
                    {year.name}
                    {year.isCurrent ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-200">Term</span>
              <select
                className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                value={termId}
                onChange={(event) => {
                  setTermId(event.target.value);
                  setPreview(null);
                }}
              >
                <option value="">Once-per-year fees</option>
                {(selectedYear?.terms ?? []).map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name}
                    {term.isCurrent ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <Button
              onClick={() => {
                runPreview();
              }}
              disabled={yearId === '' || busy}
            >
              Preview
            </Button>
          </div>

          {currentYear === null && years.status === 'success' ? (
            <Alert variant="warning" className="mt-4">
              No academic year is current. Charges can still be raised into a named year, but most
              other screens will not work until one is set.
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      {preview !== null ? (
        <Card>
          <CardHeader
            title="What this run would do"
            description="Nothing has been written. Review the figures before applying."
          />
          <CardBody>
            {preview.conflicts.length > 0 ? (
              <Alert variant="error" title="Two fee structures overlap">
                <p>
                  These would charge the same category twice to the same students. The run will
                  refuse until one structure is narrowed or archived.
                </p>
                <ul className="mt-2 list-disc pl-5">
                  {preview.conflicts.map((conflict) => (
                    <li key={conflict.feeCategoryName}>
                      <strong>{conflict.feeCategoryName}</strong> in{' '}
                      {conflict.feeStructureNames.join(' and ')} — {conflict.affectedStudentCount}{' '}
                      student(s) affected
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Students matched" value={String(preview.studentsMatched)} />
              <Figure label="Charges to create" value={String(preview.chargesToCreate)} />
              <Figure label="Already charged" value={String(preview.chargesToSkip)} />
              <Figure label="Total" value={formatMoney(preview.totalAmount)} />
            </dl>

            {preview.sample.length > 0 ? (
              <div className="mt-6 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-700">
                    <tr>
                      <th className="py-2">Student</th>
                      <th className="py-2">Fee</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {preview.sample.map((line, index) => (
                      <tr key={`${line.studentId}-${line.description}-${String(index)}`}>
                        <td className="py-2">
                          {line.studentName}{' '}
                          <span className="font-mono text-xs text-slate-500">
                            {line.studentNumber}
                          </span>
                        </td>
                        <td className="py-2">{line.description}</td>
                        <td className="py-2 text-right tabular-nums">{formatMoney(line.amount)}</td>
                        <td className="py-2 text-slate-500">
                          {line.alreadyCharged ? 'Already charged' : 'Will be raised'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.sampleTruncated ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Showing the first {preview.sample.length} of {preview.studentsMatched} matched
                    students.
                  </p>
                ) : null}
              </div>
            ) : null}

            {mayRaise && preview.conflicts.length === 0 && preview.chargesToCreate > 0 ? (
              <div className="mt-6">
                <Button onClick={apply} disabled={busy}>
                  Raise {preview.chargesToCreate} charge(s)
                </Button>
              </div>
            ) : null}

            {preview.chargesToCreate === 0 && preview.conflicts.length === 0 ? (
              <Alert variant="info" className="mt-4">
                There is nothing to raise for this period. Every matched student already holds these
                charges.
              </Alert>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </dd>
    </div>
  );
}
