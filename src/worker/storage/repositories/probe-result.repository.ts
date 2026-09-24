import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database } from '../../../core/db/types.js';
import type { NewProbeResult } from '../utils/outcome-mapping.js';

@Injectable()
export class ProbeResultRepository {
  constructor(private readonly db: DbService) {}

  /**
   * `ON CONFLICT DO NOTHING` on the whole key: a retry of one attempt's write
   * carries the same `attempt_id` and `started_at`, so it is idempotent, while
   * a different attempt -- even in the same millisecond -- is its own row.
   * Returns the rows written (0 for a retry that had already committed).
   */
  async insert(row: NewProbeResult, executor: Kysely<Database> = this.db.kysely): Promise<number> {
    const result = await executor
      .insertInto('probe_results')
      .values(row)
      .onConflict((oc) => oc.columns(['endpoint_id', 'started_at', 'attempt_id']).doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
}
