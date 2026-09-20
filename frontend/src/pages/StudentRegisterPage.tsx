/**
 * Register a student.
 *
 * The placement fields are part of this form rather than a later step, because a
 * student with no enrolment cannot be charged, placed or reported on — and a
 * two-step flow is a two-step flow that sometimes stops after the first.
 *
 * On success the screen shows the allocated Student ID prominently: that is the thing
 * the registrar writes on the admission form, and it is the only part of this
 * transaction they cannot reconstruct themselves.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import type { StudentDetail } from '@sfs/shared';

import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import * as academicApi from '../lib/academic-api';
import { toFormError, type FormErrorState } from '../lib/form-errors';
import * as studentsApi from '../lib/students-api';

/** Today, as the date input wants it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function StudentRegisterPage(): React.JSX.Element {
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [otherNames, setOtherNames] = useState('');
  const [gender, setGender] = useState<'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED'>('UNDISCLOSED');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [admissionDate, setAdmissionDate] = useState(today());
  const [district, setDistrict] = useState('');
  const [levelId, setLevelId] = useState('');
  const [classSectionId, setClassSectionId] = useState('');
  const [residency, setResidency] = useState<'DAY' | 'BOARDING'>('DAY');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormErrorState | null>(null);
  const [created, setCreated] = useState<StudentDetail | null>(null);

  const currentYear = useAsyncResource(() => academicApi.getCurrentAcademicYear(), []);
  const levels = useAsyncResource(() => academicApi.listLevels(), []);
  const classes = useAsyncResource(
    () =>
      currentYear.data == null || levelId === ''
        ? Promise.resolve([])
        : academicApi.listClassSections({ academicYearId: currentYear.data.id, levelId }),
    [currentYear.data?.id, levelId],
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const student = await studentsApi.registerStudent({
        firstName,
        lastName,
        otherNames: otherNames === '' ? null : otherNames,
        gender,
        dateOfBirth: dateOfBirth === '' ? null : dateOfBirth,
        admissionDate,
        district: district === '' ? null : district,
        enrolment: {
          levelId,
          classSectionId: classSectionId === '' ? null : classSectionId,
          residency,
        },
      });
      setCreated(student);
    } catch (cause) {
      setError(toFormError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (created !== null) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <CardHeader title="Student registered" />
          <CardBody>
            <Alert variant="success" title="Write this Student ID on the admission form">
              <p className="mt-1 font-mono text-lg">{created.studentId}</p>
              <p className="mt-2">
                {created.firstName} {created.lastName} has been enrolled into{' '}
                {created.currentEnrollment?.classSectionName ??
                  created.currentEnrollment?.levelName ??
                  'their level'}
                .
              </p>
            </Alert>

            <div className="mt-4 flex gap-2">
              <Link to={`/students/${created.id}`}>
                <Button>Open the student</Button>
              </Link>
              <Button
                variant="secondary"
                onClick={() => {
                  setCreated(null);
                  setFirstName('');
                  setLastName('');
                  setOtherNames('');
                  setDateOfBirth('');
                }}
              >
                Register another
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  const noCurrentYear = currentYear.status === 'success' && currentYear.data == null;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader
          title="Register a student"
          description="The Student ID is allocated automatically and never changes."
        />
        <CardBody>
          {noCurrentYear ? (
            <Alert variant="warning" title="No academic year is current">
              A school administrator must set the current academic year before students can be
              registered.
            </Alert>
          ) : null}

          {error !== null ? (
            <Alert
              variant="error"
              className="mb-4"
              {...(error.requestId !== undefined ? { requestId: error.requestId } : {})}
            >
              {error.message}
            </Alert>
          ) : null}

          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <TextField
              label="First name"
              name="firstName"
              required
              value={firstName}
              error={error?.fieldErrors.firstName}
              onChange={(event) => {
                setFirstName(event.target.value);
              }}
            />
            <TextField
              label="Last name"
              name="lastName"
              required
              value={lastName}
              error={error?.fieldErrors.lastName}
              onChange={(event) => {
                setLastName(event.target.value);
              }}
            />
            <TextField
              label="Other names"
              name="otherNames"
              value={otherNames}
              onChange={(event) => {
                setOtherNames(event.target.value);
              }}
            />

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="gender"
                className="text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Gender
              </label>
              <select
                id="gender"
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={gender}
                onChange={(event) => {
                  setGender(event.target.value as typeof gender);
                }}
              >
                <option value="UNDISCLOSED">Not stated</option>
                <option value="FEMALE">Female</option>
                <option value="MALE">Male</option>
                <option value="OTHER">Other</option>
              </select>
            </div>

            <TextField
              label="Date of birth"
              name="dateOfBirth"
              type="date"
              value={dateOfBirth}
              error={error?.fieldErrors.dateOfBirth}
              onChange={(event) => {
                setDateOfBirth(event.target.value);
              }}
            />
            <TextField
              label="Admission date"
              name="admissionDate"
              type="date"
              required
              value={admissionDate}
              error={error?.fieldErrors.admissionDate}
              onChange={(event) => {
                setAdmissionDate(event.target.value);
              }}
            />
            <TextField
              label="District"
              name="district"
              value={district}
              onChange={(event) => {
                setDistrict(event.target.value);
              }}
            />

            <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
              <legend className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Placement
              </legend>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="levelId"
                  className="text-sm font-medium text-slate-800 dark:text-slate-200"
                >
                  Level
                  <span aria-hidden="true" className="ml-0.5 text-red-600">
                    *
                  </span>
                </label>
                <select
                  id="levelId"
                  required
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={levelId}
                  onChange={(event) => {
                    setLevelId(event.target.value);
                    // The class list belongs to the level; keeping a stale choice
                    // would submit a class from a different level.
                    setClassSectionId('');
                  }}
                >
                  <option value="">Choose a level…</option>
                  {(levels.data ?? []).map((level) => (
                    <option key={level.id} value={level.id}>
                      {level.programName} — {level.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="classSectionId"
                  className="text-sm font-medium text-slate-800 dark:text-slate-200"
                >
                  Class
                </label>
                <select
                  id="classSectionId"
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={classSectionId}
                  disabled={levelId === ''}
                  onChange={(event) => {
                    setClassSectionId(event.target.value);
                  }}
                >
                  <option value="">Not assigned yet</option>
                  {(classes.data ?? []).map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                      {section.capacity !== null
                        ? ` (${String(section.enrolledCount)}/${String(section.capacity)})`
                        : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="residency"
                  className="text-sm font-medium text-slate-800 dark:text-slate-200"
                >
                  Day or boarding
                </label>
                <select
                  id="residency"
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={residency}
                  onChange={(event) => {
                    setResidency(event.target.value as typeof residency);
                  }}
                >
                  <option value="DAY">Day</option>
                  <option value="BOARDING">Boarding</option>
                </select>
              </div>
            </fieldset>

            <div className="flex gap-2 sm:col-span-2">
              <Button
                type="submit"
                isLoading={busy}
                loadingLabel="Registering"
                disabled={noCurrentYear}
              >
                Register student
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigate('/students');
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
