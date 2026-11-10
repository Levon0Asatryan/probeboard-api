import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type {
  Database,
  EndpointHealth,
  FailureClassLabel,
  FailureDetail,
  ProbeOutcomeLabel,
} from '../../../core/db/types.js';
import {
  initialHealth,
  step,
  type Health,
  type Observation,
  type Thresholds,
  type Transition,
} from '../utils/state-machine.js';

export interface EvaluatorPassOptions {
  /** `EVALUATOR_BATCH_XIDS`: whole inserting transactions per batch. */
  batchXids: number;
  /** `UNKNOWN_GRACE_MS`: slack beyond two intervals before the sweep marks an endpoint. */
  unknownGraceMs: number;
  /** Injectable for tests; a fresh UUID otherwise. */
  newIncidentId?: () => string;
}

export interface IncidentEvent {
  endpointId: string;
  incidentId: string;
}

export interface EvaluatorPass {
  /** Another worker held the watermark row: this pass read nothing. */
  skipped: boolean;
  /** Results applied to the state machine. */
  evaluated: number;
  /** Results older than one already applied for their endpoint: stored, never applied (D3). */
  late: number;
  opened: IncidentEvent[];
  closed: IncidentEvent[];
  /** Enabled endpoints the sweep moved to `unknown` in this pass. */
  markedUnknown: number;
  /** Rows removed because their endpoint no longer exists (plan §3.12). */
  orphansRemoved: number;
  /** How long since the watermark last moved, before this pass. */
  lagMs: number;
}

interface ResultRow {
  endpoint_id: string;
  started_at: Date;
  attempt_id: string;
  outcome: ProbeOutcomeLabel;
  in_maintenance: boolean;
  failure_class: FailureClassLabel | null;
  failure_code: string | null;
  status_code: number | null;
  failure_detail: FailureDetail | null;
  failure_threshold: number;
  success_threshold: number;
  service_id: string;
  user_id: string;
}

/**
 * A fresh result for every pass. Never a shared constant spread into one: a
 * spread copies the arrays by reference, so every pass pushed into the same
 * `opened` and `closed`, and each later pass reported every incident ever
 * opened on that worker again -- found by the M6 real run, where one incident
 * was logged "opened" on five passes.
 */
function emptyPass(skipped: boolean, lagMs = 0): EvaluatorPass {
  return {
    skipped,
    evaluated: 0,
    late: 0,
    opened: [],
    closed: [],
    markedUnknown: 0,
    orphansRemoved: 0,
    lagMs,
  };
}

/**
 * One evaluator pass, in **one transaction** (docs/m6-plan.md §3.3).
 *
 * **A second consumer of `probe_results`, shaped exactly like the rollup.** The
 * watermark is over `insert_xid`, bounded by the snapshot horizon read once per
 * pass, so a result that commits late -- the slow ones, most likely failures --
 * is evaluated when it passes the horizon, never skipped (M5 C3). Single-flight
 * by `FOR UPDATE SKIP LOCKED` on the evaluator's own `rollup_state` row.
 *
 * **Exactly once, and restart-safe.** Health, incidents, outbox rows and the
 * watermark commit together; a crash anywhere rolls all four back and the next
 * pass re-reads the same results from the same state. Nothing lives in worker
 * memory, so a restart mid-incident can neither reopen nor lose one.
 *
 * **Why the state machine runs in TypeScript, and why that is safe.** It is a
 * read-modify-write, which AGENTS.md forbids on *shared* rows. These are not
 * shared: the evaluator is the only writer of `endpoint_health`, `incidents`
 * and `notification_outbox`, the pass is single-flight under the watermark row
 * lock, and the health rows are read `FOR UPDATE` inside the same transaction
 * -- the "lock, re-read, write" form AGENTS.md asks of a script.
 */
@Injectable()
export class EvaluatorRepository {
  constructor(private readonly db: DbService) {}

  async runOnce(opts: EvaluatorPassOptions): Promise<EvaluatorPass> {
    const newIncidentId = opts.newIncidentId ?? randomUUID;

    return this.db.kysely.transaction().execute(async (trx) => {
      const state = await sql<{ last_xid: string; lag_ms: number }>`
        SELECT last_xid::text AS last_xid,
               (extract(epoch FROM now() - advanced_at) * 1000)::float8 AS lag_ms
        FROM   rollup_state
        WHERE  name = 'incident_evaluator'
        FOR UPDATE SKIP LOCKED
      `.execute(trx);
      const row = state.rows[0];
      if (!row) return emptyPass(true);

      // Read once and bound thereafter: under READ COMMITTED every statement
      // takes a fresh snapshot, and a re-read could pass a transaction still
      // open at this point (docs/m5-plan.md §3.4 step 2).
      const horizon = (
        await sql<{ h: string }>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h`.execute(
          trx,
        )
      ).rows[0].h;

      const pass = emptyPass(false, row.lag_ms);
      let last = row.last_xid;
      for (;;) {
        // The (n+1)-th distinct xid at or above `last` and below the horizon:
        // each batch is exactly n whole transactions (the rollup's rule).
        const nth = await sql<{ upper: string }>`
          SELECT insert_xid::text AS upper
          FROM  (SELECT DISTINCT insert_xid
                 FROM   probe_results
                 WHERE  insert_xid >= ${last}::xid8 AND insert_xid < ${horizon}::xid8
                 ORDER  BY insert_xid
                 OFFSET ${opts.batchXids} LIMIT 1) t
        `.execute(trx);
        const upper = nth.rows[0]?.upper ?? horizon;
        await this.evaluate(trx, await this.batch(trx, last, upper), pass, newIncidentId);
        last = upper;
        if (nth.rows.length === 0) break;
      }

      pass.markedUnknown = await this.sweepUnknown(trx, opts.unknownGraceMs);
      pass.orphansRemoved = await this.removeOrphans(trx);

      await sql`
        UPDATE rollup_state
        SET    last_xid    = ${last}::xid8,
               -- Only when it moved, so a stalled horizon stays visible as lag.
               advanced_at = CASE WHEN last_xid IS DISTINCT FROM ${last}::xid8
                                  THEN now() ELSE advanced_at END
        WHERE  name = 'incident_evaluator'
      `.execute(trx);
      return pass;
    });
  }

  /**
   * The results in `[lower, upper)`, joined to their endpoint for the
   * thresholds in force now (D17) and the owner an incident is filed under.
   * A deleted endpoint's results drop out of the join: there is nothing left
   * to hold an incident for. Ordered so each endpoint's results arrive in
   * `(started_at, attempt_id)` order -- the order the state machine's fence
   * uses (D3).
   */
  private async batch(
    trx: Transaction<Database>,
    lower: string,
    upper: string,
  ): Promise<ResultRow[]> {
    const { rows } = await sql<ResultRow>`
      SELECT r.endpoint_id, r.started_at, r.attempt_id::text AS attempt_id, r.outcome,
             r.in_maintenance, r.failure_class, r.failure_code, r.status_code, r.failure_detail,
             e.failure_threshold, e.success_threshold, e.service_id, e.user_id
      FROM   probe_results r
      JOIN   endpoints e ON e.id = r.endpoint_id
      WHERE  r.insert_xid >= ${lower}::xid8 AND r.insert_xid < ${upper}::xid8
      ORDER  BY r.endpoint_id, r.started_at, r.attempt_id
    `.execute(trx);
    return rows;
  }

  private async evaluate(
    trx: Transaction<Database>,
    rows: ResultRow[],
    pass: EvaluatorPass,
    newIncidentId: () => string,
  ): Promise<void> {
    if (rows.length === 0) return;

    const byEndpoint = new Map<string, ResultRow[]>();
    for (const r of rows) {
      const list = byEndpoint.get(r.endpoint_id);
      if (list) list.push(r);
      else byEndpoint.set(r.endpoint_id, [r]);
    }

    // Locked in one order, though the pass is single-flight: the lock is what
    // makes the read below the value this transaction will overwrite.
    const ids = [...byEndpoint.keys()].sort();
    const stored = await trx
      .selectFrom('endpoint_health')
      .selectAll()
      .where('endpoint_id', 'in', ids)
      .orderBy('endpoint_id')
      .forUpdate()
      .execute();
    const current = new Map(stored.map((h) => [h.endpoint_id, fromRow(h)]));

    for (const endpointId of ids) {
      const results = byEndpoint.get(endpointId)!;
      const { service_id: serviceId, user_id: userId } = results[0];
      let health = current.get(endpointId) ?? initialHealth(results[0].started_at);
      let changed = false;

      for (const r of results) {
        const thresholds: Thresholds = {
          failuresToOpen: r.failure_threshold,
          successesToClose: r.success_threshold,
        };
        const s = step(health, toObservation(r), thresholds, newIncidentId);
        if (!s.applied) {
          pass.late += 1;
          continue;
        }
        pass.evaluated += 1;
        changed = true;
        health = s.health;
        for (const t of s.transitions) {
          await this.record(trx, endpointId, serviceId, userId, t);
          (t.kind === 'open' ? pass.opened : pass.closed).push({
            endpointId,
            incidentId: t.incidentId,
          });
        }
      }

      if (changed) await this.saveHealth(trx, endpointId, health);
    }
  }

  /**
   * One transition: the incident row and its outbox row, in this transaction
   * (ADR-0008). Plain inserts: the one-open index and the outbox's once-per-kind
   * key turn a state-machine bug into a failed pass, never a skipped write.
   */
  private async record(
    trx: Transaction<Database>,
    endpointId: string,
    serviceId: string,
    userId: string,
    t: Transition,
  ): Promise<void> {
    if (t.kind === 'open') {
      await trx
        .insertInto('incidents')
        .values({
          id: t.incidentId,
          endpoint_id: endpointId,
          service_id: serviceId,
          user_id: userId,
          opened_at: t.openedAt,
          confirmed_at: t.confirmedAt,
          failures_to_open: t.failuresToOpen,
          cause_class: t.cause.failureClass,
          cause_code: t.cause.failureCode,
          cause_status_code: t.cause.statusCode,
          cause_detail:
            t.cause.failureDetail === null ? null : JSON.stringify(t.cause.failureDetail),
        })
        .execute();
    } else {
      // A close that matches no open row is not a no-op to shrug at: the
      // state said an incident was open and the table disagrees (probeboard
      // rule #21 -- an equality fence fails open unless its row count is read).
      const closed = await trx
        .updateTable('incidents')
        .set({ closed_at: t.closedAt, close_confirmed_at: t.closeConfirmedAt })
        .where('id', '=', t.incidentId)
        .where('closed_at', 'is', null)
        .executeTakeFirst();
      if (Number(closed.numUpdatedRows) !== 1) {
        throw new Error(`incident ${t.incidentId} is not open; the evaluator state disagrees`);
      }
    }
    await trx
      .insertInto('notification_outbox')
      .values({
        incident_id: t.incidentId,
        kind: t.kind === 'open' ? 'incident_open' : 'incident_close',
        user_id: userId,
        service_id: serviceId,
      })
      .execute();
  }

  private async saveHealth(
    trx: Transaction<Database>,
    endpointId: string,
    h: Health,
  ): Promise<void> {
    const values = {
      state: h.state,
      state_since: h.stateSince,
      consecutive_failures: h.consecutiveFailures,
      consecutive_successes: h.consecutiveSuccesses,
      run_started_at: h.run?.startedAt ?? null,
      run_failure_class: h.run?.failureClass ?? null,
      run_failure_code: h.run?.failureCode ?? null,
      run_status_code: h.run?.statusCode ?? null,
      run_failure_detail: h.run?.failureDetail ? JSON.stringify(h.run.failureDetail) : null,
      recovery_started_at: h.recoveryStartedAt,
      open_incident_id: h.openIncidentId,
      last_success_at: h.lastSuccessAt,
      applied_started_at: h.applied?.startedAt ?? null,
      applied_attempt_id: h.applied?.attemptId ?? null,
    };
    await trx
      .insertInto('endpoint_health')
      .values({ endpoint_id: endpointId, ...values })
      .onConflict((oc) =>
        oc.column('endpoint_id').doUpdateSet({ ...values, updated_at: sql<Date>`now()` }),
      )
      .execute();
  }

  /**
   * The `UNKNOWN` sweep (plan §3.6): an enabled endpoint with no stored result
   * for `2 x interval + grace` reads `unknown`. It reads `last_probe_at`, which
   * only a stored observation moves -- so an abandoned slot, an exhausted write,
   * a dead worker and a stopped scheduler all surface here, and the
   * evaluator's own lag does not. Anchored on `updated_at` too (C6), so a
   * created, resumed or edited endpoint gets its full window before it can be
   * flagged. Paused endpoints are not unknown (C7). Counters, runs and an open
   * incident are left alone: silence is no evidence of recovery.
   */
  private async sweepUnknown(trx: Transaction<Database>, graceMs: number): Promise<number> {
    const result = await sql`
      INSERT INTO endpoint_health AS h (endpoint_id, state, state_since)
      SELECT e.id, 'unknown', now()
      FROM   endpoints e
      JOIN   endpoint_runtime r ON r.endpoint_id = e.id
      WHERE  e.enabled
        AND  greatest(r.last_probe_at, e.updated_at)
               < now() - make_interval(secs => 2 * e.interval_s)
                       - make_interval(secs => ${graceMs}::float8 / 1000)
      ON CONFLICT (endpoint_id) DO UPDATE
         SET state = 'unknown', state_since = now(), updated_at = now()
       WHERE h.state <> 'unknown'
    `.execute(trx);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * A deleted endpoint's state and incidents (and, by cascade, their outbox
   * rows). No foreign key does this, deliberately (plan §2.4.1, D13); the
   * evaluator removes what only it writes, under the lock that serializes its
   * own writes. The owner already cannot see them: every read joins endpoints.
   */
  private async removeOrphans(trx: Transaction<Database>): Promise<number> {
    const health = await sql`
      DELETE FROM endpoint_health h
       WHERE NOT EXISTS (SELECT 1 FROM endpoints e WHERE e.id = h.endpoint_id)
    `.execute(trx);
    const incidents = await sql`
      DELETE FROM incidents i
       WHERE NOT EXISTS (SELECT 1 FROM endpoints e WHERE e.id = i.endpoint_id)
    `.execute(trx);
    return Number(health.numAffectedRows ?? 0n) + Number(incidents.numAffectedRows ?? 0n);
  }
}

function toObservation(r: ResultRow): Observation {
  return {
    startedAt: r.started_at,
    attemptId: r.attempt_id,
    outcome: r.outcome,
    inMaintenance: r.in_maintenance,
    failureClass: r.failure_class,
    failureCode: r.failure_code,
    statusCode: r.status_code,
    failureDetail: r.failure_detail,
  };
}

function fromRow(h: EndpointHealth): Health {
  return {
    state: h.state,
    stateSince: h.state_since,
    consecutiveFailures: h.consecutive_failures,
    consecutiveSuccesses: h.consecutive_successes,
    run:
      h.run_started_at === null
        ? null
        : {
            startedAt: h.run_started_at,
            // The schema holds run_started_at and consecutive_failures > 0
            // together; the class is written with them.
            failureClass: h.run_failure_class ?? 'unknown_error',
            failureCode: h.run_failure_code,
            statusCode: h.run_status_code,
            failureDetail: h.run_failure_detail,
          },
    recoveryStartedAt: h.recovery_started_at,
    openIncidentId: h.open_incident_id,
    lastSuccessAt: h.last_success_at,
    applied:
      h.applied_started_at === null || h.applied_attempt_id === null
        ? null
        : { startedAt: h.applied_started_at, attemptId: h.applied_attempt_id },
  };
}
