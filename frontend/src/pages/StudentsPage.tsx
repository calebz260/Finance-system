/**
 * The student roll.
 *
 * Built around how staff actually use it: a bursar types a Student ID or a surname to
 * find one person, and a registrar filters by class to print a list. Both are the
 * search box and the class filter; everything else is secondary.
 *
 * The Student ID is the first column because it is the identifier written on receipts
 * and admission forms, and it is what someone at the counter reads out.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import { PermissionKey, type StudentState } from '@sfs/shared';

import { useAuth } from '../auth/auth-context';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { TextField } from '../components/ui/TextField';
import { useAsyncResource } from '../hooks/use-async-resource';
import * as academicApi from '../lib/academic-api';
import { formatDate } from '../lib/format';
import * as studentsApi from '../lib/students-api';

const STATUSES: readonly StudentState[] = [
  'ACTIVE',
  'COMPLETED',
  'TRANSFERRED',
  'WITHDRAWN',
  'SUSPENDED',
  'ARCHIVED',
];

export function StudentsPage(): React.JSX.Element {
  const { can } = useAuth();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StudentState | ''>('ACTIVE');
  const [classSectionId, setClassSectionId] = useState('');
  const [page, setPage] = useState(1);

  const currentYear = useAsyncResource(() => academicApi.getCurrentAcademicYear(), []);
  const classes = useAsyncResource(
    () =>
      currentYear.data == null
        ? Promise.resolve([])
        : academicApi.listClassSections({ academicYearId: currentYear.data.id }),
    [currentYear.data?.id],
  );

  const students = useAsyncResource(
    () =>
      studentsApi.listStudents({
        page,
        pageSize: 25,
        ...(search !== '' ? { search } : {}),
        ...(status !== '' ? { status } : {}),
        ...(classSectionId !== '' ? { classSectionId } : {}),
      }),
    [page, search, status, classSectionId],
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Students"
          description={
            currentYear.data == null
              ? 'No academic year is set as current.'
              : `Academic year ${currentYear.data.name}`
          }
          actions={
            <div className="flex gap-2">
              {can(PermissionKey.STUDENT_IMPORT) ? (
                <Link to="/students/import">
                  <Button variant="secondary" size="sm">
                    Import from a file
                  </Button>
                </Link>
              ) : null}
              {can(PermissionKey.STUDENT_CREATE) ? (
                <Link to="/students/new">
                  <Button size="sm">Register a student</Button>
                </Link>
              ) : null}
            </div>
          }
        />
        <CardBody>
          <form
            className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSearch(searchInput);
            }}
          >
            <TextField
              label="Search"
              name="search"
              placeholder="Student ID or name"
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
              }}
            />

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="student-status"
                className="text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Status
              </label>
              <select
                id="student-status"
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={status}
                onChange={(event) => {
                  setPage(1);
                  setStatus(event.target.value as StudentState | '');
                }}
              >
                <option value="">Any status</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="student-class"
                className="text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Class
              </label>
              <select
                id="student-class"
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={classSectionId}
                onChange={(event) => {
                  setPage(1);
                  setClassSectionId(event.target.value);
                }}
              >
                <option value="">Any class</option>
                {(classes.data ?? []).map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.name}
                  </option>
                ))}
              </select>
            </div>

            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>

          <DataState
            status={students.status}
            data={students.data}
            error={students.error}
            onRetry={students.refresh}
            loadingLabel="Loading students"
            emptyTitle="No students match"
            emptyDescription="Try a different name, Student ID or class."
            isEmpty={(result) => result.data.length === 0}
          >
            {(result) => (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Students, with their identifier and current class
                    </caption>
                    <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <tr>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Student ID
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Name
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Class
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Status
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          Admitted
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {result.data.map((student) => (
                        <tr key={student.id}>
                          <td className="py-2 pr-4 font-mono text-xs">
                            <Link
                              to={`/students/${student.id}`}
                              className="text-brand-700 underline dark:text-brand-300"
                            >
                              {student.studentId}
                            </Link>
                          </td>
                          <td className="py-2 pr-4">
                            {student.lastName}, {student.firstName}
                          </td>
                          <td className="py-2 pr-4">
                            {student.currentEnrollment?.classSectionName ??
                              student.currentEnrollment?.levelName ??
                              'Not enrolled'}
                          </td>
                          <td className="py-2 pr-4">{student.status}</td>
                          <td className="py-2">{formatDate(student.admissionDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <nav
                  aria-label="Pagination"
                  className="mt-4 flex items-center justify-between text-sm"
                >
                  <p className="text-slate-600 dark:text-slate-400">
                    {result.meta.totalItems} student{result.meta.totalItems === 1 ? '' : 's'} · page{' '}
                    {result.meta.page} of {result.meta.totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!result.meta.hasPreviousPage}
                      onClick={() => {
                        setPage((current) => Math.max(1, current - 1));
                      }}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!result.meta.hasNextPage}
                      onClick={() => {
                        setPage((current) => current + 1);
                      }}
                    >
                      Next
                    </Button>
                  </div>
                </nav>
              </>
            )}
          </DataState>
        </CardBody>
      </Card>
    </div>
  );
}
