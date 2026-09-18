import { useCallback } from 'react';

import { API_BASE_PATH, type DependencyHealth, type HealthReport } from '@sfs/shared';

import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { DataState } from '../components/ui/DataState';
import { Button } from '../components/ui/Button';
import { useAsyncResource } from '../hooks/use-async-resource';
import { api } from '../lib/api-client';
import { formatDateTime, formatDuration } from '../lib/format';

const STATUS_STYLES: Record<HealthReport['status'], string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  degraded: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  down: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

const STATUS_LABELS: Record<HealthReport['status'], string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Unavailable',
};

function StatusPill({ status }: { readonly status: HealthReport['status'] }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-sm text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="text-sm font-medium text-slate-900 sm:text-right dark:text-slate-100">
        {value}
      </dd>
    </div>
  );
}

function DependencyRow({
  dependency,
}: {
  readonly dependency: DependencyHealth;
}): React.JSX.Element {
  return (
    <tr className="border-t border-slate-200 dark:border-slate-800">
      <th
        scope="row"
        className="py-2 pr-4 text-left text-sm font-medium text-slate-900 dark:text-slate-100"
      >
        {dependency.name}
      </th>
      <td className="py-2 pr-4">
        <StatusPill status={dependency.status} />
      </td>
      <td className="tabular py-2 pr-4 text-sm text-slate-700 dark:text-slate-300">
        {dependency.latencyMs === undefined ? '—' : `${String(dependency.latencyMs)} ms`}
      </td>
      <td className="py-2 text-sm text-slate-600 dark:text-slate-400">
        {dependency.detail ?? '—'}
      </td>
    </tr>
  );
}

/**
 * Live system status, read from `GET /api/v1/health`.
 *
 * Every value on this page comes from the running backend and its real database probe --
 * nothing is hard-coded. It is also the end-to-end proof that the Phase 0 chain
 * (UI -> API client -> Express -> Prisma -> PostgreSQL -> response -> UI) is connected.
 */
export function SystemStatusPage(): React.JSX.Element {
  const fetchHealth = useCallback(
    (signal: AbortSignal): Promise<HealthReport> =>
      api.get<HealthReport>(`${API_BASE_PATH}/health`, { signal }),
    [],
  );

  const { status, data, error, refresh, isRefreshing } = useAsyncResource(fetchHealth);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            System status
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Live health of the finance API and the services it depends on.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={refresh}
          isLoading={isRefreshing}
          loadingLabel="Refreshing"
        >
          Refresh
        </Button>
      </div>

      <DataState
        status={status}
        data={data}
        error={error}
        onRetry={refresh}
        loadingLabel="Checking system status"
      >
        {(report): React.JSX.Element => (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card ariaLabelledBy="service-details">
              <CardHeader
                titleId="service-details"
                title="Finance API"
                description="The service that records charges, payments and receipts."
                actions={<StatusPill status={report.status} />}
              />
              <CardBody>
                <dl className="divide-y divide-slate-200 dark:divide-slate-800">
                  <DetailRow label="Service" value={report.service} />
                  <DetailRow label="Version" value={report.version} />
                  <DetailRow label="Environment" value={report.environment} />
                  <DetailRow
                    label="Running for"
                    value={<span className="tabular">{formatDuration(report.uptimeSeconds)}</span>}
                  />
                  <DetailRow
                    label="Checked at"
                    value={formatDateTime(report.timestamp, { withSeconds: true })}
                  />
                </dl>
              </CardBody>
            </Card>

            <Card ariaLabelledBy="dependency-details">
              <CardHeader
                titleId="dependency-details"
                title="Dependencies"
                description="Each dependency is probed on every check, not cached."
              />
              <CardBody>
                <table className="w-full border-collapse text-left">
                  <caption className="sr-only">
                    Health of each service the finance API depends on
                  </caption>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="pb-2 pr-4 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                      >
                        Service
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pr-4 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                      >
                        Status
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pr-4 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                      >
                        Latency
                      </th>
                      <th
                        scope="col"
                        className="pb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                      >
                        Detail
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.dependencies.map((dependency) => (
                      <DependencyRow key={dependency.name} dependency={dependency} />
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          </div>
        )}
      </DataState>
    </div>
  );
}
