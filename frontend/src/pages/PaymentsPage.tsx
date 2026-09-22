/**
 * The payments table, and the queue of claims waiting for a bursar.
 *
 * Two audiences, one screen, because they are looking at the same records: a bursar works
 * the verification queue, and anyone with `payment.read` searches the history when a
 * parent rings up quoting a reference.
 *
 * What the screen will not do is compute anything. Every amount is a string the server
 * derived from the ledger, and the status shown is the status the server holds — a screen
 * that inferred "probably paid" from a provider response would be guessing about money
 * (Section 13A).
 *
 * The queue is deliberately the default view for a verifier. A pending claim is somebody's
 * money sitting unrecognised, and burying it behind a filter is how a payment ends up
 * unverified for a fortnight.
 */
import { useState } from 'react';

import { PermissionKey, type PaymentStatusValue, type PaymentSummary } from '@sfs/shared';
import { Link, useSearchParams } from 'react-router';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import { formatDateTime, formatMoney } from '../lib/format';
import * as paymentsApi from '../lib/payments-api';

/** What each status means to the person reading the row. */
const STATUS_LABELS: Record<PaymentStatusValue, string> = {
  PENDING: 'Awaiting verification',
  PROCESSING: 'With the provider',
  SUCCESSFUL: 'Verified',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REQUIRES_REVIEW: 'Needs review',
  REVERSED: 'Reversed',
  REFUNDED: 'Refunded',
};

const STATUS_TONES: Record<PaymentStatusValue, string> = {
  PENDING: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  PROCESSING: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  SUCCESSFUL: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  FAILED: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  CANCELLED: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REQUIRES_REVIEW: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  REVERSED: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REFUNDED: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export function PaymentStatusPill({ status }: { status: PaymentStatusValue }): React.JSX.Element {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_TONES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

type View = 'QUEUE' | 'REVIEW' | 'ALL';

export function PaymentsPage(): React.JSX.Element {
  const { can } = useAuth();
  const mayVerify = can(PermissionKey.PAYMENT_VERIFY_MANUAL);

  // `?studentId=` narrows the list to one student, which is how the student financial
  // screen links here. The server still decides which of them the caller may see: for a
  // parent asking about somebody else's child, the answer is an empty page.
  const [searchParams] = useSearchParams();
  const studentId = searchParams.get('studentId');

  // A verifier lands on their worklist; everyone else on the history they came to search.
  // Arriving with a student in the URL overrides that: the question being asked is "what
  // has this family paid?", not "what is waiting for me?".
  const [view, setView] = useState<View>(mayVerify && studentId === null ? 'QUEUE' : 'ALL');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);

  const filters = (): paymentsApi.PaymentFilters => {
    const base: paymentsApi.PaymentFilters = {
      page,
      pageSize: 25,
      ...(appliedSearch === '' ? {} : { search: appliedSearch }),
      ...(studentId !== null ? { studentId } : {}),
    };
    if (view === 'QUEUE') return { ...base, verificationMethod: 'MANUAL', status: 'PENDING' };
    if (view === 'REVIEW') return { ...base, status: 'REQUIRES_REVIEW' };
    return base;
  };

  const payments = useAsyncResource(
    () => paymentsApi.listPayments(filters()),
    [view, appliedSearch, page, studentId],
  );

  const changeView = (next: View): void => {
    setView(next);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Payments"
          description="Everything the school has been told about money arriving, and what has been confirmed."
        />
        <CardBody>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex gap-2" role="group" aria-label="Which payments to show">
              <Button
                variant={view === 'QUEUE' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  changeView('QUEUE');
                }}
              >
                Awaiting verification
              </Button>
              <Button
                variant={view === 'REVIEW' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  changeView('REVIEW');
                }}
              >
                Needs review
              </Button>
              <Button
                variant={view === 'ALL' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  changeView('ALL');
                }}
              >
                All payments
              </Button>
            </div>

            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setAppliedSearch(search.trim());
                setPage(1);
              }}
            >
              <TextField
                label="Search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder="Reference, payer or bank reference"
              />
              <Button type="submit" size="sm" variant="secondary">
                Search
              </Button>
            </form>
          </div>

          {view === 'REVIEW' ? (
            <Alert variant="info" className="mt-4">
              These payments did not add up — an amount that disagreed with the claim, or a
              confirmation that could not be read. Nothing here has been credited.
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <DataState
        status={payments.status}
        data={payments.data}
        error={payments.error}
        onRetry={payments.refresh}
        loadingLabel="Loading payments"
        isEmpty={(data) => data.data.length === 0}
        emptyTitle={view === 'QUEUE' ? 'Nothing is waiting to be verified' : 'No payments found'}
        emptyDescription={
          view === 'QUEUE'
            ? 'Claims recorded by a bursar or submitted by a parent appear here until somebody confirms them against a statement.'
            : 'Try a different search, or switch to all payments.'
        }
      >
        {(data) => (
          <Card>
            <CardBody>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Payments</caption>
                  <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-700">
                    <tr>
                      <th className="py-2">Reference</th>
                      <th className="py-2">Student</th>
                      <th className="py-2">Method</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2">Status</th>
                      <th className="py-2">Started</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.data.map((payment: PaymentSummary) => (
                      <tr key={payment.id}>
                        <td className="py-2 font-mono text-xs">{payment.reference}</td>
                        <td className="py-2">
                          <span className="block">{payment.studentName}</span>
                          <span className="text-xs text-slate-500">{payment.studentNumber}</span>
                        </td>
                        <td className="py-2 text-slate-500">
                          {payment.method.toLowerCase().replace(/_/g, ' ')}
                          {payment.providerKey !== null ? (
                            <span className="block text-xs">
                              {payment.providerKey.toLowerCase().replace(/_/g, ' ')}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 text-right font-medium tabular-nums">
                          {formatMoney(payment.amount)}
                        </td>
                        <td className="py-2">
                          <PaymentStatusPill status={payment.status} />
                        </td>
                        <td className="py-2 text-slate-500">
                          {formatDateTime(payment.initiatedAt)}
                        </td>
                        <td className="py-2 text-right">
                          <Link
                            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
                            to={`/payments/${payment.id}`}
                          >
                            {mayVerify && payment.status === 'PENDING' ? 'Verify' : 'Open'}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
                <span>
                  Showing {data.data.length} of {data.meta.totalItems} · page {data.meta.page} of{' '}
                  {data.meta.totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={data.meta.page <= 1}
                    onClick={() => {
                      setPage((current) => Math.max(1, current - 1));
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={data.meta.page >= data.meta.totalPages}
                    onClick={() => {
                      setPage((current) => current + 1);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        )}
      </DataState>
    </div>
  );
}
