/**
 * Health and readiness checks.
 *
 * Liveness answers "is this process running?"; readiness answers "can it actually serve
 * traffic?", which for this system means the database is reachable. The distinction
 * matters at deploy time: a container that is alive but not ready must not receive
 * payment traffic.
 *
 * The database is reached through a narrow `DatabaseProbe` port rather than the Prisma
 * client directly, so this service is unit-testable without a database.
 */
import type { DependencyHealth, HealthReport, HealthStatus } from '@sfs/shared';

export interface DatabaseProbe {
  /** Resolves when the database answers a trivial query; rejects otherwise. */
  ping(): Promise<void>;
}

export interface HealthServiceOptions {
  readonly database: DatabaseProbe;
  readonly serviceName: string;
  readonly version: string;
  readonly environment: string;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
  readonly uptimeSeconds?: () => number;
  /** A probe slower than this is reported as degraded rather than healthy. */
  readonly slowDependencyMs?: number;
  readonly probeTimeoutMs?: number;
}

const DEFAULT_SLOW_DEPENDENCY_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Probe timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class HealthService {
  private readonly slowDependencyMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => Date;
  private readonly uptimeSeconds: () => number;

  constructor(private readonly options: HealthServiceOptions) {
    this.slowDependencyMs = options.slowDependencyMs ?? DEFAULT_SLOW_DEPENDENCY_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.now = options.now ?? ((): Date => new Date());
    this.uptimeSeconds = options.uptimeSeconds ?? ((): number => Math.round(process.uptime()));
  }

  /** Liveness: no dependencies consulted, so it stays fast and never flaps. */
  liveness(): Pick<HealthReport, 'status' | 'service' | 'version' | 'timestamp' | 'uptimeSeconds'> {
    return {
      status: 'ok',
      service: this.options.serviceName,
      version: this.options.version,
      timestamp: this.now().toISOString(),
      uptimeSeconds: this.uptimeSeconds(),
    };
  }

  /** Readiness: probes every dependency and aggregates to the worst status seen. */
  async readiness(): Promise<HealthReport> {
    const dependencies = [await this.probeDatabase()];
    return {
      status: worstStatus(dependencies.map((dependency) => dependency.status)),
      service: this.options.serviceName,
      version: this.options.version,
      environment: this.options.environment,
      timestamp: this.now().toISOString(),
      uptimeSeconds: this.uptimeSeconds(),
      dependencies,
    };
  }

  private async probeDatabase(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    try {
      await withTimeout(this.options.database.ping(), this.probeTimeoutMs);
      const latencyMs = Date.now() - startedAt;
      return {
        name: 'postgres',
        status: latencyMs > this.slowDependencyMs ? 'degraded' : 'ok',
        latencyMs,
        ...(latencyMs > this.slowDependencyMs
          ? {
              detail: `Query latency ${String(latencyMs)}ms exceeds ${String(this.slowDependencyMs)}ms`,
            }
          : {}),
      };
    } catch (error) {
      return {
        name: 'postgres',
        status: 'down',
        latencyMs: Date.now() - startedAt,
        // Deliberately not the raw driver message: it can contain the host, user and
        // sometimes the password from the connection string.
        detail:
          error instanceof Error && error.message.includes('timed out')
            ? 'Database did not respond in time'
            : 'Database connection failed',
      };
    }
  }
}
