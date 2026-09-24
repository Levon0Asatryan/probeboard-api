import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import { ProbeResultRepository } from '../../storage/repositories/probe-result.repository.js';
import type { NewProbeResult } from '../../storage/utils/outcome-mapping.js';
import { EndpointRuntimeRepository } from '../repositories/endpoint-runtime.repository.js';

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
   * `statement_timeout` from `timeoutMs()` (recomputed, so a late attempt is
   * not handed a fresh shutdown grace). Idempotent by the row's key. The last
   * failure is rethrown; the caller leaves the lease to lapse.
   */
  async recordAndRelease(
    row: NewProbeResult,
    fence: Fence,
    timeoutMs: () => number,
  ): Promise<{ inserted: number; released: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.cfg.RESULT_WRITE_ATTEMPTS; attempt++) {
      try {
        return await this.db.kysely.transaction().execute(async (trx) => {
          await sql`SET LOCAL statement_timeout = ${sql.lit(Math.max(1, Math.trunc(timeoutMs())))}`.execute(
            trx,
          );
          const inserted = await this.results.insert(row, trx);
          const rel = await this.runtime
            .releaseQuery(fence.endpointId, fence.workerId, fence.slot)
            .execute(trx);
          return { inserted, released: Number(rel.numAffectedRows ?? 0n) };
        });
      } catch (err) {
        lastError = err;
        if (attempt < this.cfg.RESULT_WRITE_ATTEMPTS)
          await delay(this.cfg.RESULT_WRITE_BACKOFF_MS * attempt);
      }
    }
    throw lastError;
  }
}
