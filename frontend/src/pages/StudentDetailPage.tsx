/**
 * One student: profile, the people responsible for them, and where they have been.
 *
 * The enrolment history is shown in full rather than summarised to the current year,
 * because it is append-only and it is the record a clearance check and a proration
 * both read. A withdrawal in March is not noise; it is why the term's charges look
 * the way they do.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { PermissionKey, type StudentDetail, type StudentState } from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import { formatDate } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as studentsApi from '../lib/students-api';

/** What a student may become from where they are, mirroring the server's rules. */
const NEXT_STATUSES: Readonly<Record<StudentState, readonly StudentState[]>> = {
  ACTIVE: ['COMPLETED', 'TRANSFERRED', 'WITHDRAWN', 'SUSPENDED', 'ARCHIVED'],
  SUSPENDED: ['ACTIVE', 'WITHDRAWN', 'TRANSFERRED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  TRANSFERRED: ['ARCHIVED'],
  WITHDRAWN: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export function StudentDetailPage(): React.JSX.Element {
  const { studentId = '' } = useParams();
  const { can } = useAuth();

  const student = useAsyncResource(() => studentsApi.getStudent(studentId), [studentId]);

  return (
    <DataState
      status={student.status}
      data={student.data}
      error={student.error}
      onRetry={student.refresh}
      loadingLabel="Loading the student"
    >
      {(data) => (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title={`${data.firstName} ${data.lastName}`}
              description={
                <span className="font-mono text-xs">
                  {data.studentId} · {data.status}
                </span>
              }
              actions={
                <Link to="/students">
                  <Button variant="ghost" size="sm">
                    Back to students
                  </Button>
                </Link>
              }
            />
            <CardBody>
              <dl className="grid gap-4 sm:grid-cols-3">
                <Field
                  label="Date of birth"
                  value={data.dateOfBirth === null ? '—' : formatDate(data.dateOfBirth)}
                />
                <Field label="Gender" value={data.gender} />
                <Field label="Admitted" value={formatDate(data.admissionDate)} />
                <Field label="District" value={data.district ?? '—'} />
                <Field label="Phone" value={data.phone ?? '—'} />
                <Field label="Email" value={data.email ?? '—'} />
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Current placement"
              description={
                data.currentEnrollment === null
                  ? 'This student is not currently enrolled.'
                  : undefined
              }
            />
            <CardBody>
              {data.currentEnrollment === null ? (
                <Alert variant="warning">
                  Without an enrolment this student cannot be charged or appear on a class list.
                </Alert>
              ) : (
                <dl className="grid gap-4 sm:grid-cols-4">
                  <Field label="Year" value={data.currentEnrollment.academicYearName} />
                  <Field label="Programme" value={data.currentEnrollment.programName} />
                  <Field label="Level" value={data.currentEnrollment.levelName} />
                  <Field
                    label="Class"
                    value={data.currentEnrollment.classSectionName ?? 'Not assigned'}
                  />
                </dl>
              )}
            </CardBody>
          </Card>

          <GuardiansCard student={data} onChanged={student.refresh} />

          <Card>
            <CardHeader
              title="Enrolment history"
              description="Appended, never overwritten: every year this student has been here."
            />
            <CardBody>
              {data.enrollments.length === 0 ? (
                <p className="text-sm text-slate-600 dark:text-slate-400">No enrolments yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.enrollments.map((enrollment) => (
                    <li key={enrollment.id} className="py-3 text-sm">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {enrollment.academicYearName} · {enrollment.levelName}
                        {enrollment.classSectionName !== null
                          ? ` · ${enrollment.classSectionName}`
                          : ''}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {enrollment.status} · {enrollment.residency.toLowerCase()} · from{' '}
                        {formatDate(enrollment.startDate)}
                        {enrollment.endDate !== null ? ` to ${formatDate(enrollment.endDate)}` : ''}
                        {enrollment.exitReason !== null ? ` · ${enrollment.exitReason}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {can(PermissionKey.STUDENT_ARCHIVE) ? (
            <StatusCard student={data} onChanged={student.refresh} />
          ) : null}
        </div>
      )}
    </DataState>
  );
}

function Field({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  );
}

/**
 * The guardians linked to this student, and what each of them may do.
 *
 * The flags are shown rather than hidden behind an edit screen because they are the
 * answer to "who can see this balance and who can pay it" — a question the office is
 * asked directly.
 */
function GuardiansCard({
  student,
  onChanged,
}: {
  readonly student: StudentDetail;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const { can } = useAuth();
  const [error, setError] = useState<FormErrorState | null>(null);
  const mayLink = can(PermissionKey.GUARDIAN_LINK);

  const unlink = (linkId: string): void => {
    setError(null);
    void studentsApi
      .unlinkGuardian(linkId)
      .then(onChanged)
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      });
  };

  return (
    <Card>
      <CardHeader
        title="Parents and guardians"
        description="Who the school contacts, and who may see and pay the fees."
      />
      <CardBody>
        {error !== null ? (
          <Alert variant="error" className="mb-4">
            {error.message}
          </Alert>
        ) : null}

        {student.guardians.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Nobody is linked to this student yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {student.guardians.map((link) => (
              <li key={link.id} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {link.guardianFirstName} {link.guardianLastName}
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {link.relationship.toLowerCase()}
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{link.guardianPhone}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    {link.isPrimaryContact ? <Tag>First contact</Tag> : null}
                    {link.isFinanciallyResponsible ? <Tag>Pays the fees</Tag> : null}
                    {link.canViewFinancials ? <Tag>Sees the balance</Tag> : null}
                    {link.canInitiatePayments ? <Tag>Can pay online</Tag> : null}
                  </div>
                </div>

                {mayLink ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      unlink(link.id);
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {mayLink ? <LinkGuardianForm studentId={student.id} onLinked={onChanged} /> : null}
      </CardBody>
    </Card>
  );
}

function Tag({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
      {children}
    </span>
  );
}

/**
 * Link a guardian, creating them if they are new to the school.
 *
 * One form rather than two screens: the registrar is holding an admission form with a
 * parent's name and number on it, and making them go and create a guardian first is
 * the kind of step that gets skipped.
 */
function LinkGuardianForm({
  studentId,
  onLinked,
}: {
  readonly studentId: string;
  readonly onLinked: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState<'MOTHER' | 'FATHER' | 'GUARDIAN'>('GUARDIAN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);

  if (!open) {
    return (
      <div className="mt-4">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          Add a guardian
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mt-4 grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-2 dark:border-slate-800"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        void studentsApi
          .createGuardian({ firstName, lastName, phone })
          .then((guardian) =>
            studentsApi.linkGuardian(studentId, {
              guardianId: guardian.id,
              relationship,
              isPrimaryContact: true,
              isFinanciallyResponsible: true,
            }),
          )
          .then(() => {
            setOpen(false);
            setFirstName('');
            setLastName('');
            setPhone('');
            onLinked();
          })
          .catch((cause: unknown) => {
            setError(toFormError(cause));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {error !== null ? (
        <div className="sm:col-span-2">
          <Alert variant="error">{error.message}</Alert>
        </div>
      ) : null}

      <TextField
        label="First name"
        name="guardianFirstName"
        required
        value={firstName}
        onChange={(event) => {
          setFirstName(event.target.value);
        }}
      />
      <TextField
        label="Last name"
        name="guardianLastName"
        required
        value={lastName}
        onChange={(event) => {
          setLastName(event.target.value);
        }}
      />
      <TextField
        label="Phone"
        name="guardianPhone"
        required
        value={phone}
        hint="The number the school will use for fee notices."
        onChange={(event) => {
          setPhone(event.target.value);
        }}
      />

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="relationship"
          className="text-sm font-medium text-slate-800 dark:text-slate-200"
        >
          Relationship
        </label>
        <select
          id="relationship"
          className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          value={relationship}
          onChange={(event) => {
            setRelationship(event.target.value as typeof relationship);
          }}
        >
          <option value="MOTHER">Mother</option>
          <option value="FATHER">Father</option>
          <option value="GUARDIAN">Guardian</option>
        </select>
      </div>

      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" isLoading={busy} loadingLabel="Saving">
          Save and link
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Change where the student is in their life at the school.
 *
 * A reason is required for everything but reinstatement, and the screen says why:
 * "why did this student leave" is the question a clearance check starts from.
 */
function StatusCard({
  student,
  onChanged,
}: {
  readonly student: StudentDetail;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<StudentState | ''>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);

  const options = NEXT_STATUSES[student.status];

  if (options.length === 0) {
    return (
      <Card>
        <CardHeader title="Status" />
        <CardBody>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            This record is archived. Its financial history is kept, and it cannot be changed
            further.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Change status"
        description="Withdrawing, transferring or completing also ends the current enrolment."
      />
      <CardBody>
        {error !== null ? (
          <Alert variant="error" className="mb-4">
            {error.message}
          </Alert>
        ) : null}

        <form
          className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (status === '') return;

            setBusy(true);
            setError(null);

            void studentsApi
              .changeStudentStatus(student.id, {
                expectedVersion: student.version,
                status,
                ...(reason !== '' ? { reason } : {}),
              })
              .then(() => {
                setStatus('');
                setReason('');
                onChanged();
              })
              .catch((cause: unknown) => {
                setError(toFormError(cause));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="new-status"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              New status
            </label>
            <select
              id="new-status"
              className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as StudentState | '');
              }}
            >
              <option value="">Choose…</option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <TextField
            label="Reason"
            name="reason"
            value={reason}
            error={error?.fieldErrors.reason}
            hint="Required unless you are reinstating the student."
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />

          <Button type="submit" disabled={status === ''} isLoading={busy} loadingLabel="Saving">
            Apply
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
