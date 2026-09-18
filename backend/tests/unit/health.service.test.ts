import { describe, expect, it, vi } from 'vitest';

import { HealthService, type DatabaseProbe } from '../../src/modules/health/health.service.js';

const FIXED_NOW = new Date('2026-09-18T08:30:00.000Z');

function buildService(
  probe: DatabaseProbe,
  overrides: { slowDependencyMs?: number; probeTimeoutMs?: number } = {},
): HealthService {
  return new HealthService({
    database: probe,
    serviceName: 'school-finance-system-api',
    version: '0.1.0-test',
    environment: 'test',
    now: () => FIXED_NOW,
    uptimeSeconds: () => 93,
    ...overrides,
  });
}

const healthyProbe: DatabaseProbe = { ping: () => Promise.resolve() };

describe('HealthService.liveness', () => {
  it('reports ok without consulting any dependency', () => {
    const ping = vi.fn(() => Promise.resolve());
    const service = buildService({ ping });

    expect(service.liveness()).toEqual({
      status: 'ok',
      service: 'school-finance-system-api',
      version: '0.1.0-test',
      timestamp: '2026-09-18T08:30:00.000Z',
      uptimeSeconds: 93,
    });
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('HealthService.readiness', () => {
  it('reports ok when the database answers quickly', async () => {
    const report = await buildService(healthyProbe).readiness();

    expect(report.status).toBe('ok');
    expect(report.environment).toBe('test');
    expect(report.dependencies).toHaveLength(1);
    expect(report.dependencies[0]?.name).toBe('postgres');
    expect(report.dependencies[0]?.status).toBe('ok');
    expect(report.dependencies[0]?.latencyMs).toBeTypeOf('number');
  });

  it('reports degraded when the database is reachable but slow', async () => {
    const slowProbe: DatabaseProbe = {
      ping: () => new Promise((resolve) => setTimeout(resolve, 40)),
    };
    // Threshold below the probe's latency, so the slow path is exercised deterministically.
    const report = await buildService(slowProbe, { slowDependencyMs: 10 }).readiness();

    expect(report.status).toBe('degraded');
    expect(report.dependencies[0]?.status).toBe('degraded');
    expect(report.dependencies[0]?.detail).toMatch(/exceeds 10ms/);
  });

  it('reports down when the database rejects', async () => {
    const failingProbe: DatabaseProbe = {
      ping: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5432')),
    };
    const report = await buildService(failingProbe).readiness();

    expect(report.status).toBe('down');
    expect(report.dependencies[0]?.status).toBe('down');
    expect(report.dependencies[0]?.detail).toBe('Database connection failed');
  });

  it('never leaks the driver error message, which can contain credentials', async () => {
    const leakyProbe: DatabaseProbe = {
      ping: () =>
        Promise.reject(
          new Error('connect failed for postgresql://sfs:sup3rs3cret@db.internal:5432/school'),
        ),
    };
    const report = await buildService(leakyProbe).readiness();

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('sup3rs3cret');
    expect(serialised).not.toContain('db.internal');
  });

  it('gives up on a hanging probe instead of blocking the health check forever', async () => {
    const hangingProbe: DatabaseProbe = { ping: () => new Promise<void>(() => undefined) };
    const report = await buildService(hangingProbe, { probeTimeoutMs: 25 }).readiness();

    expect(report.status).toBe('down');
    expect(report.dependencies[0]?.detail).toBe('Database did not respond in time');
  });
});
