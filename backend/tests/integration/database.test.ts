/**
 * Proves the Phase 0 database chain actually works: env config -> Prisma 7 driver
 * adapter -> connection pool -> PostgreSQL.
 *
 * These tests require a running PostgreSQL instance (`npm run db:up` locally, a service
 * container in CI). They are meant to fail loudly when it is missing -- a green suite
 * that silently skipped the database would defeat the purpose.
 */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase, prisma } from '../../src/lib/prisma.js';

afterAll(async () => {
  await disconnectDatabase();
});

describe('database connectivity', () => {
  it('connects and answers a trivial query', async () => {
    await expect(connectDatabase()).resolves.toBeUndefined();
  });

  it('runs a parameterised query through the driver adapter', async () => {
    const rows = await prisma.$queryRaw<Array<{ answer: number }>>`SELECT 1 + 1 AS answer`;
    expect(rows[0]?.answer).toBe(2);
  });

  it('stores and returns NUMERIC(14,2) without floating-point drift', async () => {
    // The money representation chosen in Section 3, verified against the real engine
    // rather than assumed: 0.1 + 0.2 must be exactly 0.30.
    const rows = await prisma.$queryRaw<
      Array<{ total: string }>
    >`SELECT (0.1::numeric(14,2) + 0.2::numeric(14,2))::text AS total`;
    expect(rows[0]?.total).toBe('0.30');
  });

  it('rejects a monetary value that exceeds NUMERIC(14,2)', async () => {
    await expect(
      prisma.$queryRaw`SELECT 1000000000000.00::numeric(14,2) AS too_big`,
    ).rejects.toThrow();
  });

  it('runs with the session time zone in UTC, matching how timestamps are stored', async () => {
    // `current_setting` is used rather than `SHOW timezone`, whose result column is
    // named `TimeZone` and would have to be quoted to read back.
    const rows = await prisma.$queryRaw<
      Array<{ zone: string }>
    >`SELECT current_setting('TimeZone') AS zone`;
    expect(rows[0]?.zone).toMatch(/^(UTC|Etc\/UTC)$/i);
  });

  it('rolls an interactive transaction back on failure, leaving nothing behind', async () => {
    // The guarantee every multi-step financial write depends on (Section 28).
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`CREATE TEMPORARY TABLE sfs_tx_probe (id int)`;
        await tx.$executeRaw`INSERT INTO sfs_tx_probe (id) VALUES (1)`;
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    // The temporary table is gone with the transaction, so this must fail.
    await expect(prisma.$queryRaw`SELECT count(*) FROM sfs_tx_probe`).rejects.toThrow();
  });
});

describe('readiness against the real database', () => {
  it('reports the database as reachable', async () => {
    const response = await request(createApp()).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.dependencies[0].name).toBe('postgres');
    expect(response.body.data.dependencies[0].latencyMs).toBeTypeOf('number');
  });
});
