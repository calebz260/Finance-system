/**
 * One payment, and the decisions a person can take about it.
 *
 * This is the screen where money is confirmed, so its job is to make the decision
 * accountable rather than quick:
 *
 *  - The verifier types **what the statement says**, and the field is empty. Pre-filling
 *    it with the claimed amount would turn a comparison into a formality, and the whole
 *    reason the server asks for the figure is that the two can differ (Section 20).
 *  - Rejecting and holding require a reason, and the form says it is kept permanently,
 *    because it is.
 *  - Reversing or refunding is presented apart from verification, in a destructive-looking
 *    block, and asks for confirmation naming the amount. Both keep the original payment
 *    and post an opposing ledger entry; neither deletes anything (ADR-022).
 *
 * Proof of payment is downloaded through the API with the viewer's own credentials rather
 * than linked to, so a document cannot be forwarded to somebody who may not see it.
 */
import { useState } from 'react';

import {
  PermissionKey,
  type PaymentEvidenceKindValue,
  type PaymentEvidenceSummary,
} from '@sfs/shared';
import { Link, useParams } from 'react-router';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import { formatDateTime, formatMoney } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as paymentsApi from '../lib/payments-api';
import { PaymentStatusPill } from './PaymentsPage';

const EVIDENCE_LABELS: Record<PaymentEvidenceKindValue, string> = {
  BANK_SLIP: 'Bank slip',
  TRANSFER_CONFIRMATION: 'Transfer confirmation',
  REMITTANCE_ADVICE: 'Remittance advice',
  OTHER: 'Other document',
};

export function PaymentDetailPage(): React.JSX.Element {
  const { paymentId = '' } = useParams<{ paymentId: string }>();
  const { can } = useAuth();
  const mayVerify = can(PermissionKey.PAYMENT_VERIFY_MANUAL);
  const mayReverse = can(PermissionKey.PAYMENT_REVERSE);
  const mayRefund = can(PermissionKey.PAYMENT_REFUND);
  const mayUpload =
    can(PermissionKey.PAYMENT_RECORD_MANUAL_CLAIM) || can(PermissionKey.OWN_PAYMENT_INITIATE);

  const [error, setError] = useState<FormErrorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [confirmedAmount, setConfirmedAmount] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [note, setNote] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<PaymentEvidenceKindValue>('BANK_SLIP');
  const [busy, setBusy] = useState(false);

  const detail = useAsyncResource(() => paymentsApi.getPayment(paymentId), [paymentId]);

  const run = (action: () => Promise<unknown>, success: string): void => {
    setError(null);
    setNotice(null);
    setBusy(true);
    void action()
      .then(() => {
        setNotice(success);
        detail.refresh();
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const decide = (decision: 'CONFIRM' | 'REJECT' | 'HOLD', version: number): void => {
    if (decision === 'CONFIRM') {
      run(
        () =>
          paymentsApi.verifyPayment(paymentId, {
            expectedVersion: version,
            decision: 'CONFIRM',
            confirmedAmount,
            ...(externalReference.trim() === ''
              ? {}
              : { externalReference: externalReference.trim() }),
            ...(note.trim() === '' ? {} : { note: note.trim() }),
          }),
        'Recorded. If the figures matched, the balance has been updated; if they did not, the payment is held for review.',
      );
      return;
    }

    const reason = window.prompt(
      decision === 'REJECT'
        ? 'Why is this payment being rejected? The reason is recorded permanently.'
        : 'Why is this payment being held for review? The reason is recorded permanently.',
    );
    if (reason === null || reason.trim() === '') return;

    run(
      () =>
        paymentsApi.verifyPayment(paymentId, {
          expectedVersion: version,
          decision,
          reason: reason.trim(),
        }),
      decision === 'REJECT' ? 'Rejected. Nothing was credited.' : 'Held for review.',
    );
  };

  const undo = (kind: 'REVERSAL' | 'REFUND', version: number, amount: string): void => {
    const reason = window.prompt(
      `${kind === 'REFUND' ? 'Refund' : 'Reverse'} ${formatMoney(amount)}?\n\n` +
        (kind === 'REFUND'
          ? 'Use this when the money arrived and has been sent back to the payer.'
          : 'Use this when the money never really arrived.') +
        '\n\nGive a reason — it is recorded permanently.',
    );
    if (reason === null || reason.trim() === '') return;

    run(
      () =>
        paymentsApi.reversePayment(paymentId, {
          expectedVersion: version,
          kind,
          reason: reason.trim(),
        }),
      'Recorded. The original payment is kept and an opposing ledger entry has been posted.',
    );
  };

  const upload = (file: File): void => {
    run(
      () => paymentsApi.uploadEvidence(paymentId, file, evidenceKind),
      'Document attached. Any earlier document of the same kind is kept and marked as superseded.',
    );
  };

  const download = (evidence: PaymentEvidenceSummary): void => {
    setError(null);
    void paymentsApi
      .downloadEvidence(paymentId, evidence.id)
      .then((blob) => {
        // An object URL, revoked immediately after the click: the bytes came from an
        // authenticated request and the temporary URL should not outlive the download.
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = evidence.fileName;
        anchor.click();
        URL.revokeObjectURL(url);
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      });
  };

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/payments"
        className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        ← All payments
      </Link>

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
        status={detail.status}
        data={detail.data}
        error={detail.error}
        onRetry={detail.refresh}
        loadingLabel="Loading the payment"
      >
        {(data) => {
          const payment = data.payment;
          const decidable =
            mayVerify &&
            (payment.status === 'PENDING' ||
              payment.status === 'PROCESSING' ||
              payment.status === 'REQUIRES_REVIEW');
          const undoable = payment.status === 'SUCCESSFUL' && (mayReverse || mayRefund);

          return (
            <>
              <Card>
                <CardHeader
                  title={`${formatMoney(payment.amount)} — ${payment.studentName}`}
                  description={`${payment.reference} · ${payment.studentNumber}`}
                />
                <CardBody>
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Figure label="Status" value={<PaymentStatusPill status={payment.status} />} />
                    <Figure
                      label="Method"
                      value={payment.method.toLowerCase().replace(/_/g, ' ')}
                    />
                    <Figure
                      label="Confirmed by"
                      value={
                        payment.verificationMethod === 'PROVIDER' ? 'The provider' : 'A bursar'
                      }
                    />
                    <Figure label="Payer" value={payment.payerName} />
                    <Figure
                      label="Period"
                      value={`${payment.academicYearName}${payment.termName !== null ? ` · ${payment.termName}` : ''}`}
                    />
                    <Figure label="Started" value={formatDateTime(payment.initiatedAt)} />
                    <Figure label="Recorded by" value={payment.initiatedByName} />
                    <Figure label="Bank reference" value={payment.externalReference ?? '—'} />
                  </dl>

                  {payment.verifiedByName !== null && payment.verifiedAt !== null ? (
                    <p className="mt-4 text-sm text-slate-500">
                      Verified by {payment.verifiedByName} on {formatDateTime(payment.verifiedAt)}.
                    </p>
                  ) : null}

                  {payment.failureReason !== null ? (
                    <Alert variant="warning" className="mt-4">
                      {payment.failureReason}
                    </Alert>
                  ) : null}

                  {payment.reversalReason !== null ? (
                    <Alert variant="warning" className="mt-4">
                      {payment.status === 'REFUNDED' ? 'Refunded' : 'Reversed'} by{' '}
                      {payment.reversedByName ?? 'unknown'}: {payment.reversalReason}
                    </Alert>
                  ) : null}

                  {payment.status === 'PENDING' || payment.status === 'PROCESSING' ? (
                    <Alert variant="info" className="mt-4">
                      Nothing has been credited yet. A balance changes only when a payment is
                      verified.
                    </Alert>
                  ) : null}

                  <p className="mt-4 text-sm">
                    <Link
                      className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                      to={`/students/${payment.studentId}/financials`}
                    >
                      Open this student&rsquo;s financial account
                    </Link>
                  </p>
                </CardBody>
              </Card>

              {/* --------------------------------------------- verification */}

              {decidable ? (
                <Card>
                  <CardHeader
                    title="Verify against the statement"
                    description="Type what the statement or the cash actually shows. It is compared with the claim rather than assumed to match it."
                  />
                  <CardBody>
                    <form
                      className="flex flex-wrap items-end gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        decide('CONFIRM', payment.version);
                      }}
                    >
                      <TextField
                        label="Amount on the statement"
                        value={confirmedAmount}
                        onChange={(event) => {
                          setConfirmedAmount(event.target.value);
                        }}
                        inputMode="decimal"
                        placeholder="50000.00"
                        required
                      />
                      <TextField
                        label="Statement reference"
                        value={externalReference}
                        onChange={(event) => {
                          setExternalReference(event.target.value);
                        }}
                        placeholder="BK-99881"
                      />
                      <TextField
                        label="Note"
                        value={note}
                        onChange={(event) => {
                          setNote(event.target.value);
                        }}
                        placeholder="Matched against the statement of 21 September"
                      />

                      <Button type="submit" disabled={busy}>
                        Confirm and credit
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          decide('HOLD', payment.version);
                        }}
                      >
                        Hold for review
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          decide('REJECT', payment.version);
                        }}
                      >
                        Reject
                      </Button>
                    </form>

                    <p className="mt-3 text-xs text-slate-500">
                      Confirming credits {payment.studentName}&rsquo;s account and is recorded
                      against your name. You cannot confirm a claim you recorded yourself.
                    </p>
                  </CardBody>
                </Card>
              ) : null}

              {/* --------------------------------------------------- undoing */}

              {undoable ? (
                <Card>
                  <CardHeader
                    title="Undo this payment"
                    description="Nothing is deleted. An opposing ledger entry is posted and the original payment is kept."
                  />
                  <CardBody className="flex flex-wrap gap-3">
                    {mayReverse ? (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          undo('REVERSAL', payment.version, payment.amount);
                        }}
                      >
                        Reverse — the money never arrived
                      </Button>
                    ) : null}
                    {mayRefund ? (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          undo('REFUND', payment.version, payment.amount);
                        }}
                      >
                        Refund — the money was sent back
                      </Button>
                    ) : null}
                  </CardBody>
                </Card>
              ) : null}

              {/* ------------------------------------------ proof of payment */}

              <Card>
                <CardHeader
                  title="Proof of payment"
                  description="Replacing a document keeps the old one on the record, marked as superseded."
                />
                <CardBody>
                  {data.evidence.length === 0 ? (
                    <p className="text-sm text-slate-500">Nothing has been attached.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                      {data.evidence.map((evidence) => (
                        <li
                          key={evidence.id}
                          className="flex flex-wrap items-center justify-between gap-3 py-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                              {evidence.fileName}
                              {!evidence.isCurrent ? (
                                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">
                                  Superseded
                                </span>
                              ) : null}
                            </p>
                            <p className="text-xs text-slate-500">
                              {EVIDENCE_LABELS[evidence.kind]} · uploaded by{' '}
                              {evidence.uploadedByName} · {formatDateTime(evidence.uploadedAt)}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              download(evidence);
                            }}
                          >
                            Download
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {mayUpload &&
                  (payment.status === 'PENDING' ||
                    payment.status === 'PROCESSING' ||
                    payment.status === 'REQUIRES_REVIEW') ? (
                    <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium text-slate-700 dark:text-slate-200">
                          Document kind
                        </span>
                        <select
                          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                          value={evidenceKind}
                          onChange={(event) => {
                            setEvidenceKind(event.target.value as PaymentEvidenceKindValue);
                          }}
                        >
                          <option value="BANK_SLIP">Bank slip</option>
                          <option value="TRANSFER_CONFIRMATION">Transfer confirmation</option>
                          <option value="REMITTANCE_ADVICE">Remittance advice</option>
                          <option value="OTHER">Other document</option>
                        </select>
                      </label>

                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium text-slate-700 dark:text-slate-200">File</span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          className="text-sm"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file !== undefined) upload(file);
                            event.target.value = '';
                          }}
                        />
                      </label>

                      <p className="w-full text-xs text-slate-500">
                        A photograph of the slip or a one-page PDF. The file is stored where it
                        cannot be reached without signing in.
                      </p>
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              {/* ------------------------------------------- provider attempts */}

              {data.transactions.length > 0 ? (
                <Card>
                  <CardHeader
                    title="Provider attempts"
                    description="What the school asked the provider to collect, and what it answered."
                  />
                  <CardBody>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-700">
                          <tr>
                            <th className="py-2">Reference</th>
                            <th className="py-2">Provider id</th>
                            <th className="py-2 text-right">Requested</th>
                            <th className="py-2 text-right">Confirmed</th>
                            <th className="py-2">Outcome</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {data.transactions.map((transaction) => (
                            <tr key={transaction.id}>
                              <td className="py-2 font-mono text-xs">
                                {transaction.internalReference}
                              </td>
                              <td className="py-2 font-mono text-xs">
                                {transaction.providerTransactionId ?? '—'}
                              </td>
                              <td className="py-2 text-right tabular-nums">
                                {formatMoney(transaction.requestedAmount)}
                              </td>
                              <td className="py-2 text-right tabular-nums">
                                {transaction.confirmedAmount === null
                                  ? '—'
                                  : formatMoney(transaction.confirmedAmount)}
                              </td>
                              <td className="py-2 text-slate-500">
                                {transaction.status.toLowerCase().replace(/_/g, ' ')}
                                {transaction.failureMessage !== null ? (
                                  <span className="block text-xs">
                                    {transaction.failureMessage}
                                  </span>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardBody>
                </Card>
              ) : null}

              {/* ------------------------------------------------- the history */}

              <Card>
                <CardHeader
                  title="History"
                  description="How this payment reached its current state, oldest first."
                />
                <CardBody>
                  <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.statusHistory.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap gap-2 py-2 text-sm">
                        <span className="text-slate-500">{formatDateTime(entry.occurredAt)}</span>
                        <span className="font-medium">
                          {entry.fromStatus === null
                            ? 'Created'
                            : `${entry.fromStatus.toLowerCase().replace(/_/g, ' ')} → ${entry.toStatus
                                .toLowerCase()
                                .replace(/_/g, ' ')}`}
                        </span>
                        <span className="text-slate-500">
                          {entry.actorName ?? describeSource(entry.source)}
                        </span>
                        {entry.reason !== null ? (
                          <span className="w-full text-slate-500">{entry.reason}</span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </CardBody>
              </Card>

              {/* -------------------------------------------------- the ledger */}

              {data.entries.length > 0 ? (
                <Card>
                  <CardHeader
                    title="Ledger effect"
                    description="What this payment did to the student's balance."
                  />
                  <CardBody>
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                      {data.entries.map((entry) => (
                        <li key={entry.id} className="flex justify-between gap-3 py-2 text-sm">
                          <span>
                            {entry.description}
                            {entry.reversalOfEntryId !== null ? (
                              <span className="ml-2 text-xs text-slate-500">(reversal)</span>
                            ) : null}
                            <span className="block text-xs text-slate-500">
                              {formatDateTime(entry.postedAt)} · posted by {entry.postedByName}
                            </span>
                          </span>
                          <span className="font-medium tabular-nums">
                            {entry.entryType === 'CREDIT' ? '−' : '+'}
                            {formatMoney(entry.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ) : null}
            </>
          );
        }}
      </DataState>
    </div>
  );
}

/** Who or what caused a transition, in words. */
function describeSource(source: string): string {
  switch (source) {
    case 'PROVIDER_WEBHOOK':
      return 'the payment provider';
    case 'PROVIDER_QUERY':
      return 'the payment provider';
    case 'SYSTEM':
      return 'the system';
    default:
      return '';
  }
}

function Figure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900 capitalize dark:text-slate-100">
        {value}
      </dd>
    </div>
  );
}
