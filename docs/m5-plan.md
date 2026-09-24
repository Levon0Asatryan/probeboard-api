# M5 — Storage: implementation plan

Persists what the scheduler measures, folds it into aggregates, and bounds its
growth. M4 probes and persists nothing; M6 owns incidents and the state
machine, M8 the statistics HTTP surface.

Requirements: **NFR-8** (storage growth bounded; raw rows kept for a window,
older data only as aggregates), **NFR-9** (long windows served from aggregates;
a 30-day chart must not read 43,200 rows per monitor), **FR-34** (p95),
**FR-20** (failures stay distinguishable), **NFR-3/NFR-4** (a result is
attributable to exactly one claimed slot). ADR-0003 (histogram percentiles),
ADR-0007 (partitions and `DROP`).

Milestone exit test (`08-plan.md` row M5, `02-requirements.md` §2.3 item 5):
_a 30-day p95 is served from aggregates after the raw rows have been dropped._

---

## 1. Scope

**In**

- `probe_results`, range-partitioned on `started_at`, daily; partitions created
  ahead of need by a maintenance job, never on the write path.
- The writer: the scheduler's terminal step persists the result **and** clears
  the lease in one transaction.
- `probe_stats` m1 / h1 / d1, folded by additive `ON CONFLICT DO UPDATE` on a
  10 s rollup tick, exactly once.
- Retention by partition removal, with a guard that refuses to drop data no
  aggregate has seen.
- Percentile from the histogram, plus a window planner that picks the coarsest
  grain tiling a window.
- `claim_log` retention (M4 follow-up) — same mechanism, same job.

**Out**

- **No HTTP surface.** The statistics endpoints are M8, so M5 adds no route, no
  `http/` file and no OpenAPI change. The read path is a `core` function and
  repository, exercised by the acceptance test.
- Incident state, `consecutive_*`, `state`, `count_maintenance`, the `UNKNOWN`
  gap sweep (M6/M7). M5 never writes `count_maintenance` and never writes
  `degraded` (D5).
- Per-assertion result storage and `error_message` (D8).
- Operator tooling, partition-repair CLIs, backfill of data that predates M5:
  there is no deployment and no such data (`CLAUDE.md`, "Build for this
  thesis"). §3.9 states the query that says so.

---

## 2. Investigation

### 2.1 Requirements and architecture read together — contradictions found

| #   | Where                                                                                      | Finding                                                                                                                                                                                                                                              | Resolution                                                                                   |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| C1  | Handoff / tracker: "partition on `started_at`" **and** "key `(endpoint_id, scheduled_at)`" | A unique key on a partitioned table must contain every partition column. Measured (§2.4.1): `PRIMARY KEY (endpoint_id, scheduled_at) … PARTITION BY RANGE (started_at)` is rejected. Both cannot hold.                                               | D1: partition on `started_at`, key stays 07's `(endpoint_id, started_at)`, slot is a column. |
| C2  | 07 §7.5 upsert snippet                                                                     | The first-insert `VALUES` carries `array_fill(0, …)` and only the `DO UPDATE` branch does `hist_total[$5] + 1`. The **first** probe of every bucket therefore never reaches the histogram. Measured (§2.4.2): after two upserts `h[3]` was 1, not 2. | D10: the fold inserts the computed histogram, not zeros.                                     |
| C3  | 07 "Idempotency": "watermark per endpoint"                                                 | Any watermark ordered by time skips a row committed late (§2.4.3, demonstrated). Per-endpoint does not fix it: a zombie worker (lease lapsed, probe returns late) writes slot _T1_ after the next worker committed _T2_.                             | D9: watermark on the inserting transaction's `xid8`, bounded by the snapshot horizon.        |
| C4  | 07 / ADR-0007: "`DROP PARTITION` — O(1), no vacuum"                                        | True of the drop; false of its locking. `DROP` and plain `DETACH` take `ACCESS EXCLUSIVE` on the **parent**: an insert into an unrelated partition waited 2.04 s behind them (§2.4.4). `DETACH … CONCURRENTLY` did not (0.07 s).                     | D14: detach concurrently, then drop. ADR-0007 needs the caveat (report).                     |
| C5  | 07 `probe_stats.covered_seconds`; 03 §3.5.1 "both derivable"                               | One `covered_seconds` plus `count_*` cannot give time-weighted _uptime_: it does not say how many covered seconds were up. Not derivable once the interval changes inside a bucket — the exact case §3.5.1 exists for.                               | D8: add `up_seconds`, `degraded_seconds`.                                                    |
| C6  | 07 `probe_stats` is one table with `m1`; NFR-8                                             | At a 60 s interval an m1 row per bucket is **one row per probe** — the same row count as raw. Unbounded m1 defeats NFR-8 the same way raw does.                                                                                                      | D11: m1 and h1 are partitioned and retention-bound too.                                      |
| C7  | 07 `probe_results.assertions`, `error_message`                                             | `ProbeOutcome` (`probe.ts:73`) carries neither. Persisting them needs M3 changes and a decision about response text in a row (NFR-13 says bodies are used only for assertions).                                                                      | D8: columns not created; deferred.                                                           |
| C8  | Handoff: "on the rollup tick in 07's table (10 s)"                                         | Consistent with C3's fix; the tick stays. A write-path fold would avoid C3 with no watermark, but it is not what the handoff scopes, and the aggregate cost would ride every probe. Rejected as D9's alternative.                                    | D9.                                                                                          |

### 2.2 Code on `main` this touches

- `scheduler.service.ts:159-209` — `runOne`: load → `probe()` → log `outcome` →
  `guardedRelease`. The outcome is logged at `:196-206` and then discarded. This is the one edit
  to existing behaviour.
- `endpoint-runtime.repository.ts:263-281` — `release(…, executor,
statementTimeoutMs)`. `releaseQuery` is a builder, so the writer can run it
  on **its own transaction**. `release` cannot be reused inside one: with a
  timeout it opens `executor.transaction()`, and Kysely's `Transaction`
  throws `calling the transaction method for a Transaction is not supported`
  (`node_modules/kysely/dist/kysely.js:556-557`). The writer calls
  `releaseQuery(...).execute(trx)` directly.
- Claim (`m4-plan.md` §3.1) writes `scheduled_interval_s` but does not return
  it. The writer needs it (D7), so `RETURNING` gains one column.
- `ProbeOutcome` (`probe.ts:73-98`): `startedAt` (wall-clock ms), `success`,
  `status?`, `failureClass?`, `code?`, `timings` (`totalMs` always; `dnsMs`,
  `connectMs`, `tlsMs`, `ttfbMs`, `transferMs` **optional** — an absent phase is
  `NULL`, never `0`, `timing.ts:55-63`), `certExpiresAt?`, `truncated`,
  `redirects`.
- `FailureClass` (`failure-classes.ts:17`): 16 values; `BLOCKED_BY_POLICY` and
  `UNKNOWN_ERROR` are the two that M6 excludes from uptime.
- `claim_log` (`0007_endpoint_runtime.up.sql`): `bigserial` key, no FK
  (deadlock, `m4-plan.md` D25 deviation). Consumers: the claim CTE,
  `scheduler.int.test.ts`, the repository int test.
- Migrations are numbered `0001`–`0007`; the next is `0008`, with a
  `.down.sql`, and `src/core/db/types.ts` changes in the same commit.
- pg returns `int8` as a string (`AGENTS.md`), and `xid8` too: `pg-types`
  registers no parser for its OID (5069), so it arrives as text.
  `sum_total_ms`, `sum_ttfb_ms` and `insert_xid` are typed `string` in
  `types.ts`.

### 2.3 Prior art

| System                                       | What it does                                                                                                                                                            | What M5 takes                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Uptime Kuma (`uptime-calculator.js:340-370`) | Two `DELETE`s (`stat_minutely`, `stat_hourly`) run **inside the per-beat update**, under a `// TODO: Improvement: Convert it to a job?`. Confirmed by reading the file. | The thing D14 replaces. The measurement compares it with detach+drop on the same rows.                   |
| Uptime Kuma stats                            | Stores up/down/mean/min/max per bucket. No histogram, so no long-window p95 (ADR-0003).                                                                                 | The histogram is the difference; the accuracy measurement (§9) is ADR-0003's promised evaluation result. |
| Gatus (`storage/config.go:8-9`)              | Keeps the last 100 results and 50 events per endpoint: bounded by count, no time-windowed statistics.                                                                   | Contrast only: bounded growth by discarding the window NFR-9 asks for.                                   |
| blackbox_exporter                            | Exposes duration as Prometheus histograms (`le` = cumulative upper bounds, inclusive).                                                                                  | D16's bucket convention: a value equal to an edge belongs to the **lower** bucket.                       |
| PostgreSQL partitioning                      | Missing partition → hard error; `DEFAULT` partition silently reintroduces the unbounded table (ADR-0007).                                                               | D13: no default partition; the error is the alarm.                                                       |
| Transactional outbox consumers               | The standard hole: consuming an append-only table by an ordered key while transactions commit out of order loses rows. The standard fix is a snapshot horizon.          | D9.                                                                                                      |

### 2.4 Mechanics verified directly, not recalled

All on `postgres:17-alpine` = **PostgreSQL 17.11**, `psql` against a scratch
database. No Node behaviour is claimed by this plan (the Node here is 24; the
repo pins 22, and nothing below depends on the driver).

1. **Unique key vs partition key.** `PRIMARY KEY (endpoint_id, scheduled_at)`
   on `PARTITION BY RANGE (started_at)` → `ERROR: unique constraint on
partitioned table must include all partitioning columns`. Partitioned by
   `scheduled_at`, the same key is accepted. An insert with no matching
   partition → `ERROR: no partition of relation … found for row`.
2. **Array-subscript upsert.** `INSERT … ON CONFLICT DO UPDATE SET h[3] =
s.h[3] + 1`, run twice from an all-zero default: `h[3] = 1`. The insert
   branch does not increment. `array(select a+b from unnest(s.hist,
excluded.hist) as t(a,b))` in the `SET` list works for element-wise merge,
   and `ON CONFLICT` routes through a `LIST` → `RANGE` sub-partitioned parent.
   `width_bucket(x-1, '{10,25,50}')` gives 0,1,2,3 for x = 10, 11, 50, 51:
   the `le` convention with a `+1` for the 1-based array index.
3. **The late-commit hole.** Transaction A inserts `t=10:00:00` and stays open;
   B inserts `t=10:00:05` and commits. A rollup reading now would advance a
   time watermark to 10:00:05; A commits afterwards with a row below it — never
   seen. Same run with `insert_xid xid8 DEFAULT pg_current_xact_id()` and the
   horizon `pg_snapshot_xmin(pg_current_snapshot())`: with A open, **0** rows
   are below the horizon (B's row is held back); after A commits, both are.
4. **Locks.** Hold a transaction 3 s; insert into an _unrelated_ partition:
   `DROP TABLE <partition>` 2.04 s; plain `DETACH PARTITION` 2.03 s;
   `CREATE TABLE … PARTITION OF` 2.04 s. `CREATE TABLE (LIKE …)` + `ATTACH
PARTITION` 0.065 s; `DETACH … CONCURRENTLY` (queued behind a long reader
   of its partition) 0.069 s. Dropping a 2,000,000-row partition took 13.7 ms.
5. **Races and interruption.** Two sessions running `CREATE TABLE IF NOT
EXISTS` for one partition: one fails `relation already exists` — `IF NOT
EXISTS` is not a lock. `DETACH … CONCURRENTLY` interrupted by `lock_timeout`
   leaves `pg_inherits.inhdetachpending = true`; inserts into other partitions
   still succeed; `DETACH … FINALIZE` completes it after the reader ends.
6. **Simple-query trap.** `psql -c "a; b"` sends one multi-statement query,
   which is an implicit transaction: `DETACH … CONCURRENTLY` is refused inside
   it (`cannot run inside a transaction block`). node-postgres' simple query
   behaves the same. The detach must be a **single statement on a dedicated
   connection**, with `SET lock_timeout` on that same connection first.
7. **UTC buckets under any session zone.** With `timezone='Asia/Yerevan'`,
   `date_trunc('day', ts, 'UTC')` returned UTC midnight. The three-argument form
   makes bucket edges independent of the session.
8. **The horizon and read-only transactions.** A read-only transaction held
   open for 3 s left `pg_snapshot_xmin(pg_current_snapshot())` equal to the
   next xid: transactions without an assigned xid do not hold it back, so an
   analytics query cannot stall the rollup. `xid8` has no arithmetic
   (`'10'::xid8 - 1` → `operator does not exist`), which shapes §3.4.

---

## 3. Design

### 3.1 Schema — migration `0008_storage`

```sql
-- probe_outcome, failure_class and stat_grain already exist (0001_init.up.sql:18-47)
-- and are reused. failure_class labels there are LOWERCASE ('dns_nxdomain', ...).

CREATE TABLE probe_results (
    endpoint_id     uuid          NOT NULL,
    started_at      timestamptz   NOT NULL,   -- worker wall clock, ms; partition key
    scheduled_at    timestamptz   NOT NULL,   -- the claimed slot, µs; not unique (D2)
    interval_s      integer       NOT NULL,   -- the interval the slot was scheduled under
    outcome         probe_outcome NOT NULL,
    failure_class   failure_class,            -- NULL on success
    failure_code    text,                     -- the raw signal, kept when unrecognised
    status_code     smallint,
    total_ms        integer       NOT NULL,
    dns_ms          integer, connect_ms integer, tls_ms integer,
    ttfb_ms         integer, transfer_ms integer,          -- NULL = phase absent, never 0
    redirects       smallint      NOT NULL,
    truncated       boolean       NOT NULL,
    cert_expires_at timestamptz,
    worker_id       text          NOT NULL,
    insert_xid      xid8          NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (endpoint_id, started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX probe_results_insert_xid_idx ON probe_results (insert_xid);

CREATE TABLE probe_stats (
    endpoint_id       uuid        NOT NULL,
    granularity       stat_grain  NOT NULL,
    bucket_start      timestamptz NOT NULL,
    count_up          integer NOT NULL DEFAULT 0,
    count_down        integer NOT NULL DEFAULT 0,
    count_degraded    integer NOT NULL DEFAULT 0,
    count_unknown     integer NOT NULL DEFAULT 0,
    count_maintenance integer NOT NULL DEFAULT 0,        -- M6/M7; M5 never writes it
    covered_seconds   integer NOT NULL DEFAULT 0,        -- up + down + degraded seconds
    up_seconds        integer NOT NULL DEFAULT 0,        -- D8
    degraded_seconds  integer NOT NULL DEFAULT 0,        -- D8
    sum_total_ms      bigint  NOT NULL DEFAULT 0,        -- latency population only (D6)
    min_total_ms      integer,
    max_total_ms      integer,
    sum_ttfb_ms       bigint  NOT NULL DEFAULT 0,
    hist_total        integer[] NOT NULL DEFAULT array_fill(0, ARRAY[20]),
    PRIMARY KEY (endpoint_id, granularity, bucket_start),
    CHECK (array_length(hist_total, 1) = 20)
) PARTITION BY LIST (granularity);
-- probe_stats_m1: FOR VALUES IN ('m1') PARTITION BY RANGE (bucket_start)  -- daily
-- probe_stats_h1: FOR VALUES IN ('h1') PARTITION BY RANGE (bucket_start)  -- monthly
-- probe_stats_d1: FOR VALUES IN ('d1')                                    -- one table, D11

CREATE TABLE rollup_state (
    name     text PRIMARY KEY,
    last_xid xid8 NOT NULL,          -- every row with insert_xid < this is folded
    advanced_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rollup_state VALUES ('probe_results', '0', now());
```

`claim_log` is recreated partitioned (§3.9). **No foreign keys** on
`probe_results`, `probe_stats`, `rollup_state` or `claim_log` (D12).
`down.sql` restores the 0007 `claim_log` shape and drops the rest.

Histogram edges, fixed and documented (ms, ADR-0003), a `core/stats` constant,
**not configuration** — changing them invalidates history:
`10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000,
7500, 10000, 15000, 30000, ∞`. Bucket _i_ holds `edge[i-1] < v ≤ edge[i]`;
19 finite edges, 20 buckets. SQL never restates the list: the edges are bound
as a parameter, and the index is `width_bucket(total_ms - 1, $edges) + 1`.

### 3.2 Keys

`PRIMARY KEY (endpoint_id, started_at)` is 07's natural key. The retry writes
the **same** `started_at` (a fixed millisecond value in the outcome), so
`ON CONFLICT (endpoint_id, started_at) DO NOTHING` makes a retried write
idempotent. `scheduled_at` is stored as the database's own value (bound as
text and cast back with `::timestamptz`, exactly like the release fence,
`repository.ts:12-31`) and is **deliberately not unique**: two probes of one
slot are an NFR-3 violation, which must be _recorded_ as two rows, not rejected
— the argument `claim_log` already makes (0007). No index on it: the
verification's "each claim has at most one result" query is a one-off join.

### 3.3 The writer

`SchedulerService.runOne`, after `probe()` returns, replaces `guardedRelease`
with `persistAndRelease`:

```
BEGIN
  SET LOCAL statement_timeout = terminalWriteTimeoutMs()       -- existing bound
  INSERT INTO probe_results (…) VALUES (…)
         ON CONFLICT (endpoint_id, started_at) DO NOTHING
  UPDATE endpoint_runtime SET leased_until = NULL, leased_by = NULL,
         last_probe_at = now()
   WHERE endpoint_id = $e AND leased_by = $w AND scheduled_at = $slot::timestamptz
COMMIT
```

- **The result is the observation; the release is bookkeeping.** A fence that
  matches zero rows (lease already lost) still commits the insert — the probe
  happened. The existing `release matched no row` warning stays.
- **One transaction** means a result exists exactly when `last_probe_at` moved.
  Separate writes could leave a lease cleared with no result — a slot the
  `UNKNOWN` sweep believes was observed.
- **Failure**: retried up to `RESULT_WRITE_ATTEMPTS` (idempotent by the key),
  each bounded by the remaining shutdown deadline. Exhausted → `error` log
  (`endpointId`, `scheduledAt`, cause), lease left standing, reclaimed at
  expiry per M4 §3.11. That slot is then a gap, which M6 surfaces as
  `UNKNOWN`: an unrecorded slot is never read as healthy. A missing partition
  lands here and is loud, not silent (D13).
- `abandon` (no observation) is unchanged and writes **no** row.
- The mapping is a pure function in `worker/storage/utils/`:

| `ProbeOutcome`                     | `outcome` | why                                                                                     |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `success`                          | `up`      |                                                                                         |
| `failureClass = BLOCKED_BY_POLICY` | `unknown` | probeboard refused; not the endpoint's outage (03 §3.4)                                 |
| `failureClass = UNKNOWN_ERROR`     | `unknown` | unclassified; M6 excludes it from uptime — recording `down` would manufacture an outage |
| any other `failureClass`           | `down`    | the endpoint was reached, or should have been, and failed                               |

The writer maps a `FailureClass` to its label with `toLowerCase()`; the drift test (D21) compares the lowercased TS union with the labels of the existing DB enum. `failure_class` and `failure_code` are persisted on **every** non-success row,
including the two `unknown` ones — the row must not lose what the probe
established (handoff, constraints). `degraded` is never written: it needs a
latency threshold, which is M6's (D5).

### 3.4 The rollup

A worker tick every `ROLLUP_TICK_MS` (10 s, 07's table). One transaction:

1. `SELECT last_xid FROM rollup_state WHERE name='probe_results' FOR UPDATE
SKIP LOCKED`. No row → another worker holds it: return. Single-flight
   without an advisory lock, and a crashed holder releases at transaction end.
2. `horizon := pg_snapshot_xmin(pg_current_snapshot())`, read **once** and
   thereafter bound as a parameter, never re-evaluated: under `READ COMMITTED`
   every statement takes a fresh snapshot, so a re-read mid-loop would see
   later commits and could move past a transaction still open at step 2.
   Every transaction with an `xid8` below it has committed or aborted, so a row
   with `insert_xid < horizon` is final.
3. Loop until `last_xid = horizon`: pick the batch's exclusive upper bound
   `upper` — the **(`ROLLUP_BATCH_ROWS` + 1)-th** distinct `insert_xid` at or
   above `last_xid` **and below `$horizon`** (`OFFSET n LIMIT 1`), or `$horizon` if
   fewer remain — then
   fold every row with `last_xid ≤ insert_xid < upper` (`upper ≤ $horizon` by
   construction, §3.5) and set
   `last_xid := upper`. A batch therefore holds exactly `n` whole xids, so
   `ROLLUP_BATCH_ROWS = 1` still advances by one xid per pass; a transaction's
   rows are never split, and no xid arithmetic is needed (`xid8` has none,
   §2.4.8). An idle system reaches `horizon` in one empty pass.
4. Commit. The fold and the watermark are **one transaction**: a failure
   between them rolls back both, so the retry re-reads the same rows and
   re-applies them once (07 "Idempotency", made true).

`insert_xid` is the xid of the inserting transaction — the write-and-release
transaction of §3.3. An unrelated long transaction cannot stall the rollup
unless it has been assigned an xid (read-only transactions have none); a stalled
rollup is **lag, not loss**, and a tick that finds `advanced_at` older than
ten ticks logs `warn`.

### 3.5 The fold statement

One statement per batch: a `MATERIALIZED` CTE of the batch and three
`INSERT … ON CONFLICT DO UPDATE` — one per grain — each grouped
`(endpoint_id, bucket)`, so a batch of _N_ rows for one bucket is **one**
upsert, not _N_.

- bucket = `date_trunc('minute' | 'hour' | 'day', started_at, 'UTC')`.
- counts: `count(*) FILTER (WHERE outcome = 'up')` etc.
- seconds: `sum(interval_s) FILTER (WHERE outcome IN ('up','down','degraded'))`
  for `covered_seconds`; `up_seconds` and `degraded_seconds` likewise. An
  `unknown` row adds a count and **no** seconds.
- latency (D6): `sum(total_ms)`, `min`, `max`, `sum(ttfb_ms)` and the histogram,
  all `FILTER (WHERE ttfb_ms IS NOT NULL)`.
- histogram: the batch's per-bucket counts are built as a 20-element array from
  `width_bucket(total_ms - 1, $edges) + 1`, **inserted as the initial row**
  (C2) and merged on conflict as
  `array(SELECT a + b FROM unnest(s.hist_total, EXCLUDED.hist_total) AS t(a,b))`.
- every `SET` is `col = s.col + EXCLUDED.col`, or `least`/`greatest` for min and
  max (they ignore `NULL`). No value is read into the worker and written back
  (`AGENTS.md`, Concurrency).

m1, h1 and d1 are all derived from the **same batch**, never from each other,
so no grain drifts from another. The merge is integer addition — associative
and exact (ADR-0003).

### 3.6 Partitions, created ahead

Four families, one table-driven service (`PartitionService`):

| family        | parent           | period | ahead                    | retention                  |
| ------------- | ---------------- | ------ | ------------------------ | -------------------------- |
| raw           | `probe_results`  | day    | `PARTITION_AHEAD_DAYS`   | `RETENTION_RAW_DAYS`       |
| claim log     | `claim_log`      | day    | `PARTITION_AHEAD_DAYS`   | `RETENTION_CLAIM_LOG_DAYS` |
| stats, minute | `probe_stats_m1` | day    | `PARTITION_AHEAD_DAYS`   | `RETENTION_M1_DAYS`        |
| stats, hour   | `probe_stats_h1` | month  | `PARTITION_AHEAD_MONTHS` | `RETENTION_H1_DAYS`        |

`d1` has no retention: 365 rows per endpoint per year (D11).

`ensure(now)`: under `pg_try_advisory_xact_lock` (an `IF NOT EXISTS` race
errors — §2.4.5), for each missing period create `CREATE TABLE p (LIKE parent
INCLUDING ALL)` then `ALTER TABLE parent ATTACH PARTITION p FOR VALUES FROM …
TO …`. Not `CREATE … PARTITION OF`, which blocks the whole parent (§2.4.4).
Bounds are written with explicit `+00` and names are derived in UTC
(`probe_results_p20260924`, `probe_stats_h1_p202609`), so a session time zone
changes nothing.

- **Bootstrap:** the worker runs `ensure` once before the scheduler starts —
  taking the _blocking_ advisory lock, so a peer already creating does not make
  it skip — and **exits non-zero if it fails**: starting to probe with nowhere
  to write produces only errors. `ensure` is `ensureRange(now, now + ahead)`;
  `ensureRange` takes any range, which is how the acceptance test creates the
  past 40 days.
- **Steady state:** every `STORAGE_MAINTENANCE_INTERVAL_MS` (1 h): `ensure`,
  then retention (§3.7). It logs the days of horizon it found; below one day is
  an `error`. A config `refine` requires `PARTITION_AHEAD_DAYS × 1 day > 2 ×
STORAGE_MAINTENANCE_INTERVAL_MS`, so two missed ticks still leave a horizon.
- **No default partition**, ever (ADR-0007).
- **Stats partitions outlive the raw they serve:** a `refine`
  requires `RETENTION_M1_DAYS ≥ RETENTION_RAW_DAYS` and
  `RETENTION_H1_DAYS ≥ RETENTION_RAW_DAYS`. Necessary, not sufficient (§3.7 step 3 guards the stats sweep too, D15): otherwise a raw row still awaiting
  its fold could find its stats partition already gone, and the fold would
  fail on that batch **every tick** — a poisoned rollup (D15).

### 3.7 Retention

Per family, oldest first, for each partition whose **upper bound** is at or
before `now() - retention` (the period comes from the partition's own name):

1. `ALTER TABLE parent DETACH PARTITION p FINALIZE` for any partition with
   `inhdetachpending` — recovers an interrupted run (§2.4.5).
2. **Guard (raw only):** the partition must hold no row with `insert_xid ≥
last_xid`. If it does, **do not drop**: log `error` (`unfolded rows in a
partition past retention`) and leave it attached, where the rollup can
   still fold it. Dropping unseen data is the one irreversible mistake this
   milestone can make. The guard runs _before_ the detach and needs no re-check
   after it: a row can only land in a partition whose whole range is older than
   `RETENTION_RAW_DAYS` if a probe started that long ago, and a `refine`
   (§5) requires `RETENTION_RAW_DAYS` to exceed lease plus shutdown grace.
3. **Guard (stats families m1, h1):** a stats partition covering `[lo, hi)` is
   not dropped while `probe_results` holds a row with `insert_xid ≥ last_xid`
   and `lo ≤ started_at < hi` (the raw scan prunes by `started_at`). Equal
   retention does not protect a lagging rollup by itself: the raw guard keeps
   the raw partition, the stats sweep drops the aggregate partition, and every
   later fold fails on a missing destination. The `refine`s in §3.6 keep the
   common case cheap; **this guard** is what makes it safe.
4. `SET lock_timeout = MAINTENANCE_LOCK_TIMEOUT_MS`, then, as a **single
   statement on that same dedicated connection**, `ALTER TABLE parent DETACH
PARTITION p CONCURRENTLY` (§2.4.6). A timeout logs `warn`, leaves it pending,
   and the next tick finalizes it.
5. `DROP TABLE p`. A detached leftover from a crash between 4 and 5 — no
   `pg_inherits` parent, name matches the family — is dropped by the same
   sweep.

No `DELETE` anywhere on a write path (`AGENTS.md`, Configuration). The
measurement in §9 runs Uptime Kuma's approach, a `DELETE` of the same rows,
against this one.

### 3.8 Percentiles and the window planner

`core/stats/` — pure, shared by the worker and (M8) the API:

- `bucketIndex(ms)` and the edges constant (3.1); a drift test asserts the SQL
  fold and this function agree on every edge ±1.
- `mergeHistograms(a, b)` — element-wise addition.
- `percentile(hist, p, {min, max})` — cumulative count to the bucket holding
  rank `p × n`, then **linear interpolation inside it** (ADR-0003). The
  lowest populated bucket's lower bound is `max(edge below, min)`; the highest
  populated bucket's upper bound is `min(edge, max)` — so the `∞` bucket
  interpolates to the observed maximum instead of an undefined edge, and the
  error is worst where buckets are widest, as the ADR states. `n = 0` → no
  value (`null`), never `0`.
- **Never averaged.** No function takes a percentile as input; `p95` exists
  only as an output of a merged histogram (`AGENTS.md`, Measurement).
- `planWindow(from, to, now, retention)` — tiles `[from, to)` with `d1` for
  whole UTC days, `h1` for whole hours, and `m1` for whole minutes, coarsest
  first. **Both bounds must be minute-aligned at every age**: no stored bucket
  is finer than a minute, so `[12:00:30, 12:01:30)` cannot be tiled and any
  answer would include or omit part of a boundary minute. An edge hour older
  than `RETENTION_H1_DAYS` no longer has its h1 bucket, so a window with an
  edge there must be **day-aligned**; one older than the m1 horizon
  (`RETENTION_M1_DAYS`) must be at least **hour-aligned**. Anything else is rejected with a typed error rather
  than silently rounded — never a plausible-looking partial result. (M8 decides
  how the UI aligns.)
- `StatsRepository.windowStats(userId, endpointId, from, to)` reads
  `probe_stats` only (≤ 30 `d1` + ≤ 46 `h1` rows for 30 days). **Ownership is
  re-derived here**, not left to callers: `probe_stats` has no `user_id`, so the
  query joins `endpoints` on `id = $endpoint AND user_id = $user` (the
  denormalized column, `0004`), and a foreign or missing endpoint returns
  not-found — never `403`, which would confirm the id exists (`AGENTS.md`) and returns counts, seconds,
  `avg`, `min`, `max`, and the merged histogram.

### 3.9 `claim_log` (M4 follow-up 2)

`claim_log` gets one row per claim — the same order as raw — and `bigserial`
cannot be a primary key on a partitioned table. It is dropped and recreated
`PARTITION BY RANGE (claimed_at)` (daily, no `id`, `(endpoint_id, scheduled_at)`
index), joining the family table above with `RETENTION_CLAIM_LOG_DAYS`
(default 3).

Data that predates it: **none deployed.** The M4 exit-test evidence is recorded
in `docs/m4-verification.md`, and the table on a developer's volume is
disposable. The migration says so in a comment and the plan's query is
`SELECT count(*) FROM claim_log` on the evidence-run volume (empty by
`docker compose down -v`, per the handoff). The duplicate-claim query the exit
test uses groups by `(endpoint_id, scheduled_at)` and does not read `id`; that
is grepped and pinned in a test.

### 3.10 What M5 leaves alone

- `endpoint_runtime` is unchanged. **M4's D17 (the M6 columns)** (`state`,
  `consecutive_*`, …) are not added and nothing here makes them harder: the
  writer's transaction already touches that row, and M6 can add its update to
  the same transaction.
- `endpoints` is not touched, so the two `interval_s` follow-ups (narrowing
  does not re-validate rows; the claim's interval-mismatch predicate) are
  **re-deferred**: M5 gives neither a reason to change.

---

## 4. Decisions

| #   | Decision                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Partition on `started_at`; key `(endpoint_id, started_at)`; `scheduled_at` is a column                                                                                                                                 | C1, §2.4.1. `started_at` is within a lease of now, so a write never targets an old, dropped partition — a resumed monitor's stale slot (D20) would, were `scheduled_at` the partition key. It is the worker's wall clock (M3 D37), so a worker skewed by more than the ahead horizon fails **loudly** (no partition) rather than mis-filing |
| D2  | `ON CONFLICT (endpoint_id, started_at) DO NOTHING`; slot not unique                                                                                                                                                    | retry idempotency; a duplicate slot is evidence to record, not to reject                                                                                                                                                                                                                                                                    |
| D3  | Insert and release in one transaction; a zero-row fence still commits the insert                                                                                                                                       | §3.3                                                                                                                                                                                                                                                                                                                                        |
| D4  | Retry the write up to `RESULT_WRITE_ATTEMPTS`; then error and leave the lease. No spool table                                                                                                                          | idempotent by key; a spool is machinery for a fleet. The gap becomes `UNKNOWN`, never healthy                                                                                                                                                                                                                                               |
| D5  | Outcome mapping per §3.3; `degraded` is never written in M5                                                                                                                                                            | needs M6's latency threshold; the enum value exists so M6 needs no `ALTER TYPE`                                                                                                                                                                                                                                                             |
| D6  | **Latency population = rows with `ttfb_ms IS NOT NULL`** (the endpoint produced response headers)                                                                                                                      | a connect-timeout's "latency" is probeboard's own timeout; a 500 that answered in 80 ms is a real latency. One rule serves `sum_total_ms`, `sum_ttfb_ms`, min, max and the histogram, so `sum(hist)` is the divisor of both averages                                                                                                        |
| D7  | Buckets are anchored on `started_at` in UTC; `interval_s` is the interval the slot was **scheduled** under, from the claim                                                                                             | time-weighting must use the interval the row represents (03 §3.5.1 case 1), not the endpoint's current one                                                                                                                                                                                                                                  |
| D8  | Add `up_seconds`, `degraded_seconds` to `probe_stats`; add `scheduled_at`, `interval_s`, `failure_code`, `redirects`, `truncated`, `insert_xid` to raw; **omit** `assertions` and `error_message`                      | C5, C7. Storage shape cannot be retrofitted (ADR-0003's argument). Response text in a row is a separate decision with a security surface                                                                                                                                                                                                    |
| D9  | Rollup watermark is a global `xid8` behind the snapshot horizon, single-flight by a row lock. **Rejected:** a timestamp watermark (§2.4.3), and a write-path fold                                                      | C3, C8                                                                                                                                                                                                                                                                                                                                      |
| D10 | Grouped additive fold; the initial row carries the computed histogram; all grains from one batch                                                                                                                       | C2; exactness                                                                                                                                                                                                                                                                                                                               |
| D11 | `probe_stats` = `LIST(granularity)`; m1 daily, h1 monthly, d1 unpartitioned and unbounded. h1 for 500 endpoints is 4.38 M rows a year; d1 is 182,500                                                                   | C6. d1 is negligible by the same arithmetic NFR-8 uses; h1 is bounded by `RETENTION_H1_DAYS` (default 400)                                                                                                                                                                                                                                  |
| D12 | No foreign keys on the four tables                                                                                                                                                                                     | `claim_log`'s measured deadlock (20/20 with the FK). A row for a deleted endpoint ages out; d1 orphans are 365 rows per endpoint per year, deferred                                                                                                                                                                                         |
| D13 | Partitions by `LIKE` + `ATTACH` under an advisory lock, ahead of need; no default partition; bootstrap failure exits the worker                                                                                        | §2.4.4–5; ADR-0007                                                                                                                                                                                                                                                                                                                          |
| D14 | Retention = `FINALIZE`, guard, `DETACH … CONCURRENTLY`, `DROP`                                                                                                                                                         | C4. A plain `DROP` was measured stalling every insert for the length of its transaction                                                                                                                                                                                                                                                     |
| D15 | The guard: a raw partition with unfolded rows is never dropped, nor is a stats partition any unfolded raw row targets; stats retention ≥ raw retention (`refine`) keeps the guard cold                                 | unrecoverable loss, and a poisoned fold, are the two ways retention can break the rollup                                                                                                                                                                                                                                                    |
| D16 | `le` buckets; interpolate inside the bucket, clamped to the observed min/max                                                                                                                                           | matches Prometheus; §3.8                                                                                                                                                                                                                                                                                                                    |
| D17 | Window planner rejects a window whose edges need a grain already retired (hour edges past `RETENTION_H1_DAYS`; sub-hour past the m1 horizon)                                                                           | rounding a window silently changes a number a user trusts                                                                                                                                                                                                                                                                                   |
| D18 | `claim_log` partitioned daily, 3-day retention; drop-and-recreate                                                                                                                                                      | §3.9                                                                                                                                                                                                                                                                                                                                        |
| D19 | The claim additionally `RETURNING`s `scheduled_interval_s`                                                                                                                                                             | the writer needs it; the claim already writes it on the same line                                                                                                                                                                                                                                                                           |
| D20 | **Resume inherits** the slot computed before the pause (M4 follow-up 3)                                                                                                                                                | The claim floors `next_run_at`, so a resumed monitor probes once at once — an immediate fresh result on resume is what a user wants. With D1 the stale `scheduled_at` cannot reach a dropped partition. Tested                                                                                                                              |
| D21 | The three enums from `0001` are reused, not recreated; `failure_class` labels are lowercase, so the writer lowercases; a drift test asserts the lowercased TS union equals the DB labels, and `probe_outcome` likewise | a new `FailureClass` without a migration would fail every insert of that class — a failure that is itself one of the two measurement defects `AGENTS.md` names                                                                                                                                                                              |

---

## 5. Config

All in `src/core/config/schema.ts`, validated at boot; each new key ships with
a **rejection** test in the same commit.

| Key                               | Type / bound                      | Default     | Note                                                                                                           |
| --------------------------------- | --------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `RETENTION_RAW_DAYS`              | `int().min(2).max(3650)`          | `7`         | `refine`: `× 86_400_000 > SCHEDULER_LEASE_MS + SCHEDULER_SHUTDOWN_GRACE_MS`; the acceptance test needs it < 30 |
| `RETENTION_M1_DAYS`               | `int().min(2).max(3650)`          | `7`         | `refine`: `≥ RETENTION_RAW_DAYS`                                                                               |
| `RETENTION_H1_DAYS`               | `int().min(2).max(3650)`          | `400`       | `refine`: `≥ RETENTION_RAW_DAYS`                                                                               |
| `RETENTION_CLAIM_LOG_DAYS`        | `int().min(1).max(3650)`          | `3`         |                                                                                                                |
| `PARTITION_AHEAD_DAYS`            | `int().min(1).max(30)`            | `3`         | `refine` vs the maintenance interval (§3.6)                                                                    |
| `PARTITION_AHEAD_MONTHS`          | `int().min(1).max(12)`            | `2`         |                                                                                                                |
| `STORAGE_MAINTENANCE_INTERVAL_MS` | `int().min(1000).max(86_400_000)` | `3_600_000` |                                                                                                                |
| `MAINTENANCE_LOCK_TIMEOUT_MS`     | `int().min(100).max(60_000)`      | `2000`      | the detach's `lock_timeout`                                                                                    |
| `ROLLUP_TICK_MS`                  | `int().min(100).max(600_000)`     | `10_000`    | 07's table                                                                                                     |
| `ROLLUP_BATCH_ROWS`               | `int().min(1).max(100_000)`       | `5000`      |                                                                                                                |
| `RESULT_WRITE_ATTEMPTS`           | `int().min(1).max(10)`            | `3`         |                                                                                                                |

All fit `int4`. Defaults quoted are the `schema.ts` values the PR will add, not
ceilings.

---

## 6. Module layout

```
src/core/stats/                      shared by worker and (M8) api
  constants.ts                       HISTOGRAM_EDGES_MS
  histogram.ts  (+ .test.ts)         bucketIndex, mergeHistograms
  percentile.ts (+ .test.ts)
  window.ts     (+ .test.ts)         planWindow
  repositories/stats.repository.ts   windowStats (+ .int.test.ts)
src/worker/storage/
  storage.module.ts
  services/partition.service.ts      ensure, retention (+ .int.test.ts)
  services/storage-maintenance.service.ts   bootstrap + timer
  repositories/probe-result.repository.ts   insert + persistAndRelease
  utils/outcome-mapping.ts (+ .test.ts)
  e2e/storage.int.test.ts
src/worker/rollup/
  rollup.module.ts
  services/rollup.service.ts         tick
  repositories/rollup.repository.ts  the fold statement
  e2e/rollup.int.test.ts
src/core/db/migrations/0008_storage.{up,down}.sql   (+ types.ts)
```

`core` depends on nothing; `worker/storage` and `worker/rollup` never import each
other or `api` (`architecture.test.ts`). The scheduler imports
`ProbeResultRepository` through `StorageModule`.

---

## 7. Integrity properties, and how each is proved

| Property                                                         | Mechanism                                           | Proved by (and removed to see it fail)                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every committed result is folded **exactly once**                | watermark + fold in one transaction                 | `rollback` injected between fold and watermark, then re-run: totals equal a from-scratch fold. Removal: advance the watermark in a second transaction → totals double                                                                                     |
| No row lost to commit order (C3)                                 | `insert_xid < horizon`                              | barrier: second connection holds an open write with a lower xid, a later row commits, tick runs, **assert the later row is not yet folded**, commit the first, tick, assert both, once. Removal: `ORDER BY started_at` watermark → first row never folded |
| Only one worker folds at a time                                  | `FOR UPDATE SKIP LOCKED` on the state row           | two concurrent ticks against a held state row: the second returns without reading. Removal: drop the clause → the second blocks or double-folds                                                                                                           |
| Aggregates equal the raw rows                                    | additive fold                                       | property test: random outcomes and latencies over N endpoints, fold, then per bucket `count_*`, seconds, `sum`, `min`, `max`, `Σ hist` equal `GROUP BY` over raw                                                                                          |
| The first probe of a bucket reaches the histogram (C2)           | initial row carries the histogram                   | one row → `hist` has exactly one count. Removal: initial `array_fill(0)` → fails                                                                                                                                                                          |
| `BLOCKED_BY_POLICY` / `UNKNOWN_ERROR` never count down (03 §3.4) | mapping table                                       | one row per class through the real writer; `count_down = 0`, `count_unknown = 1`, class and code persisted. Removal: default arm → `down`                                                                                                                 |
| A probe that reached no server does not enter latency (D6)       | `FILTER (WHERE ttfb_ms IS NOT NULL)`                | a connect-timeout at 10 s beside a 50 ms success: `max = 50`. Removal: drop the filter → 10000                                                                                                                                                            |
| Result and lease clear together (D3)                             | one transaction                                     | kill the insert (constraint) → lease still held; kill the release → no row. Removal: two transactions → one of the two states is reachable                                                                                                                |
| A retried write does not duplicate                               | `ON CONFLICT DO NOTHING`                            | same outcome twice → one row, one fold. Removal: plain insert → unique violation                                                                                                                                                                          |
| A missing partition is loud and never silent (D13)               | no default; write error                             | drop today's partition, run a slot: `error` logged, lease standing, no row in any table. Removal: add a `DEFAULT` partition → the row is written silently and the test fails                                                                              |
| Unfolded data is never dropped (D15)                             | retention guard                                     | old partition with one unfolded row: retention leaves it and logs. Removal: delete the guard → the partition is dropped and the test fails                                                                                                                |
| Retention never blocks the write path (D14)                      | `DETACH CONCURRENTLY`                               | a held reader of the old partition, retention running, an insert into today's completes in < 1 s. Removal: plain `DROP` → the insert waits (measured 2.04 s)                                                                                              |
| An interrupted detach recovers (§2.4.5)                          | `FINALIZE` first                                    | `lock_timeout` forced, then a clean run drops it. Removal: skip `FINALIZE` → partition stuck                                                                                                                                                              |
| **A 30-day p95 needs no raw row** (NFR-8/9)                      | `windowStats` reads `probe_stats` only              | §8 acceptance row                                                                                                                                                                                                                                         |
| Statistics reads are tenant-scoped                               | `windowStats` joins `endpoints` on `user_id`        | two users, one endpoint each: user B asking for A's endpoint gets not-found, identical to a random UUID. Removal: drop the `user_id` conjunct → B reads A's stats                                                                                         |
| Percentiles are never averaged                                   | API shape                                           | no exported function takes a percentile; a lint-style test scans `core/stats` exports                                                                                                                                                                     |
| No secret or body reaches a row                                  | `ProbeOutcome` has none; the columns list is closed | a test asserts the insert's column list against an allow-list                                                                                                                                                                                             |

Defenses that need no test because the type system carries them: `xid8`,
`sum_total_ms` and `insert_xid` typed `string`.

---

## 8. Test matrix

Unit (no I/O): outcome mapping, all 16 classes; `bucketIndex` at every edge and
±1 (10, 11, 50, 51, 30000, 30001); `mergeHistograms`; `percentile` (empty,
single value, one bucket, clamped `∞` bucket, p50/p95/p99, merge-then-percentile
equals percentile-of-concatenation); `planWindow` (a bound off the minute → rejected at every age; hour-aligned but not day-aligned beyond `RETENTION_H1_DAYS` → rejected; aligned, unaligned inside and
beyond the m1 horizon, DST-free UTC edges); config `refine`s, each with a
rejection case; `failure_class` and `probe_outcome` drift against the DB enum.

Integration (PostgreSQL): every row of §7; the migration up/down/up;
`ensure` idempotent under two concurrent callers; a resumed monitor's result
lands in a current partition (D20); `claim_log` retention; the grepped
duplicate-claim query still runs.

**Acceptance (`e2e/storage.int.test.ts`)** — the exit test, in this order:

1. Seed 40 days of raw rows for 3 endpoints (60 s, 43,200 rows per 30 days
   each) through the real insert, partitions created by `ensureRange`.
2. Run the rollup to a fixed point.
3. Record `exact_p95` from raw, and `approx_p95` from `windowStats`.
4. Run retention with `RETENTION_RAW_DAYS = 7`. Assert the partitions older than
   7 days no longer exist and the raw row count matches.
5. Call `windowStats` again: **the value is identical** to step 3, and within
   the histogram's bucket-width error of `exact_p95`.
6. The `EXPLAIN (ANALYZE, BUFFERS)` of the read names `probe_stats` and **no
   `probe_results` relation**; `pg_stat_force_next_flush()` and the raw
   partitions' scan counters do not move. Removal: point the read at raw → this
   step fails.

---

## 9. Delivery — 3 PRs

1. **Persist.** `0008` (+ `types.ts`, `.down`), config + rejection tests,
   `PartitionService.ensure` and bootstrap, the writer and the scheduler wiring,
   the claim's `RETURNING`, `claim_log` recreated, `core/stats` histogram
   constants. Revalidation: DB change → fresh clone, `docker compose` run from
   an empty volume, `psql` checks: rows appear, `outcome` mapping per class, no
   partition → loud.
2. **Aggregate.** The rollup, the fold statement, `core/stats` percentile and
   window planner, `StatsRepository`, the exactness and horizon tests. The
   acceptance test up to step 3.
3. **Retire, and prove.** Retention (`FINALIZE`, guard, detach, drop), the
   `claim_log` family, acceptance steps 4–6, and `docs/m5-verification.md`.
   Last PR of the milestone: fresh clone and a real run are required.

**`docs/m5-verification.md`** records, from an empty volume
(`docker-compose down -v`), the real container run and:

| Measurement                                                                        | Compared with                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| One monitor, 30 days at 60 s: rows, buffers and time to serve p95                  | the raw path over the same data — **43,200 rows** against ≤ 76 aggregate rows (NFR-9) |
| The same 30-day p95 **after** retention dropped the raw rows                       | the value before it                                                                   |
| Retention of one day of 500 endpoints (720,000 rows): time, WAL bytes, dead tuples | `DELETE` of the same rows — Uptime Kuma's method (`uptime-calculator.js:362`)         |
| Insert latency during retention: `DETACH CONCURRENTLY`+`DROP`                      | plain `DROP` (C4)                                                                     |
| Exact vs interpolated p95 across a lognormal and a bimodal distribution, by window | ADR-0003's promised error measurement                                                 |
| Rollup lag under load: `advanced_at` age with 1, 2 workers                         | the 10 s tick                                                                         |
| Every claim has ≤ 1 result (join `claim_log` ↔ `probe_results`)                    | the M4 disjointness evidence, now closed on both sides                                |

Numbers appear there only once measured; this plan states none it has not run.

---

## 10. Open questions — flagged, not resolved quietly

1. **C1 changes the key the handoff named.** `(endpoint_id, scheduled_at)`
   cannot be unique on a table partitioned by `started_at`. This plan keeps the
   partition key (handoff) and 07's key, and stores the slot without a unique
   constraint (D1, D2). If Levon would rather key on the slot, the partition key
   must move to it, which brings back a write to an old partition on resume
   (D1) and the M4 stale-slot problem. Recommendation: as planned.
2. **`probeboard-docs` needs four corrections** (outside this checkout, so
   reported, not made): 07 §7.5's upsert snippet loses the first histogram count
   (C2); `covered_seconds` cannot give time-weighted uptime alone (C5); ADR-0007
   and 07 should say `DROP` locks the parent and name `DETACH CONCURRENTLY` (C4);
   07 "Idempotency" describes a per-endpoint watermark that C3 shows is unsafe.
3. **`degraded` is M6's** (D5). If Levon wants latency-threshold `degraded` in
   M5, it needs a config key and a rule for what a slow success counts as.
4. **d1 and orphaned aggregates are unbounded** (D11, D12), by arithmetic:
   182,500 d1 rows a year at 500 endpoints. Acceptable for a thesis; say so if
   not.

---

## Sources

- `probeboard-docs/en/02-requirements.md` — NFR-3, NFR-4, NFR-8, NFR-9, NFR-13,
  §2.3 items 2–5
- `probeboard-docs/en/03-api-health.md` §3.4, §3.5.1, §3.5.2, §3.6
- `probeboard-docs/en/07-architecture.md` §7.5 (`probe_results`, `probe_stats`,
  "The rollup must be atomic", "Idempotency")
- `probeboard-docs/en/08-plan.md` row M5
- `probeboard-docs/en/adr/0003-histogram-percentiles.md`,
  `adr/0007-partitioned-retention.md`
- `docs/m4-plan.md` §3.1, §3.7, D25; `docs/m4-verification.md`;
  `docs/tracker.md` rows for #59
- `references/uptime-kuma/server/uptime-calculator.js` (MIT) — lines 340–370
- `references/gatus/storage/config.go` (Apache-2.0) — lines 8–9, 34–38
- `references/blackbox_exporter` (Apache-2.0) — histogram `le` convention
- PostgreSQL 17 docs: table partitioning, `ALTER TABLE … DETACH PARTITION
[CONCURRENTLY | FINALIZE]`, `pg_snapshot_xmin`, `pg_current_xact_id`,
  `width_bucket`, `date_trunc(field, timestamptz, zone)`
- Measurements in §2.4 run on PostgreSQL 17.11 (`postgres:17-alpine`), the
  image `docker-compose.yml` pins
