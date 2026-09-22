/**
 * The parent portal's payment screen.
 *
 * Written for somebody using it once a term, on a phone, possibly on a poor connection.
 * The decisions that follow from that:
 *
 *  - **The outstanding figure comes from the server** and is offered as the default
 *    amount. Nothing here adds anything up.
 *  - **Channels the school cannot currently collect through say so**, in the words the
 *    server supplies, instead of presenting a button that fails. Where no online
 *    integration exists the screen says how to pay instead — which for this school is
 *    every channel today (docs/OPEN-QUESTIONS.md #1 and #2, Section 40).
 *  - **An idempotency key is minted once per attempt**, so tapping Pay twice on a slow
 *    connection cannot produce two payments.
 *  - **A claim tells the truth about what happens next**: it is not paid, it is recorded,
 *    and a bursar confirms it against the school's statement. Saying anything else would
 *    be promising a credit the school has not seen (ADR-003).
 */
import { useState } from 'react';

import type {
  PayableStudent,
  PaymentMethodOption,
  PaymentMethodValue,
  PaymentProviderKeyValue,
  PaymentSummary,
} from '@sfs/shared';
import { Link } from 'react-router';

import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import { formatMoney } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as paymentsApi from '../lib/payments-api';

interface PayableData {
  readonly students: readonly PayableStudent[];
  readonly methods: readonly PaymentMethodOption[];
}

export function PayPage(): React.JSX.Element {
  const [error, setError] = useState<FormErrorState | null>(null);
  const [created, setCreated] = useState<PaymentSummary | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [studentId, setStudentId] = useState('');
  const [method, setMethod] = useState<PaymentMethodValue>('BANK_TRANSFER');
  const [providerKey, setProviderKey] = useState<PaymentProviderKeyValue | ''>('');
  const [amount, setAmount] = useState('');
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [externalReference, setExternalReference] = useState('');

  const resource = useAsyncResource<PayableData>(async () => {
    const [students, methods] = await Promise.all([
      paymentsApi.listPayableStudents(),
      paymentsApi.listPaymentMethods(),
    ]);
    return { students, methods };
  }, []);

  const submit = (data: PayableData): void => {
    const selectedMethod = data.methods.find((option) => option.method === method);
    if (selectedMethod === undefined) return;

    setError(null);
    setCreated(null);
    setInstruction(null);
    setBusy(true);

    // Minted here, once per attempt: a retry of *this* attempt reuses it and is answered
    // from the payment it already created, rather than creating a second one.
    const idempotencyKey = paymentsApi.newIdempotencyKey();

    const shared = {
      studentId,
      amount,
      payerName,
      ...(payerPhone.trim() === '' ? {} : { payerPhone: payerPhone.trim() }),
      method,
    };

    const action =
      selectedMethod.verificationMethod === 'PROVIDER'
        ? paymentsApi.initiatePayment(shared, idempotencyKey).then((result) => {
            setInstruction(result.providerInstruction);
            return result.payment;
          })
        : paymentsApi.recordManualClaim(
            {
              ...shared,
              ...(providerKey === '' ? {} : { providerKey }),
              ...(externalReference.trim() === ''
                ? {}
                : { externalReference: externalReference.trim() }),
            },
            idempotencyKey,
          );

    void action
      .then((payment) => {
        setCreated(payment);
        resource.refresh();
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
          {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
        >
          {error.message}
        </Alert>
      ) : null}

      {created !== null ? (
        <Alert variant="success">
          <p className="font-medium">
            {created.verificationMethod === 'MANUAL'
              ? 'Recorded. Your payment reference is'
              : 'Started. Your payment reference is'}{' '}
            {created.reference}.
          </p>
          <p className="mt-1">
            {created.verificationMethod === 'MANUAL'
              ? 'Nothing has been credited yet: a bursar will confirm it against the school’s statement. Attach the slip to the payment so they can match it.'
              : (instruction ??
                'Follow the prompt on your phone. The balance updates once the provider confirms it.')}
          </p>
          <p className="mt-2">
            <Link className="font-medium underline" to={`/payments/${created.id}`}>
              Open this payment
            </Link>
          </p>
        </Alert>
      ) : null}

      <DataState
        status={resource.status}
        data={resource.data}
        error={resource.error}
        onRetry={resource.refresh}
        loadingLabel="Loading your children's balances"
        isEmpty={(data) => data.students.length === 0}
        emptyTitle="No students are linked to your account"
        emptyDescription="Contact the school office so they can link you to your child's record."
      >
        {(data) => (
          <>
            <Card>
              <CardHeader
                title="What you owe"
                description="Calculated by the school from its own records."
              />
              <CardBody>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.students.map((payable) => (
                    <li
                      key={payable.studentId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div>
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {payable.studentName}
                        </p>
                        <p className="text-xs text-slate-500">{payable.studentNumber}</p>
                      </div>

                      <div className="flex items-center gap-4">
                        {payable.canViewFinancials ? (
                          <span className="text-right">
                            <span className="block text-xs text-slate-500">
                              {payable.creditBalance === '0.00' ? 'Outstanding' : 'In credit'}
                            </span>
                            <span className="font-medium tabular-nums">
                              {formatMoney(
                                payable.creditBalance === '0.00'
                                  ? payable.outstanding
                                  : payable.creditBalance,
                              )}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">
                            The school has not given you access to these figures.
                          </span>
                        )}

                        {payable.canInitiatePayments ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setStudentId(payable.studentId);
                              setAmount(
                                payable.creditBalance === '0.00' ? payable.outstanding : '',
                              );
                            }}
                          >
                            Pay
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>

            {studentId !== '' ? (
              <Card>
                <CardHeader
                  title="Make a payment"
                  description="Choose how you are paying. The school confirms every payment before it changes a balance."
                />
                <CardBody>
                  <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit(data);
                    }}
                  >
                    <fieldset className="flex flex-col gap-2">
                      <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">
                        How are you paying?
                      </legend>

                      {data.methods.map((option) => (
                        <label
                          key={option.method}
                          className="flex items-start gap-3 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700"
                        >
                          <input
                            type="radio"
                            name="method"
                            className="mt-1"
                            value={option.method}
                            checked={method === option.method}
                            disabled={!option.isAvailable}
                            onChange={() => {
                              setMethod(option.method);
                              setProviderKey('');
                            }}
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-slate-900 dark:text-slate-100">
                              {option.label}
                            </span>
                            {option.instructions !== null ? (
                              <span className="block text-xs text-slate-500">
                                {option.instructions}
                              </span>
                            ) : null}
                            {!option.isAvailable && option.unavailableReason !== null ? (
                              <span className="block text-xs text-amber-700 dark:text-amber-300">
                                {option.unavailableReason}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </fieldset>

                    {needsProvider(data.methods, method) ? (
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium text-slate-700 dark:text-slate-200">
                          Which bank did you pay into?
                        </span>
                        <select
                          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                          value={providerKey}
                          onChange={(event) => {
                            setProviderKey(event.target.value as PaymentProviderKeyValue);
                          }}
                          required
                        >
                          <option value="">Select a bank</option>
                          <option value="BANK_OF_KIGALI">Bank of Kigali</option>
                          <option value="ZIGAMA_CSS">Zigama CSS</option>
                          <option value="UMWARIMU_SACCO">Umwarimu SACCO</option>
                        </select>
                      </label>
                    ) : null}

                    <div className="flex flex-wrap gap-3">
                      <TextField
                        label="Amount"
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value);
                        }}
                        inputMode="decimal"
                        placeholder="50000.00"
                        required
                      />
                      <TextField
                        label="Your name, as it appears on the payment"
                        value={payerName}
                        onChange={(event) => {
                          setPayerName(event.target.value);
                        }}
                        required
                      />
                      <TextField
                        label="Phone number"
                        value={payerPhone}
                        onChange={(event) => {
                          setPayerPhone(event.target.value);
                        }}
                        placeholder="+250 788 123 456"
                      />
                      {needsProvider(data.methods, method) ? (
                        <TextField
                          label="Bank reference (if you have one)"
                          value={externalReference}
                          onChange={(event) => {
                            setExternalReference(event.target.value);
                          }}
                        />
                      ) : null}
                    </div>

                    <div>
                      <Button type="submit" disabled={busy}>
                        {busy ? 'Sending…' : 'Continue'}
                      </Button>
                    </div>
                  </form>
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="Your payments"
                description="Everything you have told the school about."
              />
              <CardBody>
                <p className="text-sm">
                  <Link
                    className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                    to="/payments"
                  >
                    See your payment history
                  </Link>
                </p>
              </CardBody>
            </Card>
          </>
        )}
      </DataState>
    </div>
  );
}

/** True when the chosen channel is one the payer has to name an institution for. */
function needsProvider(
  methods: readonly PaymentMethodOption[],
  method: PaymentMethodValue,
): boolean {
  const option = methods.find((candidate) => candidate.method === method);
  if (option === undefined) return false;
  return option.verificationMethod === 'MANUAL' && method !== 'CASH';
}
