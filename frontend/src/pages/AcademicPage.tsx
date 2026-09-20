/**
 * The academic structure: years and terms, programmes and their levels, and classes.
 *
 * This screen is the setup a school does once and then adjusts yearly, so it is
 * organised the way that work happens rather than one entity per page: the year and
 * its terms together, because a term only makes sense inside one; the programmes with
 * their level chains, because the chain is what promotion follows.
 *
 * Which year is current is given prominence deliberately. Registration, enrolment and
 * every later fee structure resolve through it, and "no current year" is the most
 * common reason the rest of the system refuses to work.
 */
import { useState } from 'react';

import { PermissionKey } from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import * as academicApi from '../lib/academic-api';
import { formatDate } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';

export function AcademicPage(): React.JSX.Element {
  const { can } = useAuth();
  const mayManage = can(PermissionKey.ACADEMIC_MANAGE);

  const [error, setError] = useState<FormErrorState | null>(null);

  const years = useAsyncResource(() => academicApi.listAcademicYears(), []);
  const programs = useAsyncResource(() => academicApi.listPrograms(), []);
  const levels = useAsyncResource(() => academicApi.listLevels(), []);

  const currentYear = (years.data ?? []).find((year) => year.isCurrent) ?? null;

  const classes = useAsyncResource(
    () =>
      currentYear === null
        ? Promise.resolve([])
        : academicApi.listClassSections({ academicYearId: currentYear.id }),
    [currentYear?.id],
  );

  const run = (action: () => Promise<unknown>): void => {
    setError(null);
    void action()
      .then(() => {
        years.refresh();
        classes.refresh();
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
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

      {years.status === 'success' && currentYear === null ? (
        <Alert variant="warning" title="No academic year is current">
          Students cannot be registered or enrolled until one is set.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Academic years and terms"
          description="Fees, charges and reports are all scoped by these."
        />
        <CardBody>
          <DataState
            status={years.status}
            data={years.data}
            error={years.error}
            onRetry={years.refresh}
            loadingLabel="Loading academic years"
            emptyTitle="No academic years yet"
            emptyDescription="Add the first one to begin."
            isEmpty={(data) => data.length === 0}
          >
            {(data) => (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.map((year) => (
                  <li key={year.id} className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          {year.name}
                          {year.isCurrent ? (
                            <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-200">
                              Current
                            </span>
                          ) : null}
                          <span className="ml-2 text-xs font-normal text-slate-500">
                            {year.status}
                          </span>
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {formatDate(year.startDate)} to {formatDate(year.endDate)}
                        </p>
                      </div>

                      {mayManage && !year.isCurrent && year.status !== 'CLOSED' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            run(() => academicApi.setCurrentAcademicYear(year.id));
                          }}
                        >
                          Make current
                        </Button>
                      ) : null}
                    </div>

                    {year.terms.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {year.terms.map((term) => (
                          <li
                            key={term.id}
                            className="rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-800"
                          >
                            <span className="font-medium">{term.name}</span>{' '}
                            <span className="text-slate-500">
                              {formatDate(term.startDate)} – {formatDate(term.endDate)}
                            </span>
                            {term.isCurrent ? (
                              <span className="ml-1 text-brand-700 dark:text-brand-300">
                                · current
                              </span>
                            ) : null}
                            {mayManage && !term.isCurrent && term.status !== 'CLOSED' ? (
                              <button
                                type="button"
                                className="ml-2 text-brand-700 underline dark:text-brand-300"
                                onClick={() => {
                                  run(() => academicApi.setCurrentTerm(term.id));
                                }}
                              >
                                set current
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        No terms configured. A charge belongs to a term, so this year cannot carry
                        fees yet.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </DataState>

          {mayManage ? <AddYearForm onDone={run} /> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Programmes and levels"
          description="A level points at the one that follows it, and promotion walks that chain."
        />
        <CardBody>
          <DataState
            status={programs.status}
            data={programs.data}
            error={programs.error}
            onRetry={programs.refresh}
            loadingLabel="Loading programmes"
            emptyTitle="No programmes yet"
            isEmpty={(data) => data.length === 0}
          >
            {(data) => (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.map((program) => {
                  const programLevels = (levels.data ?? [])
                    .filter((level) => level.programId === program.id)
                    .sort((left, right) => left.sequence - right.sequence);

                  return (
                    <li key={program.id} className="py-3">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {program.name}{' '}
                        <span className="font-mono text-xs text-slate-500">{program.code}</span>
                        {program.status === 'DISCONTINUED' ? (
                          <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
                            discontinued
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                        {programLevels.length === 0
                          ? 'No levels configured.'
                          : programLevels
                              .map((level) => level.code + (level.isTerminal ? ' (final)' : ''))
                              .join(' → ')}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </DataState>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Classes"
          description={
            currentYear === null
              ? 'Set a current academic year to see its classes.'
              : `Classes for ${currentYear.name}, with how full they are.`
          }
        />
        <CardBody>
          <DataState
            status={classes.status}
            data={classes.data}
            error={classes.error}
            onRetry={classes.refresh}
            loadingLabel="Loading classes"
            emptyTitle="No classes for this year"
            emptyDescription="Students can still be enrolled at level without a class."
            isEmpty={(data) => data.length === 0}
          >
            {(data) => (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.map((section) => (
                  <li
                    key={section.id}
                    className="rounded-md border border-slate-200 p-3 dark:border-slate-800"
                  >
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {section.name}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {section.levelName} ·{' '}
                      {section.capacity === null
                        ? `${String(section.enrolledCount)} enrolled`
                        : `${String(section.enrolledCount)} of ${String(section.capacity)}`}
                      {section.classTeacherName !== null ? ` · ${section.classTeacherName}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </CardBody>
      </Card>
    </div>
  );
}

function AddYearForm({
  onDone,
}: {
  readonly onDone: (action: () => Promise<unknown>) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

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
          Add an academic year
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mt-4 grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-3 dark:border-slate-800"
      onSubmit={(event) => {
        event.preventDefault();
        onDone(() => academicApi.createAcademicYear({ name, startDate, endDate }));
        setOpen(false);
        setName('');
        setStartDate('');
        setEndDate('');
      }}
    >
      <TextField
        label="Name"
        name="yearName"
        required
        placeholder="2027"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label="Starts"
        name="startDate"
        type="date"
        required
        value={startDate}
        onChange={(event) => {
          setStartDate(event.target.value);
        }}
      />
      <TextField
        label="Ends"
        name="endDate"
        type="date"
        required
        value={endDate}
        onChange={(event) => {
          setEndDate(event.target.value);
        }}
      />
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm">
          Add year
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
