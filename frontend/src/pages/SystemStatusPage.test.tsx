import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ErrorCode, type HealthReport } from '@sfs/shared';

import { SystemStatusPage } from './SystemStatusPage';
import { stubFetchNetworkError, stubFetchResponse, stubFetchSequence } from '../tests/fetch-mock';

const healthyReport: HealthReport = {
  status: 'ok',
  service: 'school-finance-system-api',
  version: '0.1.0',
  environment: 'test',
  timestamp: '2026-09-18T08:30:00.000Z',
  uptimeSeconds: 93,
  dependencies: [{ name: 'postgres', status: 'ok', latencyMs: 4 }],
};

describe('SystemStatusPage', () => {
  it('shows a loading state, then the live report from the API', async () => {
    stubFetchResponse({ status: 200, body: { data: healthyReport } });
    render(<SystemStatusPage />);

    expect(screen.getByText('Checking system status')).toBeInTheDocument();

    expect(await screen.findByText('school-finance-system-api')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('postgres')).toBeInTheDocument();
    expect(screen.getByText('4 ms')).toBeInTheDocument();
    // 93 seconds, formatted by the presentation layer.
    expect(screen.getByText('1m 33s')).toBeInTheDocument();
    expect(screen.getAllByText('Operational').length).toBeGreaterThan(0);
  });

  it('renders a degraded dependency with its detail rather than hiding it', async () => {
    stubFetchResponse({
      status: 200,
      body: {
        data: {
          ...healthyReport,
          status: 'degraded',
          dependencies: [
            {
              name: 'postgres',
              status: 'degraded',
              latencyMs: 812,
              detail: 'Query latency 812ms exceeds 500ms',
            },
          ],
        } satisfies HealthReport,
      },
    });

    render(<SystemStatusPage />);
    expect(await screen.findByText('Query latency 812ms exceeds 500ms')).toBeInTheDocument();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0);
  });

  it('shows a retryable error when the API cannot be reached', async () => {
    stubFetchNetworkError();
    render(<SystemStatusPage />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('surfaces the request id from a server error so a user can quote it', async () => {
    stubFetchResponse({
      status: 503,
      requestId: 'req-xyz-789',
      body: {
        error: {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          message: 'The service is temporarily unavailable. Please try again shortly.',
          requestId: 'req-xyz-789',
          timestamp: '2026-09-18T08:30:00.000Z',
        },
      },
    });

    render(<SystemStatusPage />);
    expect(await screen.findByText(/Reference: req-xyz-789/)).toBeInTheDocument();
  });

  it('recovers when the user retries after a failure', async () => {
    stubFetchSequence([
      { status: 200, body: { data: { ...healthyReport, status: 'down' } } },
      { status: 200, body: { data: healthyReport } },
    ]);

    render(<SystemStatusPage />);
    expect(await screen.findByText('school-finance-system-api')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(screen.getAllByText('Operational').length).toBeGreaterThan(0);
    });
  });
});
