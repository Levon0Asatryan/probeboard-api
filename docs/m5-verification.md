# M5 — Storage: verification record

What was executed against the finished milestone, and what it produced. Plan:
[m5-plan.md](m5-plan.md). PRs: #65 (plan), #66 (persist), #67 (rollup and read
path), and the retention PR this record ships with.

Environment: PostgreSQL 17.11 (`postgres:17-alpine`, the image `docker-compose.yml`
pins); Node 22 in the containers, Node 24 on the machine that ran the test suites
(the SQL is what is measured, not the driver). One laptop, everything on it —
absolute timings are indicative, the **ratios and row counts are the evidence**.
Every container run started from an empty volume (`docker-compose down -v`).

## The exit test

> A 30-day p95 is served from aggregates after the raw rows have been dropped
> (NFR-8, NFR-9).

[`acceptance.int.test.ts`](../src/worker/storage/e2e/acceptance.int.test.ts):

1. Seed 40+ days at 60 s for three endpoints — **43,200 raw rows per endpoint per
   30 days** — and roll them up.
2. Record the exact p95 from the raw rows.
3. Read the 30-day window **as a database role that has no `SELECT` on
   `probe_results`** (control in the same file: that role gets `permission
denied` on a raw read). It is served from **30 aggregate rows**, and agrees
   with the exact p95 within its bucket width.
4. Run retention: every raw partition ending on or before the 7-day cutoff is
   **dropped** — 33 daily partitions, the 24 inside the window and 9 earlier; 6 days
   (8,640 rows) of the window's raw remain per endpoint.
5. Read the same window again: the result is **deep-equal** to step 3.
6. The read is still performed by the role that cannot read raw rows.

A negative control: with the rollup skipped, retention's guard refuses to drop and
step 4 fails; making the read touch `probe_results` fails all three endpoints.

## Real container runs

Three, one per PR, each from an empty volume.

**PR 1 — persistence.** `0001`→`0008` apply. Endpoints stored as `up`, `down /
connection_refused / ECONNREFUSED`, `down / status_mismatch / 404`; with the SSRF
guard on, private targets store as **`unknown / blocked_by_policy /
ADDRESS_NOT_ALLOWED`**, never `down`. 18 claims, each with exactly one result, no
lease left held. Dropping today's raw partition under the running worker gave
`result not persisted` at `error`, zero rows, leases left standing; a restart's
bootstrap recreated it.

**PR 2 — rollup, two workers.** Raw 9 = m1 9 = h1 9 = d1 9. Both workers folded, at
different times, with no double count. A connection-refused endpoint has counts and
**no latency data** (its `min`/`max` are `NULL` and its histogram is empty).

**PR 3 — retention, with `RETENTION_RAW_DAYS=2` and a 5 s maintenance tick.** Two old
partitions per family and 1,440 old raw rows (5 days back) were seeded under the
running worker:

| Observation                                     | Result                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Raw rows on the old day, before → after         | **1440 → 0**                                                                      |
| Raw partitions older than 2 days still attached | none                                                                              |
| The old day's aggregate                         | survives: `count_up 1440`, `covered_seconds 86400`, `min 100`, `max 139`          |
| Histogram of that day                           | 1440 counts, so its percentile is still computable                                |
| Every claim ↔ result (`claim_log` join)         | 3 one, **0 none, 0 many**                                                         |
| `rollup folded` lines by worker (2 workers)     | 11 and 2 — one folds per tick, no failed pass, no deadlock, no `retention failed` |

## Measurements

The harness was throwaway and is not committed; each measurement states its setup so
it can be repeated.

### The aggregate path against the raw path — one monitor, 30 days at 60 s

|                                                        | Raw rows   | Buffers      | Execution                                                                                   |
| ------------------------------------------------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------- |
| Raw path: `percentile_disc(0.95)` over `probe_results` | **43,200** | 1,267 shared | 9.6 ms (`EXPLAIN ANALYZE`); 6.8 ms median, 15 runs                                          |
| Aggregate path: 30 `d1` rows by primary key            | **30**     | 3 shared     | 0.062 ms (`EXPLAIN ANALYZE`); 3.55 ms median through `StatsRepository.windowStats`, 15 runs |

**1,440 times fewer rows**, and the aggregate path does not depend on the raw rows
existing. Read the time column with care: at this size everything is warm and
small, so wall-clock differs by about 2×, not by the row ratio. The raw side here
seq-scans because each daily partition holds only two endpoints; a 500-endpoint
partition would use the primary key, but it would still read 43,200 rows.
`windowStats`' 3.55 ms is end to end (ownership join, two partition-catalogue
lookups, planning and the JS merge), not the index scan alone.

### Retention against `DELETE` — one day of 500 endpoints at 60 s

720,000 rows, a 155.9 MiB partition.

|                                                                                                   | Time      | WAL written | Dead tuples | Size afterwards          |
| ------------------------------------------------------------------------------------------------- | --------- | ----------- | ----------- | ------------------------ |
| Detach concurrently + drop (`RetentionService`)                                                   | **81 ms** | **41 KB**   | 0           | gone                     |
| `DELETE FROM probe_results WHERE started_at …` (Uptime Kuma's method, `uptime-calculator.js:362`) | 152 ms    | **40.4 MB** | **720,000** | **155.9 MiB, unchanged** |
| … then `VACUUM` of that partition                                                                 | 1,057 ms  | —           | 0           | 75.5 MiB                 |

The `DELETE` is quick to _run_ and leaves the cost behind: 980 times the WAL, every
row a dead tuple, and not one byte returned until a vacuum that itself takes 13
times as long as the drop. The 81 ms covers the whole pass, every family.

### What retention does to writers — a reader holds the partition being retired

A probe-shaped insert loop into today's partition while a transaction holds the old
partition for 3 s and it is retired:

| Method                              | Inserts completed | p50      | p99      | Max          |
| ----------------------------------- | ----------------- | -------- | -------- | ------------ |
| `DETACH … CONCURRENTLY` then `DROP` | 433               | 1.13 ms  | 7.75 ms  | 15.5 ms      |
| Plain `DROP TABLE`                  | **2**             | 3,007 ms | 3,007 ms | **3,007 ms** |

A plain `DROP` takes `ACCESS EXCLUSIVE` on the **parent**, so every insert queues
behind it for as long as the reader holds on. This is the correction to ADR-0007
and 07 §7.5 ("O(1), no vacuum") that the plan's C4 named; it is now measured on the
running mechanism, not only in isolation.

### The rollup

|                                                          | Rows    | Time                         |
| -------------------------------------------------------- | ------- | ---------------------------- |
| One pass, everything folded at once                      | 100,800 | 1,174 ms (**85,800 rows/s**) |
| A steady-state tick at 500 endpoints (10 s ÷ 60 s × 500) | 83      | 8 ms                         |
| A full 5,000-row batch                                   | 5,000   | 116 ms                       |

Watermark age, sampled 20 times over 30 s with 40 endpoints at 30 s
(`now() - rollup_state.advanced_at`, tick 10 s):

| Workers | Median | Max   |
| ------- | ------ | ----- |
| 1       | 4.9 s  | 9.9 s |
| 2       | 2.2 s  | 7.2 s |

Bounded by the tick; two workers tick independently, so the median falls. At the
end of that run 119 of 121 stored rows were folded: the two newest were inside the
current tick, which is lag, not loss. **This is not the 500-monitor load test** —
that is M10's; this shows the loop's cost and bound, not saturation.

### Exact against interpolated percentiles (ADR-0003's promised evaluation)

Two distributions, 30 days at 60 s: a lognormal (median 120 ms) and a bimodal
mixture (85 % around 60 ms, 15 % around 1.8 s). Relative error of the
histogram-interpolated value against the exact one taken from the raw rows:

| Distribution | Window | p50   | p95    | p99    |
| ------------ | ------ | ----- | ------ | ------ |
| lognormal    | 1 d    | 2.2 % | 14.1 % | 11.9 % |
| lognormal    | 7 d    | 1.4 % | 12.0 % | 11.8 % |
| lognormal    | 30 d   | 1.9 % | 11.0 % | 8.4 %  |
| bimodal      | 1 d    | 2.1 % | 1.6 %  | 10.7 % |
| bimodal      | 7 d    | 2.2 % | 3.0 %  | 10.6 % |
| bimodal      | 30 d   | 2.2 % | 3.7 %  | 11.9 % |

Every value lies inside its bucket, as the ADR bounds it, and the error does **not**
shrink with the window: it is set by where the percentile falls. The lognormal p95
(exact 367–377 ms) sits in the 300–500 ms bucket, so the interpolated 418 ms is 11–14 %
high. The bimodal p95 lands in the 1.5–3 s region and is off by under 4 %. The p99s
sit in the wide 3–5 s bucket and are off by 8–12 % in both. **The edges are the
lever**: the buckets are coarsest exactly where users read a tail, which is the trade
ADR-0003 accepted for exact mergeability, and the number to weigh is above.

## Guards proved by removal

Every guard the milestone adds was removed and its named test watched failing.
Beyond the per-PR lists: retention — guard skipped, watermark row missing (fail
open), no `FINALIZE` recovery, plain `DETACH` in place of `CONCURRENTLY`,
`lock_timeout` left on the connection, no advisory lock, no leftover sweep, cutoff
off by one; maintenance loop — retention never called, its failure not isolated,
blocked partitions not reported; acceptance — rollup skipped.

## Defects found by running it

- **The plan's key could not exist** (C1): `PRIMARY KEY (endpoint_id, scheduled_at)`
  on a table partitioned by `started_at` is rejected by PostgreSQL 17.
- **07 §7.5's upsert dropped the first probe of every bucket from the histogram**
  (C2): the insert branch carried an all-zero array; only the conflict branch
  incremented.
- **A timestamp watermark loses a late commit** (C3), demonstrated; the `xid8` horizon
  replaces it.
- **`DROP` and plain `DETACH` lock the parent** (C4), 2.04 s in isolation, 3.0 s under
  the retention measurement above.
- **`docker compose` did not exist** on this machine: the sandboxed `DOCKER_CONFIG`
  has no `cli-plugins`; the standalone `docker-compose` works.
- **A "connection refused" endpoint stored as `unknown_error`.** It was my test target:
  port 1 is on `fetch`'s bad-port blocklist (`Error: bad port`), not a refused connection.
  A real closed port stores as `connection_refused`. A monitor pointed at a blocked
  port therefore records `unknown`, excluded from uptime — a user-configuration edge for
  M6, not an M5 defect.
- **Codex's findings**: 14 on the plan (12 fixed, one pushed back with the code as evidence,
  one deferred), 2 on #66 (a backoff outliving the shutdown grace; a per-statement
  `statement_timeout` applied once), 1 on #67 (a stale-watermark diagnostic that could not
  fire). Each fixed one has a removal-proved test.
- **Defects in my own verification, caught by re-running it:** a removal proof that
  mutated a doc comment instead of the SQL (the mutation "passed"); `timeout(1)` absent on
  macOS, so seven "failures" were `command not found`; a read-path test that could not fail
  because the global setup's own partitions are older than the test's; a lag sampler that
  omitted `FROM`.
- **The machine stalls intermittently.** Twice a whole test run froze for 47–153 s,
  failing unrelated tests; each cleared on rerun and passed in isolation. Treated as the
  laptop, not the code; if it recurs in CI that reading changes.

## Deviations from the merged plan

| Plan                                        | Deviation                                                                                                                                 | Why                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| §3.1 key                                    | `PRIMARY KEY (endpoint_id, started_at, attempt_id)`; the plan's `(endpoint_id, started_at, worker_id)` was itself replaced in review      | a same-millisecond duplicate, or a clock-corrected one on one worker, would otherwise be discarded by `DO NOTHING` |
| §3.8 `planWindow(from, to, now, retention)` | `planWindow(from, to, retainedFrom)`; availability read from the live partitions, re-checked after the read                               | retention can be raised over partitions already dropped, and can detach between lookup and read                    |
| §5 config                                   | Added `ROLLUP_STALE_TICKS`, `RESULT_WRITE_BACKOFF_MS`; the plan's table did not list them                                                 | a literal where config belongs (rule #1)                                                                           |
| §3.4                                        | `advanced_at` moves only when the watermark does                                                                                          | otherwise a pinned horizon hides a stall from the warning                                                          |
| §3.7                                        | Retention is single-flight across workers by a session advisory lock                                                                      | two workers must not race a detach and a drop of one partition                                                     |
| §3.3                                        | The write's `statement_timeout` is re-derived before each of the two statements                                                           | it applies per statement                                                                                           |
| §3.5                                        | The fold's outer `SELECT` reads the three grain CTEs to force them, with `LIMIT 1`                                                        | unused column removed; data-modifying CTEs run regardless                                                          |
| §8                                          | The tenant/statistics read tests live under `worker/rollup/e2e/`, and the acceptance test is in a year earlier than every other partition | `core` may not import `worker`, even in a test; retention drops anything older than its cutoff                     |

## Not verified

- **The 500-monitor load test** (NFR-6) is M10's. Rollup lag and cost are shown above,
  not saturation.
- **Retention against a real long-running reader in the container.** It is proved by the
  integration suite (a held transaction, an observable lock wait) and measured in the
  harness; the container run shows retention with no reader.
- **`retainedFrom` assumes contiguous partitions**, which holds because retention drops
  oldest-first and creation runs forward. A manually created gap would read as available.
- **Aggregates for a deleted endpoint** stay (`h1` until its retention, `d1` for good, 365
  rows per endpoint per year). Deferred by arithmetic (plan D11, D12).
- **Node 22 for the suites**: the containers ran Node 22; the test suites ran on Node 24.
- **The workflow twin of `/probe-review`** (six independent lenses) was not run for any of
  the three PRs; the passes were run inline.

## Follow-ups for the tracker

| Item                                                                                                                                                                           | Kind    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| M6: an endpoint whose URL uses a `fetch`-blocked port records `unknown_error` forever; decide whether the save-time check should reject those ports                            | decide  |
| Seconds columns are attributed whole to the bucket holding `started_at`; time-weighted uptime is not offered for windows shorter than the longest allowed interval (plan §3.5) | decide  |
| Interpolation error reaches 11–14 % at p95 where the bucket is wide; weigh finer edges against ADR-0003's fixed, mergeable format before M10                                   | decide  |
| `probeboard-docs`: correct 07 §7.5's upsert, `covered_seconds`, the `DROP` lock (ADR-0007) and 07 "Idempotency"                                                                | docs    |
| `probe_stats` orphans for deleted endpoints (h1 until retention, d1 for ever)                                                                                                  | decide  |
| The machine's intermittent stalls; check CI for the same signature                                                                                                             | process |
