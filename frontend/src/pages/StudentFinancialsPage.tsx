/**
 * One student's financial account.
 *
 * The screen a bursar opens when a parent is standing in front of them, so it answers
 * the questions in the order they get asked: what is owed, what was charged, what was
 * taken off and why, and — for the argument that follows — the ledger line by line.
 *
 * Every figure here is rendered from a string the backend computed. Nothing on this page
 * adds up a column: a total shown beside its parts that was derived differently from
 * them is how a screen ends up disagreeing with itself (Section 13A).
 *
 * The four kinds of relief are visually distinguished rather than merged into one
 * "adjustment" label, because a waiver and a discount mean different things to the
 * person being told about them.
 */
import { useState } from 'react';

import { PermissionKey, type ReliefKind, type ReliefSummary } from '@sfs/shared';
import { Link, useParams } from 'react-router';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import * as feesApi from '../lib/fees-api';
import { formatDateTime, formatMoney } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';

const RELIEF_LABELS: Record<ReliefKind, string> = {
  DISCOUNT: 'Discount',
  SCHOLARSHIP: 'Scholarship',
  WAIVER: 'Waiver',
  ADJUSTMENT: 'Adjustment',
};

export function StudentFinancialsPage(): React.JSX.Element {
  const { studentId = '' } = useParams<{ studentId: string }>();
  const { can } = useAuth();
  const mayRequest = can(PermissionKey.ADJUSTMENT_REQUEST);
  const mayApprove = can(PermissionKey.ADJUSTMENT_APPROVE);

  const [error, setError] = useState<FormErrorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const financials = useAsyncResource(() => feesApi.getStudentFinancials(studentId), [studentId]);

  const [reliefKind, setReliefKind] = useState<ReliefKind>('DISCOUNT');
  const [reliefChargeId, setReliefChargeId] = useState('');
  const [reliefAmount, setReliefAmount] = useState('');
  const [reliefReason, setReliefReason] = useState('');

  const run = (action: () => Promise<unknown>, success: string): void => {
    setError(null);
    setNotice(null);
    void action()
      .then(() => {
        setNotice(success);
        financials.refresh();
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      });
  };

  const requestRelief = (): void => {
    const data = financials.data;
    if (data === null || data === undefined) return;
    const charge = data.charges.find((candidate) => candidate.id === reliefChargeId);
    if (charge === undefined) return;

    run(
      () =>
        feesApi.requestRelief(reliefKind, {
          studentId,
          studentChargeId: reliefChargeId,
          academicYearId: charge.academicYearId,
          amount: reliefAmount,
          reason: reliefReason,
        }),
      `Requested a ${RELIEF_LABELS[reliefKind].toLowerCase()}. It moves no money until a Finance Manager approves it.`,
    );
    setReliefAmount('');
    setReliefReason('');
  };

  const decide = (relief: ReliefSummary, decision: 'APPROVE' | 'REJECT'): void => {
    const verb = decision === 'APPROVE' ? 'Approve' : 'Reject';
    if (
      !window.confirm(
        `${verb} this ${RELIEF_LABELS[relief.kind].toLowerCase()} of ${formatMoney(relief.amount)}?\n\n` +
          (decision === 'APPROVE'
            ? 'This changes what the family owes and is recorded permanently against your name.'
            : 'The request will be closed and nothing will be credited.'),
      )
    ) {
      return;
    }

    run(
      () =>
        feesApi.decideRelief(relief.kind, relief.id, {
          expectedVersion: relief.version,
          decision,
        }),
      decision === 'APPROVE' ? 'Approved.' : 'Rejected.',
    );
  };

  const reverse = (relief: ReliefSummary): void => {
    const reason = window.prompt(
      `Reverse this ${RELIEF_LABELS[relief.kind].toLowerCase()} of ${formatMoney(relief.amount)}?\n\nGive a reason — it is recorded permanently.`,
    );
    if (reason === null || reason.trim() === '') return;

    run(
      () =>
        feesApi.reverseRelief(relief.kind, relief.id, {
          expectedVersion: relief.version,
          reason,
        }),
      'Reversed. The original decision is kept, and an opposing ledger entry has been posted.',
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

      <DataState
        status={financials.status}
        data={financials.data}
        error={financials.error}
        onRetry={financials.refresh}
        loadingLabel="Loading the student's account"
      >
        {(data) => (
          <>
            {/* ------------------------------------------------- the balance */}

            <Card>
              <CardHeader
                title={`${data.balance.studentName} — financial account`}
                description={data.balance.studentNumber}
              />
              <CardBody>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Figure label="Charged" value={formatMoney(data.balance.totalCharged)} />
                  <Figure label="Relief applied" value={formatMoney(data.balance.totalCredited)} />
                  <Figure label="Paid" value={formatMoney(data.balance.totalPaid)} />
                  {data.balance.creditBalance === '0.00' ? (
                    <Figure
                      label="Outstanding"
                      value={formatMoney(data.balance.outstanding)}
                      emphasis
                    />
                  ) : (
                    <Figure
                      label="In credit"
                      value={formatMoney(data.balance.creditBalance)}
                      emphasis
                    />
                  )}
                </dl>

                {data.balance.pendingApprovalCount > 0 ? (
                  <Alert variant="info" className="mt-4">
                    {data.balance.pendingApprovalCount} request(s) awaiting approval. They are not
                    included in any figure above.
                  </Alert>
                ) : null}

                <p className="mt-4 text-xs text-slate-500">
                  The outstanding figure is charges plus authorised surcharges, less approved relief
                  and verified payments. A payment counts here only once somebody has verified it.
                </p>

                <p className="mt-2 text-sm">
                  <Link
                    className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                    to={`/payments?studentId=${studentId}`}
                  >
                    See this student&rsquo;s payments, including anything still awaiting
                    verification
                  </Link>
                </p>
              </CardBody>
            </Card>

            {/* ------------------------------------------------------ charges */}

            <Card>
              <CardHeader
                title="Charges"
                description="What this student has been billed. A charge is never edited — relief sits beside it."
              />
              <CardBody>
                {data.charges.length === 0 ? (
                  <p className="text-sm text-slate-500">No charges have been raised yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-700">
                        <tr>
                          <th className="py-2">Description</th>
                          <th className="py-2">Period</th>
                          <th className="py-2 text-right">Charged</th>
                          <th className="py-2 text-right">Relief</th>
                          <th className="py-2 text-right">Net</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {data.charges.map((charge) => (
                          <tr
                            key={charge.id}
                            className={charge.status === 'VOID' ? 'text-slate-400' : ''}
                          >
                            <td className="py-2">
                              {charge.description}
                              {charge.status === 'VOID' ? (
                                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">
                                  Voided
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2 text-slate-500">
                              {charge.academicYearName}
                              {charge.termName !== null ? ` · ${charge.termName}` : ''}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoney(charge.amount)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {charge.adjustedAmount === '0.00'
                                ? '—'
                                : `−${formatMoney(charge.adjustedAmount)}`}
                            </td>
                            <td className="py-2 text-right font-medium tabular-nums">
                              {formatMoney(charge.netAmount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>

            {/* ------------------------------------------------------- relief */}

            <Card>
              <CardHeader
                title="Discounts, scholarships, waivers and adjustments"
                description="Nothing here changes a balance until it is approved."
              />
              <CardBody>
                {data.reliefs.length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing has been requested.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.reliefs.map((relief) => (
                      <li key={`${relief.kind}-${relief.id}`} className="py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-slate-900 dark:text-slate-100">
                              {relief.scholarshipName ?? RELIEF_LABELS[relief.kind]}
                              {relief.direction === 'DEBIT' ? ' (additional charge)' : ''}
                            </p>
                            <p className="text-sm text-slate-500">{relief.reason}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              Requested by {relief.requestedByName} ·{' '}
                              {formatDateTime(relief.requestedAt)}
                              {relief.decidedByName !== null
                                ? ` · decided by ${relief.decidedByName}`
                                : ''}
                            </p>
                          </div>

                          <div className="flex items-center gap-3">
                            <span className="font-medium tabular-nums">
                              {relief.direction === 'DEBIT' ? '+' : '−'}
                              {formatMoney(relief.amount)}
                            </span>
                            <ReliefStatusPill status={relief.status} />
                          </div>
                        </div>

                        {mayApprove && relief.status === 'PENDING_APPROVAL' ? (
                          <div className="mt-2 flex gap-2">
                            <Button
                              onClick={() => {
                                decide(relief, 'APPROVE');
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => {
                                decide(relief, 'REJECT');
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        ) : null}

                        {mayApprove && relief.status === 'APPROVED' ? (
                          <div className="mt-2">
                            <Button
                              variant="danger"
                              onClick={() => {
                                reverse(relief);
                              }}
                            >
                              Reverse
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {mayRequest && data.charges.length > 0 ? (
                  <form
                    className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800"
                    onSubmit={(event) => {
                      event.preventDefault();
                      requestRelief();
                    }}
                  >
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-slate-700 dark:text-slate-200">Kind</span>
                      <select
                        className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                        value={reliefKind}
                        onChange={(event) => {
                          setReliefKind(event.target.value as ReliefKind);
                        }}
                      >
                        <option value="DISCOUNT">Discount</option>
                        <option value="WAIVER">Waiver</option>
                        <option value="ADJUSTMENT">Adjustment</option>
                      </select>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-slate-700 dark:text-slate-200">
                        Against
                      </span>
                      <select
                        className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                        value={reliefChargeId}
                        onChange={(event) => {
                          setReliefChargeId(event.target.value);
                        }}
                        required
                      >
                        <option value="">Select a charge</option>
                        {data.charges
                          .filter((charge) => charge.status === 'RAISED')
                          .map((charge) => (
                            <option key={charge.id} value={charge.id}>
                              {charge.description} ({formatMoney(charge.netAmount)} left)
                            </option>
                          ))}
                      </select>
                    </label>

                    <TextField
                      label="Amount"
                      value={reliefAmount}
                      onChange={(event) => {
                        setReliefAmount(event.target.value);
                      }}
                      inputMode="decimal"
                      placeholder="10000.00"
                      required
                    />

                    <TextField
                      label="Reason"
                      value={reliefReason}
                      onChange={(event) => {
                        setReliefReason(event.target.value);
                      }}
                      placeholder="Sibling rate agreed with the head teacher"
                      required
                    />

                    <Button type="submit">Request</Button>
                  </form>
                ) : null}
              </CardBody>
            </Card>

            {/* ------------------------------------------------------ ledger */}

            <Card>
              <CardHeader
                title="Ledger"
                description="Every movement on this account, oldest first. This is what the balance is computed from."
              />
              <CardBody>
                {data.entries.length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing has been posted yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-700">
                        <tr>
                          <th className="py-2">Posted</th>
                          <th className="py-2">Description</th>
                          <th className="py-2">Source</th>
                          <th className="py-2 text-right">Debit</th>
                          <th className="py-2 text-right">Credit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {data.entries.map((entry) => (
                          <tr key={entry.id}>
                            <td className="py-2 text-slate-500">
                              {formatDateTime(entry.postedAt)}
                            </td>
                            <td className="py-2">
                              {entry.description}
                              {entry.reversalOfEntryId !== null ? (
                                <span className="ml-2 text-xs text-slate-500">(reversal)</span>
                              ) : null}
                            </td>
                            <td className="py-2 text-slate-500">
                              {entry.source.charAt(0) + entry.source.slice(1).toLowerCase()}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {entry.entryType === 'DEBIT' ? formatMoney(entry.amount) : ''}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {entry.entryType === 'CREDIT' ? formatMoney(entry.amount) : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>
          </>
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
  label: string;
  value: string;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd
        className={
          emphasis
            ? 'text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100'
            : 'text-lg tabular-nums text-slate-700 dark:text-slate-300'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function ReliefStatusPill({ status }: { status: string }): React.JSX.Element {
  const styles: Record<string, string> = {
    PENDING_APPROVAL: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    APPROVED: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    REJECTED: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    CANCELLED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    REVERSED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  };

  const label = status
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? styles.CANCELLED ?? ''}`}
    >
      {label}
    </span>
  );
}
