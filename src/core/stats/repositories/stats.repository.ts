import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../db/db.service.js';
import { NotFoundError } from '../../errors/app-error.js';
import { HISTOGRAM_BUCKETS } from '../constants.js';
import { emptyHistogram, histogramCount, mergeHistograms } from '../histogram.js';
import { percentile } from '../percentile.js';
import {
  oldestNeeded,
  planWindow,
  WindowError,
  type RetainedFrom,
  type WindowPlan,
} from '../window.js';

export interface WindowStats {
  counts: { up: number; down: number; degraded: number; unknown: number };
  /** Seconds observed (up + down + degraded); an unknown probe adds none. */
  coveredSeconds: number;
  upSeconds: number;
  degradedSeconds: number;
  latency: {
    /** Probes whose endpoint produced response headers (docs/m5-plan.md D6). */
    count: number;
    avgTotalMs: number | null;
    avgTtfbMs: number | null;
    minMs: number | null;
    maxMs: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  histogram: number[];
  /** Aggregate rows read -- the number NFR-9 is about. */
  rowsRead: number;
  tiles: { d1: number; h1: number; m1: number };
}

interface StatRow {
  owned_id: string;
  granularity: 'm1' | 'h1' | 'd1' | null;
  count_up: number | null;
  count_down: number | null;
  count_degraded: number | null;
  count_unknown: number | null;
  covered_seconds: number | null;
  up_seconds: number | null;
  degraded_seconds: number | null;
  sum_total_ms: string | null;
  min_total_ms: number | null;
  max_total_ms: number | null;
  sum_ttfb_ms: string | null;
  hist_total: number[] | null;
}

/**
 * Reads aggregates only -- never `probe_results`. A long window is served from at
 * most ~30 `d1` and ~46 `h1` rows for 30 days, not 43,200 raw rows per monitor
 * (NFR-9), and it still answers after retention has dropped the raw partitions.
 */
@Injectable()
export class StatsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * The oldest partition that still exists for each retention-bound grain,
   * read from the catalogue (no scan). A partition mid-detach no longer counts.
   */
  async retainedFrom(): Promise<RetainedFrom> {
    const { rows } = await sql<{ m1: string | null; h1: string | null }>`
      SELECT
        (SELECT min(substring(c.relname FROM '_p([0-9]{8})$'))
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'probe_stats_m1'::regclass AND NOT i.inhdetachpending) AS m1,
        (SELECT min(substring(c.relname FROM '_p([0-9]{6})$'))
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'probe_stats_h1'::regclass AND NOT i.inhdetachpending) AS h1
    `.execute(this.db.kysely);
    const r = rows[0];
    return {
      m1: r?.m1
        ? new Date(
            Date.UTC(
              Number(r.m1.slice(0, 4)),
              Number(r.m1.slice(4, 6)) - 1,
              Number(r.m1.slice(6, 8)),
            ),
          )
        : null,
      h1: r?.h1
        ? new Date(Date.UTC(Number(r.h1.slice(0, 4)), Number(r.h1.slice(4, 6)) - 1, 1))
        : null,
    };
  }

  /**
   * Ownership is re-derived **here**, not left to callers: `probe_stats` has no
   * `user_id`, so the query joins `endpoints` on the denormalized `user_id`, and
   * another user's endpoint is indistinguishable from one that does not exist
   * (`404`, never `403`, which would confirm the id).
   *
   * The availability lookup and the read are not one snapshot, so retention may
   * detach the oldest partition between them. `retainedFrom` is therefore read
   * again **after** the aggregate query, and a plan that has lost a bucket in the
   * meantime is discarded rather than returned as an answer.
   */
  async windowStats(
    userId: string,
    endpointId: string,
    from: Date,
    to: Date,
  ): Promise<WindowStats> {
    const plan = planWindow(from, to, await this.retainedFrom());
    const rows = await this.read(userId, endpointId, plan);
    if (rows.length === 0) throw new NotFoundError('Endpoint');

    this.assertStillRetained(plan, await this.retainedFrom());
    return summarise(rows, plan);
  }

  private async read(userId: string, endpointId: string, plan: WindowPlan): Promise<StatRow[]> {
    const iso = (ds: Date[]) => ds.map((d) => d.toISOString());
    const cols = sql`
      granularity, count_up, count_down, count_degraded, count_unknown, covered_seconds,
      up_seconds, degraded_seconds, sum_total_ms, min_total_ms, max_total_ms, sum_ttfb_ms, hist_total`;
    const grain = (g: 'd1' | 'h1' | 'm1') => sql`
      SELECT ${cols} FROM probe_stats
       WHERE endpoint_id = e.id AND granularity = ${sql.lit(g)}
         AND bucket_start = ANY(${iso(plan[g])}::timestamptz[])`;
    const result = await sql<StatRow>`
      SELECT e.id AS owned_id, s.*
        FROM endpoints e
        LEFT JOIN LATERAL (${grain('d1')} UNION ALL ${grain('h1')} UNION ALL ${grain('m1')}) s ON true
       WHERE e.id = ${endpointId} AND e.user_id = ${userId}
    `.execute(this.db.kysely);
    return result.rows;
  }

  private assertStillRetained(plan: WindowPlan, now: RetainedFrom): void {
    for (const grain of ['h1', 'm1'] as const) {
      const needed = oldestNeeded(plan, grain);
      const oldest = now[grain];
      if (needed !== null && (oldest === null || needed < oldest)) {
        throw new WindowError(
          'WINDOW_CHANGED_DURING_READ',
          `${grain} buckets were retired while the window was being read`,
        );
      }
    }
  }
}

function summarise(rows: StatRow[], plan: WindowPlan): WindowStats {
  const data = rows.filter((r) => r.granularity !== null);
  let hist = emptyHistogram();
  let min: number | null = null;
  let max: number | null = null;
  const sum = (pick: (r: StatRow) => number | null) =>
    data.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  let totalMs = 0;
  let ttfbMs = 0;
  for (const r of data) {
    if (r.hist_total?.length === HISTOGRAM_BUCKETS) hist = mergeHistograms(hist, r.hist_total);
    if (r.min_total_ms !== null)
      min = min === null ? r.min_total_ms : Math.min(min, r.min_total_ms);
    if (r.max_total_ms !== null)
      max = max === null ? r.max_total_ms : Math.max(max, r.max_total_ms);
    totalMs += Number(r.sum_total_ms ?? 0);
    ttfbMs += Number(r.sum_ttfb_ms ?? 0);
  }
  const count = histogramCount(hist);
  const ends = { min, max };
  return {
    counts: {
      up: sum((r) => r.count_up),
      down: sum((r) => r.count_down),
      degraded: sum((r) => r.count_degraded),
      unknown: sum((r) => r.count_unknown),
    },
    coveredSeconds: sum((r) => r.covered_seconds),
    upSeconds: sum((r) => r.up_seconds),
    degradedSeconds: sum((r) => r.degraded_seconds),
    latency: {
      count,
      avgTotalMs: count > 0 ? totalMs / count : null,
      avgTtfbMs: count > 0 ? ttfbMs / count : null,
      minMs: min,
      maxMs: max,
      p50: percentile(hist, 0.5, ends),
      p95: percentile(hist, 0.95, ends),
      p99: percentile(hist, 0.99, ends),
    },
    histogram: hist,
    rowsRead: data.length,
    tiles: { d1: plan.d1.length, h1: plan.h1.length, m1: plan.m1.length },
  };
}
