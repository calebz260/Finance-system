/**
 * Fee configuration: the categories a school levies and the structures that price them.
 *
 * Organised the way the work happens rather than one entity per page. A school sets up
 * categories once, then builds a structure per period and publishes it — so categories
 * sit above structures, and publishing is a distinct, deliberate action rather than a
 * field on an edit form.
 *
 * Two things are given prominence on purpose:
 *
 *  - **A structure that has raised charges is locked**, and says so. Discovering that
 *    only when a save is rejected would be a poor way to learn it.
 *  - **Publishing is what makes a structure billable.** It is a separate button with a
 *    confirmation, because an accidental click starts charging families.
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
import * as feesApi from '../lib/fees-api';
import { formatMoney } from '../lib/format';
import { toFormError, type FormErrorState } from '../lib/form-errors';

interface DraftItem {
  feeCategoryId: string;
  label: string;
  amount: string;
}

export function FeesPage(): React.JSX.Element {
  const { can } = useAuth();
  const mayManage = can(PermissionKey.FEE_STRUCTURE_MANAGE);

  const [error, setError] = useState<FormErrorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const categories = useAsyncResource(
    () => feesApi.listFeeCategories({ includeInactive: true }),
    [],
  );
  const structures = useAsyncResource(() => feesApi.listFeeStructures({ pageSize: 100 }), []);
  const years = useAsyncResource(() => academicApi.listAcademicYears(), []);

  /* --------------------------------------------------------- category form */

  const [categoryCode, setCategoryCode] = useState('');
  const [categoryName, setCategoryName] = useState('');

  /* -------------------------------------------------------- structure form */

  const [structureName, setStructureName] = useState('');
  const [structureYearId, setStructureYearId] = useState('');
  const [structureTermId, setStructureTermId] = useState('');
  const [structureResidency, setStructureResidency] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ feeCategoryId: '', label: '', amount: '' }]);

  const selectedYear = (years.data ?? []).find((year) => year.id === structureYearId) ?? null;
  const activeCategories = (categories.data ?? []).filter((category) => category.isActive);

  const run = (action: () => Promise<unknown>, success: string): void => {
    setError(null);
    setNotice(null);
    void action()
      .then(() => {
        setNotice(success);
        categories.refresh();
        structures.refresh();
      })
      .catch((cause: unknown) => {
        setError(toFormError(cause));
      });
  };

  const addCategory = (): void => {
    run(
      () => feesApi.createFeeCategory({ code: categoryCode, name: categoryName }),
      `Added the fee category "${categoryName}".`,
    );
    setCategoryCode('');
    setCategoryName('');
  };

  const addStructure = (): void => {
    run(
      () =>
        feesApi.createFeeStructure({
          name: structureName,
          academicYearId: structureYearId,
          // An empty selection means "once per year", which the API expresses as a null
          // term rather than as a missing field.
          termId: structureTermId === '' ? null : structureTermId,
          ...(structureResidency === ''
            ? {}
            : { residency: structureResidency as 'DAY' | 'BOARDING' }),
          items: items
            .filter((item) => item.feeCategoryId !== '' && item.amount !== '')
            .map((item) => ({
              feeCategoryId: item.feeCategoryId,
              label: item.label,
              amount: item.amount,
            })),
        }),
      `Created "${structureName}" as a draft. Publish it when the amounts are right.`,
    );
    setStructureName('');
    setItems([{ feeCategoryId: '', label: '', amount: '' }]);
  };

  const publish = (structureId: string, version: number, name: string): void => {
    if (
      !window.confirm(
        `Publish "${name}"?\n\nOnce published it can be used to raise charges, and its amounts can no longer be changed.`,
      )
    ) {
      return;
    }
    run(
      () =>
        feesApi.changeFeeStructureStatus(structureId, {
          expectedVersion: version,
          status: 'ACTIVE',
        }),
      `Published "${name}".`,
    );
  };

  const archive = (structureId: string, version: number, name: string): void => {
    if (
      !window.confirm(
        `Archive "${name}"?\n\nIt will stop being used for new charges. Charges already raised from it are kept exactly as they are.`,
      )
    ) {
      return;
    }
    run(
      () =>
        feesApi.changeFeeStructureStatus(structureId, {
          expectedVersion: version,
          status: 'ARCHIVED',
        }),
      `Archived "${name}".`,
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

      {/* ------------------------------------------------------- categories */}

      <Card>
        <CardHeader
          title="Fee categories"
          description="The kinds of fee this school charges. Retired categories are deactivated, never deleted — charges raised against them still name them."
        />
        <CardBody>
          <DataState
            status={categories.status}
            data={categories.data}
            error={categories.error}
            onRetry={categories.refresh}
            loadingLabel="Loading fee categories"
            emptyTitle="No fee categories yet"
            emptyDescription="Add the first one before building a fee structure."
            isEmpty={(data) => data.length === 0}
          >
            {(data) => (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.map((category) => (
                  <li
                    key={category.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {category.name}{' '}
                        <span className="font-mono text-xs text-slate-500">{category.code}</span>
                      </p>
                      <p className="text-sm text-slate-500">
                        {category.chargeCount > 0
                          ? `${String(category.chargeCount)} charge(s) raised`
                          : 'No charges yet'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {category.isActive ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                          Active
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          Inactive
                        </span>
                      )}
                      {mayManage ? (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            run(
                              () =>
                                feesApi.updateFeeCategory(category.id, {
                                  expectedVersion: category.version,
                                  isActive: !category.isActive,
                                }),
                              category.isActive
                                ? `Deactivated "${category.name}".`
                                : `Reactivated "${category.name}".`,
                            );
                          }}
                        >
                          {category.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DataState>

          {mayManage ? (
            <form
              className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800"
              onSubmit={(event) => {
                event.preventDefault();
                addCategory();
              }}
            >
              <TextField
                label="Code"
                value={categoryCode}
                onChange={(event) => {
                  setCategoryCode(event.target.value);
                }}
                placeholder="TUITION"
                required
              />
              <TextField
                label="Name"
                value={categoryName}
                onChange={(event) => {
                  setCategoryName(event.target.value);
                }}
                placeholder="Tuition"
                required
              />
              <Button type="submit">Add category</Button>
            </form>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------------------------------- structures */}

      <Card>
        <CardHeader
          title="Fee structures"
          description="What is charged, to whom, and for which period. A structure applies to a student when every field it specifies matches their enrolment."
        />
        <CardBody>
          <DataState
            status={structures.status}
            data={structures.data?.data}
            error={structures.error}
            onRetry={structures.refresh}
            loadingLabel="Loading fee structures"
            emptyTitle="No fee structures yet"
            emptyDescription="Create one to price a term."
            isEmpty={(data) => data.length === 0}
          >
            {(data) => (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.map((structure) => (
                  <li key={structure.id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {structure.name}
                        </p>
                        <p className="text-sm text-slate-500">
                          {structure.academicYearName} · {structure.termName ?? 'Once per year'}
                          {structure.levelName !== null ? ` · ${structure.levelName}` : ''}
                          {structure.programName !== null ? ` · ${structure.programName}` : ''}
                          {structure.residency !== null
                            ? ` · ${structure.residency === 'BOARDING' ? 'Boarders only' : 'Day students only'}`
                            : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="text-right font-medium text-slate-900 dark:text-slate-100">
                          {formatMoney(structure.totalAmount)}
                        </span>
                        <StatusPill status={structure.status} />
                      </div>
                    </div>

                    <ul className="mt-2 space-y-1">
                      {structure.items.map((item) => (
                        <li
                          key={item.id}
                          className="flex justify-between text-sm text-slate-600 dark:text-slate-300"
                        >
                          <span>{item.label}</span>
                          <span className="tabular-nums">{formatMoney(item.amount)}</span>
                        </li>
                      ))}
                    </ul>

                    {structure.chargeCount > 0 ? (
                      <p className="mt-2 text-xs text-slate-500">
                        {structure.chargeCount} charge(s) raised from this structure, so its amounts
                        are locked. Archive it and create a replacement to change them.
                      </p>
                    ) : null}

                    {mayManage ? (
                      <div className="mt-3 flex gap-2">
                        {structure.status === 'DRAFT' ? (
                          <Button
                            onClick={() => {
                              publish(structure.id, structure.version, structure.name);
                            }}
                          >
                            Publish
                          </Button>
                        ) : null}
                        {structure.status === 'ACTIVE' ? (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              archive(structure.id, structure.version, structure.name);
                            }}
                          >
                            Archive
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </CardBody>
      </Card>

      {/* --------------------------------------------------- new structure */}

      {mayManage ? (
        <Card>
          <CardHeader
            title="New fee structure"
            description="Created as a draft. Nothing is charged until it is published and a charge run is applied."
          />
          <CardBody>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                addStructure();
              }}
            >
              <div className="flex flex-wrap gap-3">
                <TextField
                  label="Name"
                  value={structureName}
                  onChange={(event) => {
                    setStructureName(event.target.value);
                  }}
                  placeholder="S1 Term 1 2026"
                  required
                />

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    Academic year
                  </span>
                  <select
                    className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    value={structureYearId}
                    onChange={(event) => {
                      setStructureYearId(event.target.value);
                      setStructureTermId('');
                    }}
                    required
                  >
                    <option value="">Select a year</option>
                    {(years.data ?? []).map((year) => (
                      <option key={year.id} value={year.id}>
                        {year.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Term</span>
                  <select
                    className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    value={structureTermId}
                    onChange={(event) => {
                      setStructureTermId(event.target.value);
                    }}
                  >
                    <option value="">Once per year</option>
                    {(selectedYear?.terms ?? []).map((term) => (
                      <option key={term.id} value={term.id}>
                        {term.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Applies to</span>
                  <select
                    className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    value={structureResidency}
                    onChange={(event) => {
                      setStructureResidency(event.target.value);
                    }}
                  >
                    <option value="">Day students and boarders</option>
                    <option value="BOARDING">Boarders only</option>
                    <option value="DAY">Day students only</option>
                  </select>
                </label>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Fee items</p>
                {items.map((item, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-slate-600 dark:text-slate-300">Category</span>
                      <select
                        className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                        value={item.feeCategoryId}
                        onChange={(event) => {
                          const next = [...items];
                          next[index] = { ...item, feeCategoryId: event.target.value };
                          setItems(next);
                        }}
                      >
                        <option value="">Select</option>
                        {activeCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <TextField
                      label="Label"
                      value={item.label}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { ...item, label: event.target.value };
                        setItems(next);
                      }}
                      placeholder="Tuition — Term 1"
                    />

                    <TextField
                      label="Amount"
                      value={item.amount}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { ...item, amount: event.target.value };
                        setItems(next);
                      }}
                      // A text field, not a number input: the amount is sent as a string
                      // so it never becomes a float on the way to the server.
                      inputMode="decimal"
                      placeholder="95000.00"
                    />
                  </div>
                ))}

                <div>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      setItems([...items, { feeCategoryId: '', label: '', amount: '' }]);
                    }}
                  >
                    Add another item
                  </Button>
                </div>
              </div>

              <div>
                <Button type="submit">Create draft structure</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const styles: Record<string, string> = {
    DRAFT: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    ACTIVE: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    ARCHIVED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? styles.ARCHIVED ?? ''}`}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
