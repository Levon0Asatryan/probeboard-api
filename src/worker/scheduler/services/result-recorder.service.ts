import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import { ProbeResultRepository } from '../../storage/repositories/probe-result.repository.js';
import type { NewProbeResult } from '../../storage/utils/outcome-mapping.js';
import { EndpointRuntimeRepository } from '../repositories/endpoint-runtime.repository.js';

/** What the caller still allows a terminal write: see `SchedulerService.terminalWriteBudget`. */
export interface WriteBudget {
  /** The bound for the next statement, and the longest a backoff may sleep. Never 0. */
  timeoutMs: number;
  /** The shutdown grace has passed: no further attempt may start. */
  expired: boolean;
}

export interface Fence {
  endpointId: string;
  workerId: string;
  slot: string;
}

/**
 * The terminal write of a probed slot: the result and the lease release in
 * **one transaction** (docs/m5-plan.md §3.3).
 *
 * The result is the observation and the release is bookkeeping, so a fence
 * that matches no row (the lease was already lost) still commits the insert.
 * Separate writes could leave the lease cleared with no result -- a slot the
 * UNKNOWN sweep would believe was observed.
 */
@Injectable()
export class ResultRecorderService {
  constructor(
    private readonly db: DbService,
    private readonly results: ProbeResultRepository,
    private readonly runtime: EndpointRuntimeRepository,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Up to `RESULT_WRITE_ATTEMPTS` attempts, each with its own
   * `statement_timeout` from `budget()` (recomputed, so a late attempt is not
   * handed a fresh shutdown grace). Idempotent by the row's key. The last
   * failure is rethrown; the caller leaves the lease to lapse.
   *
   * A retry never outlives the shutdown deadline: each backoff is capped at the
   * time remaining, and once the budget is `expired` no attempt starts -- after
   * the grace `ProbePoolService.drain` has reported the slot "still running"
   * and `main.ts` is about to close the database pool, so a later retry would
   * run against a pool that is going away (docs/m4-plan.md §3.9).
   */
  async recordAndRelease(
    row: NewProbeResult,
    fence: Fence,
    budget: () => WriteBudget,
  ): Promise<{ inserted: number; released: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.cfg.RESULT_WRITE_ATTEMPTS; attempt++) {
      if (attempt > 1 && budget().expired) break;
      try {
        return await this.db.kysely.transaction().execute(async (trx) => {
          // `statement_timeout` applies to each statement on its own, so one
          // SET LOCAL would give the release a fresh full timeout after the
          // insert had spent part of the budget. Re-derive the remaining time
          // before **each** statement (the same rule as the monitor loader).
          const bound = () =>
            sql`SET LOCAL statement_timeout = ${sql.lit(Math.max(1, Math.trunc(budget().timeoutMs)))}`.execute(
              trx,
            );
          await bound();
          const inserted = await this.results.insert(row, trx);
          await bound();
          const rel = await this.runtime
            .releaseQuery(fence.endpointId, fence.workerId, fence.slot)
            .execute(trx);
          return { inserted, released: Number(rel.numAffectedRows ?? 0n) };
        });
      } catch (err) {
        lastError = err;
        const left = budget();
        if (attempt < this.cfg.RESULT_WRITE_ATTEMPTS && !left.expired) {
          await delay(Math.min(this.cfg.RESULT_WRITE_BACKOFF_MS * attempt, left.timeoutMs));
        }
      }
    }
    throw lastError;
  }
}
