import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
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
   *
   * `in_maintenance` is decided **by this statement**, never by the caller:
   * a window on the endpoint or on its service covering `started_at`, in
   * `[starts_at, ends_at)` (docs/m6-plan.md §3.2, §3.7). In the insert itself,
   * so there is no extra round trip and no window can be judged against a
   * different instant from the one the row stores. Both reads are plain
   * `SELECT`s: nothing here locks `endpoints` or `maintenance_windows`, so the
   * API editing either cannot block a result write. Once written, the flag is
   * the only record of the verdict -- a window edited later changes nothing
   * already stored.
   */
  async insert(row: NewProbeResult, executor: Kysely<Database> = this.db.kysely): Promise<number> {
    const at = sql`${row.started_at}::timestamptz`;
    const covering = (target: ReturnType<typeof sql>) => sql`
      EXISTS (SELECT 1 FROM maintenance_windows w
               WHERE ${target}
                 AND w.starts_at <= ${at} AND w.ends_at > ${at})`;
    const inMaintenance = sql<boolean>`(
      ${covering(sql`w.endpoint_id = ${row.endpoint_id}`)}
      OR ${covering(
        sql`w.service_id = (SELECT e.service_id FROM endpoints e WHERE e.id = ${row.endpoint_id})`,
      )})`;

    const result = await executor
      .insertInto('probe_results')
      .values({ ...row, in_maintenance: inMaintenance })
      .onConflict((oc) => oc.columns(['endpoint_id', 'started_at', 'attempt_id']).doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
}
