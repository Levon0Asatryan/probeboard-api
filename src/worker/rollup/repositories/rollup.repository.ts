import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database } from '../../../core/db/types.js';
import { HISTOGRAM_BUCKETS, HISTOGRAM_EDGES_MS } from '../../../core/stats/constants.js';

export interface RollupPass {
  /** `true` when another worker held the state row and this pass did nothing. */
  skipped: boolean;
  /** Result rows folded by this pass. */
  folded: number;
  /** How long since the watermark was last written, before this pass wrote it. */
  lagMs: number;
}

interface Grain {
  grain: 'm1' | 'h1' | 'd1';
  unit: 'minute' | 'hour' | 'day';
}
const GRAINS: readonly Grain[] = [
  { grain: 'm1', unit: 'minute' },
  { grain: 'h1', unit: 'hour' },
  { grain: 'd1', unit: 'day' },
];

/**
 * The rollup, and nothing else (docs/m5-plan.md §3.4, §3.5).
 *
 * **Exactly once.** The fold and the watermark advance commit in one
 * transaction: a failure between them rolls back both, so the retry re-reads the
 * same rows and applies them once.
 *
 * **No row lost to commit order.** The watermark is over `insert_xid`, bounded
 * by `pg_snapshot_xmin(pg_current_snapshot())`, read **once** per pass and bound
 * as a parameter. Every transaction with a smaller xid has committed or aborted,
 * so a row below the horizon is final; a row that commits late is held back until
 * it is below it. A timestamp watermark loses that row for ever (plan §2.4.3).
 * Under READ COMMITTED each statement takes a fresh snapshot, so the horizon
 * must not be re-evaluated mid-pass.
 *
 * **Single-flight.** `FOR UPDATE SKIP LOCKED` on the one state row: a second
 * worker's pass returns at once instead of waiting or double-folding.
 */
@Injectable()
export class RollupRepository {
  constructor(private readonly db: DbService) {}

  async runOnce(batchXids: number): Promise<RollupPass> {
    return this.db.kysely.transaction().execute(async (trx) => {
      const state = await sql<{ last_xid: string; lag_ms: number }>`
        SELECT last_xid::text AS last_xid,
               (extract(epoch FROM now() - advanced_at) * 1000)::float8 AS lag_ms
        FROM   rollup_state
        WHERE  name = 'probe_results'
        FOR UPDATE SKIP LOCKED
      `.execute(trx);
      const row = state.rows[0];
      if (!row) return { skipped: true, folded: 0, lagMs: 0 };

      const horizon = (
        await sql<{
          h: string;
        }>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h`.execute(trx)
      ).rows[0].h;

      let last = row.last_xid;
      let folded = 0;
      for (;;) {
        // The (n+1)-th distinct xid at or above `last` and below the horizon:
        // a batch is exactly n whole transactions, so n = 1 still advances.
        const nth = await sql<{ upper: string }>`
          SELECT insert_xid::text AS upper
          FROM  (SELECT DISTINCT insert_xid
                 FROM   probe_results
                 WHERE  insert_xid >= ${last}::xid8 AND insert_xid < ${horizon}::xid8
                 ORDER  BY insert_xid
                 OFFSET ${batchXids} LIMIT 1) t
        `.execute(trx);
        const upper = nth.rows[0]?.upper ?? horizon;
        folded += await this.fold(trx, last, upper);
        last = upper;
        if (nth.rows.length === 0) break;
      }

      await sql`
        UPDATE rollup_state
        SET    last_xid    = ${last}::xid8,
               -- Only when the watermark moved: with a write transaction held open
               -- the horizon cannot pass it, and refreshing this here would hide
               -- that stall from the stale-watermark warning.
               advanced_at = CASE WHEN last_xid IS DISTINCT FROM ${last}::xid8
                                  THEN now() ELSE advanced_at END
        WHERE  name = 'probe_results'
      `.execute(trx);
      return { skipped: false, folded, lagMs: row.lag_ms };
    });
  }

  /**
   * Folds every row with `lower <= insert_xid < upper` into m1, h1 and d1 in one
   * statement. All three grains are derived from the **same batch**, never from
   * each other, so no grain can drift from another.
   */
  private async fold(trx: Transaction<Database>, lower: string, upper: string): Promise<number> {
    const result = await this.foldQuery(lower, upper).execute(trx);
    return Number((result.rows[0] as { folded: number | string } | undefined)?.folded ?? 0);
  }

  foldQuery(lower: string, upper: string): RawBuilder<unknown> {
    const edges = sql.raw(`ARRAY[${HISTOGRAM_EDGES_MS.join(',')}]::int[]`);
    // Latency population (D6): rows whose endpoint produced response headers.
    const bucketCounts = sql.join(
      Array.from(
        { length: HISTOGRAM_BUCKETS },
        (_, i) => sql`(count(*) FILTER (WHERE responded AND b = ${i + 1}))::int`,
      ),
    );
    const agg = (g: Grain) => sql`
      SELECT endpoint_id,
             ${sql.lit(g.grain)}::stat_grain                       AS granularity,
             date_trunc(${sql.lit(g.unit)}, started_at, 'UTC')     AS bucket_start,
             (count(*) FILTER (WHERE outcome = 'up'))::int         AS count_up,
             (count(*) FILTER (WHERE outcome = 'down'))::int       AS count_down,
             (count(*) FILTER (WHERE outcome = 'degraded'))::int   AS count_degraded,
             (count(*) FILTER (WHERE outcome = 'unknown'))::int    AS count_unknown,
             coalesce(sum(interval_s) FILTER (WHERE outcome IN ('up','down','degraded')), 0)::int AS covered_seconds,
             coalesce(sum(interval_s) FILTER (WHERE outcome = 'up'), 0)::int        AS up_seconds,
             coalesce(sum(interval_s) FILTER (WHERE outcome = 'degraded'), 0)::int  AS degraded_seconds,
             coalesce(sum(total_ms) FILTER (WHERE responded), 0)::bigint AS sum_total_ms,
             min(total_ms) FILTER (WHERE responded)                AS min_total_ms,
             max(total_ms) FILTER (WHERE responded)                AS max_total_ms,
             coalesce(sum(ttfb_ms) FILTER (WHERE responded), 0)::bigint  AS sum_ttfb_ms,
             ARRAY[${bucketCounts}]::int[]                         AS hist_total
      FROM   folded_rows
      GROUP  BY endpoint_id, date_trunc(${sql.lit(g.unit)}, started_at, 'UTC')
      ORDER  BY endpoint_id, bucket_start
    `;
    const upsert = (g: Grain) => sql`
      INSERT INTO probe_stats AS s (
        endpoint_id, granularity, bucket_start, count_up, count_down, count_degraded,
        count_unknown, covered_seconds, up_seconds, degraded_seconds, sum_total_ms,
        min_total_ms, max_total_ms, sum_ttfb_ms, hist_total)
      SELECT * FROM (${agg(g)}) a
      ON CONFLICT (endpoint_id, granularity, bucket_start) DO UPDATE SET
        count_up         = s.count_up         + EXCLUDED.count_up,
        count_down       = s.count_down       + EXCLUDED.count_down,
        count_degraded   = s.count_degraded   + EXCLUDED.count_degraded,
        count_unknown    = s.count_unknown    + EXCLUDED.count_unknown,
        covered_seconds  = s.covered_seconds  + EXCLUDED.covered_seconds,
        up_seconds       = s.up_seconds       + EXCLUDED.up_seconds,
        degraded_seconds = s.degraded_seconds + EXCLUDED.degraded_seconds,
        sum_total_ms     = s.sum_total_ms     + EXCLUDED.sum_total_ms,
        min_total_ms     = least(s.min_total_ms, EXCLUDED.min_total_ms),
        max_total_ms     = greatest(s.max_total_ms, EXCLUDED.max_total_ms),
        sum_ttfb_ms      = s.sum_ttfb_ms      + EXCLUDED.sum_ttfb_ms,
        hist_total       = ARRAY(
          SELECT h.a + h.b
          FROM   unnest(s.hist_total, EXCLUDED.hist_total) WITH ORDINALITY AS h(a, b, ord)
          ORDER  BY h.ord)
    `;
    // Data-modifying CTEs always run to completion; the outer SELECT only
    // reports how many rows were folded.
    return sql`
      WITH batch AS MATERIALIZED (
        SELECT endpoint_id, started_at, outcome, interval_s, total_ms, ttfb_ms
        FROM   probe_results
        WHERE  insert_xid >= ${lower}::xid8 AND insert_xid < ${upper}::xid8
      ),
      folded_rows AS MATERIALIZED (
        SELECT *,
               (ttfb_ms IS NOT NULL) AS responded,
               width_bucket(total_ms - 1, ${edges}) + 1 AS b
        FROM   batch
      ),
      m1 AS (${upsert(GRAINS[0])} RETURNING 1),
      h1 AS (${upsert(GRAINS[1])} RETURNING 1),
      d1 AS (${upsert(GRAINS[2])} RETURNING 1)
      SELECT (SELECT count(*) FROM batch)::int AS folded
      FROM   (SELECT 1 FROM m1 UNION ALL SELECT 1 FROM h1 UNION ALL SELECT 1 FROM d1) forced
      LIMIT  1
    `;
  }
}
