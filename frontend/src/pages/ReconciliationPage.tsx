/**
 * Reconciliation: what the bank says against what the school recorded.
 *
 * The screen is arranged as the work actually happens. A bursar arrives with a statement,
 * previews it, imports it, and then works down the lines the system could not attribute by
 * itself — accepting a suggestion, searching for a payment, or setting a line aside with a
 * reason.
 *
 * Three things the screen is careful about:
 *
 *  - **It shows both sides.** Unattributed lines are money the school holds and cannot
 *    explain; unreconciled payments are claims the bank has no record of. A screen showing
 *    only one would let the other accumulate unnoticed.
 *  - **It never presents a suggestion as a decision.** Each candidate is shown with the
 *    reason it was suggested, and whether the amount matches, so the bursar is accepting a
 *    statement of fact rather than a system's guess.
 *  - **Confirming is a separate, deliberate choice.** Matching says "this line is that
 *    payment"; confirming also credits the family's account, and the button says so.
 */
import { useState } from 'react';

import {
  PermissionKey,
  type PaymentProviderKeyValue,
  type StatementLineMatchStatusValue,
  type StatementLineSummary,
  type StatementMatchSuggestion,
} from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import { formatDate, formatMoney } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as reconciliationApi from '../lib/reconciliation-api';

const STATUS_LABELS: Record<StatementLineMatchStatusValue, string> = {
  UNMATCHED: 'Not attributed',
  MATCHED: 'Attributed',
  IGNORED: 'Set aside',
  AMBIGUOUS: 'Needs a decision',
};

export function ReconciliationPage(): React.JSX.Element {
  const { can } = useAuth();
  const mayImport = can(PermissionKey.RECONCILIATION_IMPORT_STATEMENT);
  const mayDecide = can(PermissionKey.RECONCILIATION_PERFORM);
  const mayConfirm = can(PermissionKey.PAYMENT_VERIFY_MANUAL);

  const [error, setError] = useState<FormErrorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [provider, setProvider] = useState<PaymentProviderKeyValue>('BANK_OF_KIGALI');
  const [accountLabel, setAccountLabel] = useState('');
  const [previewed, setPreviewed] = useState<Awaited<
    ReturnType<typeof reconciliationApi.previewStatement>
  > | null>(null);

  const [view, setView] = useState<StatementLineMatchStatusValue>('UNMATCHED');

  const summary = useAsyncResource(() => reconciliationApi.getReconciliationSummary(), []);
  const worklist = useAsyncResource(
    () => reconciliationApi.listLines({ matchStatus: view, pageSize: 50 }),
    [view],
  );

  const refreshAll = (): void => {
    summary.refresh();
    worklist.refresh();
  };

  const run = (action: () => Promise<unknown>, success: string): void => {
    setError(null);
    setNotice(null);
    setBusy(true);
    void action()
      .then(() => {
        setNotice(success);
        refreshAll();
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const preview = (): void => {
    if (file === null) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    void reconciliationApi
      .previewStatement(file)
      .then((result) => {
        setPreviewed(result);
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
        setPreviewed(null);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const commitImport = (): void => {
    if (file === null) return;
    run(
      () =>
        reconciliationApi
          .importStatement(file, {
            provider,
            ...(accountLabel.trim() === '' ? {} : { accountLabel: accountLabel.trim() }),
          })
          .then((result) => {
            setPreviewed(null);
            setFile(null);
            return result;
          }),
      'Statement imported. Lines whose reference and amount both matched have been attributed; nothing has been credited yet.',
    );
  };

  const accept = (
    line: StatementLineSummary,
    suggestion: StatementMatchSuggestion,
    confirmPayment: boolean,
  ): void => {
    if (
      confirmPayment &&
      !window.confirm(
        `Credit ${formatMoney(suggestion.amount)} to ${suggestion.studentName}?\n\n` +
          'This confirms the payment against the statement and changes what the family owes. ' +
          'It is recorded against your name.',
      )
    ) {
      return;
    }

    run(
      () =>
        reconciliationApi.matchLine(line.id, {
          expectedVersion: line.version,
          paymentId: suggestion.paymentId,
          confirmPayment,
          note: `Matched against ${line.narrative}.`,
        }),
      confirmPayment
        ? 'Matched and credited.'
        : 'Matched. The payment still needs confirming before it credits the balance.',
    );
  };

  const setAside = (line: StatementLineSummary): void => {
    const reason = window.prompt(
      'Why is this line not a student payment? A bank charge, a transfer between the ' +
        'school’s own accounts, a duplicate row. The reason is recorded permanently.',
    );
    if (reason === null || reason.trim() === '') return;

    run(
      () =>
        reconciliationApi.ignoreLine(line.id, {
          expectedVersion: line.version,
          reason: reason.trim(),
        }),
      'Set aside.',
    );
  };

  const withdraw = (line: StatementLineSummary): void => {
    const reason = window.prompt('Why is this attribution being withdrawn?');
    if (reason === null || reason.trim() === '') return;

    run(
      () =>
        reconciliationApi.unmatchLine(line.id, {
          expectedVersion: line.version,
          reason: reason.trim(),
        }),
      'Withdrawn. The line is back on the worklist.',
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {error !== null ? (
        <Alert
          variant="error"
          {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
        >
          {error.message}
        </Alert>
      ) : null}
      {notice !== null ? <Alert variant="success">{notice}</Alert> : null}

      {/* ------------------------------------------------------- both sides */}

      <DataState
        status={summary.status}
        data={summary.data}
        error={summary.error}
        onRetry={summary.refresh}
        loadingLabel="Loading the reconciliation position"
      >
        {(data) => (
          <Card>
            <CardHeader
              title="Reconciliation"
              description="The bank's record of money arriving, against the school's record of payments."
            />
            <CardBody>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Figure label="Attributed" value={formatMoney(data.matchedTotal)} />
                <Figure
                  label="Not attributed"
                  value={formatMoney(data.unmatchedTotal)}
                  emphasis={data.unmatchedLines > 0}
                />
                <Figure
                  label="Claims the bank has not confirmed"
                  value={formatMoney(data.unreconciledPaymentTotal)}
                  emphasis={data.unreconciledPayments > 0}
                />
                <Figure label="Money-in lines" value={String(data.statementLines)} />
              </dl>

              {data.unmatchedLines > 0 || data.ambiguousLines > 0 ? (
                <Alert variant="warning" className="mt-4">
                  {data.unmatchedLines + data.ambiguousLines} statement line(s) have not been
                  attributed to a payment. That is money the school holds and cannot yet explain.
                </Alert>
              ) : null}

              {data.unreconciledPayments > 0 ? (
                <Alert variant="info" className="mt-4">
                  {data.unreconciledPayments} payment claim(s) have no statement line behind them.
                  Either the money has not arrived, or the statement covering it has not been
                  imported.
                </Alert>
              ) : null}
            </CardBody>
          </Card>
        )}
      </DataState>

      {/* ---------------------------------------------------------- import */}

      {mayImport ? (
        <Card>
          <CardHeader
            title="Import a statement"
            description="Preview first. Nothing is stored until you import, and the same file cannot be imported twice."
          />
          <CardBody>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700 dark:text-slate-200">Bank</span>
                <select
                  className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value as PaymentProviderKeyValue);
                  }}
                >
                  <option value="BANK_OF_KIGALI">Bank of Kigali</option>
                  <option value="ZIGAMA_CSS">Zigama CSS</option>
                  <option value="UMWARIMU_SACCO">Umwarimu SACCO</option>
                </select>
              </label>

              <TextField
                label="Account"
                value={accountLabel}
                onChange={(event) => {
                  setAccountLabel(event.target.value);
                }}
                placeholder="Collection account 000123"
              />

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  Statement file
                </span>
                <input
                  type="file"
                  accept=".csv,.xlsx"
                  className="text-sm"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setPreviewed(null);
                  }}
                />
              </label>

              <Button variant="secondary" disabled={file === null || busy} onClick={preview}>
                Preview
              </Button>
              <Button disabled={previewed === null || busy} onClick={commitImport}>
                Import
              </Button>
            </div>

            {previewed !== null ? (
              <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Figure label="Rows" value={String(previewed.totalRows)} />
                  <Figure label="Money in" value={formatMoney(previewed.totalIn)} />
                  <Figure label="Money out" value={formatMoney(previewed.totalOut)} />
                  <Figure
                    label="Period"
                    value={
                      previewed.periodStart === null || previewed.periodEnd === null
                        ? '—'
                        : `${formatDate(previewed.periodStart)} – ${formatDate(previewed.periodEnd)}`
                    }
                  />
                </dl>

                <p className="mt-3 text-xs text-slate-500">
                  Check these totals against the statement in front of you before importing. If they
                  disagree, the export is wrong and no amount of reconciliation will find the
                  difference.
                </p>

                {previewed.alreadyImported ? (
                  <Alert variant="warning" className="mt-3">
                    This exact file has already been imported. Importing it again is refused.
                  </Alert>
                ) : null}

                {previewed.invalidRows > 0 ? (
                  <Alert variant="error" className="mt-3">
                    {previewed.invalidRows} row(s) cannot be read, so nothing will be imported.
                    Correct the export and try again.
                    <ul className="mt-2 list-disc pl-5">
                      {previewed.lines
                        .filter((line) => line.errors.length > 0)
                        .slice(0, 10)
                        .map((line) => (
                          <li key={line.lineNumber}>
                            Row {line.lineNumber}: {line.errors.join(' ')}
                          </li>
                        ))}
                    </ul>
                  </Alert>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* -------------------------------------------------------- worklist */}

      <Card>
        <CardHeader
          title="Statement lines"
          description="Work down the lines the system could not attribute by itself."
        />
        <CardBody>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Which lines to show">
            {(['UNMATCHED', 'AMBIGUOUS', 'MATCHED', 'IGNORED'] as const).map((status) => (
              <Button
                key={status}
                size="sm"
                variant={view === status ? 'primary' : 'secondary'}
                onClick={() => {
                  setView(status);
                }}
              >
                {STATUS_LABELS[status]}
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>

      <DataState
        status={worklist.status}
        data={worklist.data}
        error={worklist.error}
        onRetry={worklist.refresh}
        loadingLabel="Loading statement lines"
        isEmpty={(data) => data.lines.length === 0}
        emptyTitle={view === 'UNMATCHED' ? 'Every line has been accounted for' : 'No lines to show'}
        emptyDescription="Import a statement, or choose another view."
      >
        {(data) => (
          <ul className="flex flex-col gap-4">
            {data.lines.map((line) => (
              <li key={line.id}>
                <Card>
                  <CardBody>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {line.narrative}
                        </p>
                        <p className="text-xs text-slate-500">
                          {formatDate(line.valueDate)} · row {line.lineNumber}
                          {line.reference !== null ? ` · ${line.reference}` : ''} ·{' '}
                          {line.direction === 'MONEY_IN' ? 'money in' : 'money out'}
                        </p>
                        {line.matchNote !== null ? (
                          <p className="mt-1 text-xs text-slate-500">{line.matchNote}</p>
                        ) : null}
                      </div>

                      <div className="text-right">
                        <p className="font-medium tabular-nums">{formatMoney(line.amount)}</p>
                        <p className="text-xs text-slate-500">
                          {STATUS_LABELS[line.matchStatus]}
                          {line.matchedPaymentReference !== null
                            ? ` · ${line.matchedPaymentReference}`
                            : ''}
                          {line.matchedByName !== null ? ` · by ${line.matchedByName}` : ''}
                          {line.matchStatus === 'MATCHED' && line.matchedByName === null
                            ? ' · automatically'
                            : ''}
                        </p>
                      </div>
                    </div>

                    {/* The candidates, each with the reason it is being offered. */}
                    {mayDecide && (data.suggestions[line.id]?.length ?? 0) > 0 ? (
                      <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                        {(data.suggestions[line.id] ?? []).map((suggestion) => (
                          <li
                            key={suggestion.paymentId}
                            className="flex flex-wrap items-center justify-between gap-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {suggestion.studentName}{' '}
                                <span className="font-normal text-slate-500">
                                  {suggestion.reference}
                                </span>
                              </p>
                              <p className="text-xs text-slate-500">
                                {formatMoney(suggestion.amount)} · {suggestion.payerName} ·{' '}
                                {suggestion.reason}
                              </p>
                              {!suggestion.amountMatches ? (
                                <p className="text-xs text-amber-700 dark:text-amber-300">
                                  The amounts differ, so these two cannot be matched. Look at the
                                  payment instead.
                                </p>
                              ) : null}
                            </div>

                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy || !suggestion.amountMatches}
                                onClick={() => {
                                  accept(line, suggestion, false);
                                }}
                              >
                                Match
                              </Button>
                              {mayConfirm ? (
                                <Button
                                  size="sm"
                                  disabled={busy || !suggestion.amountMatches}
                                  onClick={() => {
                                    accept(line, suggestion, true);
                                  }}
                                >
                                  Match and credit
                                </Button>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {mayDecide ? (
                      <div className="mt-3 flex gap-2">
                        {line.matchStatus === 'MATCHED' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              withdraw(line);
                            }}
                          >
                            Withdraw attribution
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              setAside(line);
                            }}
                          >
                            Not a student payment
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </DataState>
    </div>
  );
}

function Figure({
  label,
  value,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd
        className={
          emphasis
            ? 'mt-1 text-lg font-semibold text-amber-700 tabular-nums dark:text-amber-300'
            : 'mt-1 text-lg font-semibold text-slate-900 tabular-nums dark:text-slate-100'
        }
      >
        {value}
      </dd>
    </div>
  );
}
