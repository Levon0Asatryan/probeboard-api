import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database } from '../../../core/db/types.js';

/** One slot this worker now owns. Returned by `claim` (docs/m4-plan.md §3.1). */
export interface ClaimedSlot {
  endpoint_id: string;
  /** The slot claimed. The identity NFR-3 is written in terms of. */
  scheduled_at: Date;
  /** The slot after it, already written. */
  next_run_at: Date;
}

/**
 * Every scheduling statement, and nothing else.
 *
 * **The database clock is the only authority** (docs/m4-plan.md D3). Every
 * value written to `next_run_at`, `leased_until`, `scheduled_at` or
 * `last_probe_at` is computed by `now()` inside the statement; no JS `Date` is
 * ever bound for one. With N workers on N hosts, a worker whose clock ran fast
 * would otherwise grant itself a lease its peers still read as live.
 *
 * The rule is about origin, not type: `$slot` *is* bound as a `timestamptz` in
 * the release and abandon fences, because it is the `scheduled_at` this
 * worker's own claim returned — it carries the database's clock, and binding
 * it back is how the fence says "the slot I was given".
 *
 * Each statement is exposed as a builder so `*.repository.test.ts` can
 * `.compile()` it and assert on the SQL without a database, and executed by
 * the thin method beside it.
 */
@Injectable()
export class EndpointRuntimeRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Creates the runtime row for any endpoint that has none.
   *
   * The scheduler owns this table, so nothing in the API writes it: M2's code
   * is untouched, the migration needs no backfill step, and an endpoint
   * created while every worker was down is adopted when one returns (D1, D16).
   *
   * The first slot is jittered. Monitors created together would otherwise
   * share a phase for ever and arrive in one tick; written to the database
   * once, the spread survives restarts, unlike Gatus's boot-order stagger.
   * `least(interval_s, $jitter)` bounds how long a new endpoint waits for its
   * first probe regardless of how long its interval is.
   *
   * `ON CONFLICT DO NOTHING` on top of the anti-join because two workers adopt
   * concurrently by design.
   */
  adoptQuery(jitterMaxS: number): RawBuilder<unknown> {
    return sql`
      INSERT INTO endpoint_runtime (endpoint_id, next_run_at, scheduled_interval_s)
      SELECT e.id,
             now() + make_interval(secs => random() * least(e.interval_s, ${jitterMaxS}::int)),
             e.interval_s
      FROM   endpoints e
      WHERE  NOT EXISTS (SELECT 1 FROM endpoint_runtime r WHERE r.endpoint_id = e.id)
      ON CONFLICT (endpoint_id) DO NOTHING
    `;
  }

  async adopt(jitterMaxS: number, executor: Kysely<Database> = this.db.kysely): Promise<number> {
    const result = await this.adoptQuery(jitterMaxS).execute(executor);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Re-derives `next_run_at` for a row whose endpoint's interval has changed.
   *
   * Joining `interval_s` at claim time keeps a future claim correct but does
   * nothing for a row whose slot was already computed from the old value:
   * 3600s to 30s leaves the monitor idle for nearly an hour, and the other
   * direction fires early. FR-17 says "at its configured interval".
   *
   * The predicate is **provenance**, not arithmetic (D26). After a catch-up,
   * `scheduled_at` is the old overdue slot while `next_run_at` has jumped
   * `misses + 1` intervals, so the two legitimately disagree — keying on
   * `next_run_at <> scheduled_at + interval` would reconcile such a row,
   * rewind it into the past, and replay its whole backlog one probe per tick.
   *
   * `scheduled_at IS NOT NULL` is load-bearing twice over: before the first
   * claim the expression would be NULL and violate `next_run_at NOT NULL`, and
   * a never-claimed row's first slot is the adoption jitter, which is
   * deliberately soon and already independent of the interval.
   */
  reconcileQuery(): RawBuilder<unknown> {
    return sql`
      UPDATE endpoint_runtime r
      SET    next_run_at          = r.scheduled_at + make_interval(secs => e.interval_s),
             scheduled_interval_s = e.interval_s
      FROM   endpoints e
      WHERE  e.id = r.endpoint_id
        AND  r.scheduled_at IS NOT NULL
        AND  (r.leased_until IS NULL OR r.leased_until < now())
        AND  r.scheduled_interval_s IS DISTINCT FROM e.interval_s
    `;
  }

  async reconcile(executor: Kysely<Database> = this.db.kysely): Promise<number> {
    const result = await this.reconcileQuery().execute(executor);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Claims up to `batchSize` due endpoints and leases them to `workerId`.
   *
   * One statement, in autocommit, because a single `now()` must govern the
   * due check, the lease-expiry check, the lease grant and the catch-up
   * arithmetic. `now()` is transaction-start time, so a multi-statement claim
   * with think-time would compare against an instant already stale — and the
   * catch-up expression's `misses >= 0` is a proof only because the predicate
   * and the arithmetic read the same value.
   *
   * | clause                          | requirement                          |
   * | ------------------------------- | ------------------------------------ |
   * | `FOR UPDATE OF r SKIP LOCKED`   | NFR-3/NFR-1/NFR-7, disjoint and not blocking |
   * | `e.enabled`                     | FR-9, joined rather than mirrored    |
   * | `r.next_run_at <= now()`        | FR-17, the only definition of "due"  |
   * | `leased_until IS NULL OR < now()` | NFR-3/NFR-4                        |
   * | `ORDER BY r.next_run_at`        | NFR-2, oldest first, served by the index |
   * | `scheduled_at = r.next_run_at`  | NFR-3, names the slot                |
   * | `next_run_at + interval*(misses+1)` | NFR-2, derived from the slot     |
   *
   * The catch-up guard is not a branch: `floor((now - slot)/interval) + 1` is
   * the general form, and the on-time case is its degenerate one, so there is
   * no second code path to get wrong. `floor(...) + 1` rather than `ceil`,
   * because at an exact multiple `ceil` yields `now` — not strictly future,
   * and the row would be immediately due again.
   *
   * `FOR UPDATE OF r` names the alias, so `endpoints` is read but never
   * locked: the API writing an endpoint cannot block a claim.
   *
   * The `logged` CTE writes the slot record inside this same statement,
   * before any probe runs (D25). It is the only durable, slot-keyed record of
   * an attempt M4 has.
   */
  claimQuery(workerId: string, leaseMs: number, batchSize: number): RawBuilder<ClaimedSlot> {
    return sql<ClaimedSlot>`
      WITH due AS (
        SELECT r.endpoint_id
        FROM   endpoint_runtime r
        JOIN   endpoints e ON e.id = r.endpoint_id
        WHERE  e.enabled
          AND  r.next_run_at <= now()
          AND  (r.leased_until IS NULL OR r.leased_until < now())
        ORDER  BY r.next_run_at
        FOR UPDATE OF r SKIP LOCKED
        LIMIT  ${batchSize}
      ),
      claimed AS (
        UPDATE endpoint_runtime r
        SET    scheduled_at         = r.next_run_at,
               next_run_at          = r.next_run_at
                                      + make_interval(secs => e.interval_s *
                                          (floor(extract(epoch from (now() - r.next_run_at))
                                                 / e.interval_s) + 1)),
               scheduled_interval_s = e.interval_s,
               leased_until         = now() + make_interval(secs => ${leaseMs}::float8 / 1000),
               leased_by            = ${workerId}
        FROM   due
        JOIN   endpoints e ON e.id = due.endpoint_id
        WHERE  r.endpoint_id = due.endpoint_id
        RETURNING r.endpoint_id, r.scheduled_at, r.next_run_at
      ),
      logged AS (
        INSERT INTO claim_log (endpoint_id, scheduled_at, worker_id)
        SELECT endpoint_id, scheduled_at, ${workerId} FROM claimed
      )
      SELECT endpoint_id, scheduled_at, next_run_at FROM claimed
    `;
  }

  async claim(
    workerId: string,
    leaseMs: number,
    batchSize: number,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<ClaimedSlot[]> {
    const result = await this.claimQuery(workerId, leaseMs, batchSize).execute(executor);
    return result.rows;
  }

  /**
   * Ends a slot that produced an observation, and frees the row.
   *
   * Release is mandatory, not an optimisation: the shortest permitted interval
   * is 30s and the lease defaults to 60s, so without it a 30s monitor's next
   * slot falls inside its own previous lease and the monitor is probed every
   * 60s — a 100% drift produced by the lease that exists to protect NFR-3.
   *
   * `last_probe_at` advances because an observation exists. Any `ProbeOutcome`
   * counts, success or failure class alike: M5 persists it either way.
   *
   * The fence is both conjuncts (D13). `leased_by` alone fails when the same
   * worker re-claims the same endpoint for a later slot and a straggler from
   * the earlier one then releases it — the shape openstatus's per-row commits
   * get wrong, filtering on row id alone.
   */
  releaseQuery(endpointId: string, workerId: string, slot: Date): RawBuilder<unknown> {
    return sql`
      UPDATE endpoint_runtime
      SET    leased_until  = NULL,
             leased_by     = NULL,
             last_probe_at = now()
      WHERE  endpoint_id   = ${endpointId}
        AND  leased_by     = ${workerId}
        AND  scheduled_at  = ${slot}
    `;
  }

  async release(
    endpointId: string,
    workerId: string,
    slot: Date,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<number> {
    const result = await this.releaseQuery(endpointId, workerId, slot).execute(executor);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Ends a slot that produced **no** observation, and frees the row.
   *
   * Identical to `release` minus one assignment, and that assignment is the
   * whole point: `last_probe_at` must not move. M6 reads it for the `UNKNOWN`
   * sweep, so advancing it for a slot nothing probed makes the gap look
   * freshly observed and the sweep skips it — a missing probe treated as
   * healthy, which is the first rule in AGENTS.md.
   *
   * Reached when the loader overruns its budget or rejects, and when `probe()`
   * throws (which means a bug in probeboard: M3's contract is that a network
   * condition comes back as a `failureClass`, never as a rejection).
   */
  abandonQuery(endpointId: string, workerId: string, slot: Date): RawBuilder<unknown> {
    return sql`
      UPDATE endpoint_runtime
      SET    leased_until = NULL,
             leased_by    = NULL
      WHERE  endpoint_id  = ${endpointId}
        AND  leased_by    = ${workerId}
        AND  scheduled_at = ${slot}
    `;
  }

  async abandon(
    endpointId: string,
    workerId: string,
    slot: Date,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<number> {
    const result = await this.abandonQuery(endpointId, workerId, slot).execute(executor);
    return Number(result.numAffectedRows ?? 0n);
  }
}
