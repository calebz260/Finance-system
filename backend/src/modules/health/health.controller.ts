/**
 * Health endpoints.
 *
 * Thin by design: the controller translates between HTTP and the service, and contains
 * no logic of its own. This is the pattern every module in the system follows
 * (controller -> service -> repository).
 */
import type { Request, Response } from 'express';

import { HttpStatus, sendSuccess } from '../../lib/http.js';
import type { HealthService } from './health.service.js';

export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Liveness probe. Always 200 while the process can answer. */
  liveness = (_req: Request, res: Response): void => {
    sendSuccess(res, this.healthService.liveness());
  };

  /**
   * Readiness probe. Returns 503 when a dependency is down so an orchestrator stops
   * routing traffic here instead of failing requests one by one.
   */
  readiness = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.healthService.readiness();
    const status = report.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;
    sendSuccess(res, report, { status });
  };
}
