# M4 — Scheduler: implementation plan

Claims due endpoints across N worker processes, leases them, executes the
probe M3 already built, and releases the lease. Nothing is persisted: M5 owns
`probe_results`, M6 the aggregates and counters, M7 alerting.

Requirements: **NFR-1** (a slow endpoint must not delay others), **NFR-2**
(drift under 10% of T, never accumulating), **NFR-3** (no monitor probed twice
for one slot, including across instances), **NFR-4** (a dead worker's claim
becomes available again in bounded time), **NFR-7** (throughput scales by
starting a process, no configuration change), **FR-17** (every active monitor
probed at its interval with no operator intervention). FR-9's paused monitor
stops being probed here, where `endpoints.enabled` gets its first reader.

Milestone exit test (`08-plan.md` row M4): _two workers, no duplicates; kill
one mid-probe, work is reclaimed._

---

## 1. Scope

**In.** `endpoint_runtime` and its migration (`0007`); the claim statement;
leases and their release; the catch-up guard; the bounded concurrency pool;
the tick loop and its shutdown; the monitor loader that turns rows into the
`EndpointProbeConfig` M3 already accepts.

**Out, and named so they are not smuggled in.**

| Out                                                                      | Owner                                        |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| Persisting `ProbeOutcome` and anything reading it                        | M5                                           |
| Uptime/latency aggregates, `UNKNOWN` sweep, consecutive-failure counters | M6                                           |
| Incidents, notifications, the outbox                                     | M7                                           |
| `/metrics`                                                               | M10                                          |
| The 500-monitor load test for NFR-6/NFR-7                                | M10, evaluation chapter                      |
| Any change to `probe()`'s internals                                      | nobody — M4 drives it, it does not change it |

M4 executes probes and **logs** the outcome. That is deliberate: the exit test
needs probes genuinely in flight to kill a worker during, and `probe()` needs a
real driver before M5 has anything to store.

---

## 2. Investigation

### 2.1 Requirements and architecture read together

`02-requirements.md` NFR-1…4, NFR-7, FR-9, FR-17; `07-architecture.md` §7.1,
§7.2, §7.3, §7.5; `03-api-health.md` §3.5.2, §3.7; ADR-0001, ADR-0002.

Four things the documents leave open or state in a way the code cannot follow
literally. Each is resolved by a decision below rather than quietly.

1. **§7.3's claim query does not say when `next_run_at` advances relative to
   the probe, but §7.2 does** — step 2 (`next_run_at = scheduled_at +
interval`) precedes step 3 (the probe), "so a slow probe delays one cycle
   instead of shifting every future one". Taken literally this makes the
   scheduler **at-most-once per slot**: a worker that dies mid-probe does not
   get that slot retried, because the slot was consumed at claim time. That is
   the right reading (D5), it is what NFR-3 asks for in its own words ("no
   monitor is probed twice for the same scheduled slot"), and it changes what
   "reclaim" means in the exit test — spelled out in D6.

2. **§7.5's `endpoint_runtime` mirrors `enabled` and `interval_s` from
   `endpoints`.** Nothing in the documents says who keeps the mirror in step.
   A stale mirror is a paused monitor that keeps being probed (FR-9 broken,
   silently) or a monitor probed at its old interval. D2 declines the mirror
   and joins instead.

3. **§7.3's catch-up guard is stated in prose** ("when `next_run_at` falls more
   than one interval behind, it is snapped forward to the next future slot")
   with no arithmetic, and the prose implies a branch — a normal case and a
   catch-up case. D4 shows they are one expression, and that the "normal"
   formula is the degenerate case of the general one.

4. **Nothing states which clock is authoritative.** §7.3's SQL uses `now()`
   throughout, but a worker also has `Date.now()` and the M3 monotonic clock.
   Mixing them is the documented source of duplicate execution under skew
   (§2.4.4). D3 makes the database clock the only authority for scheduling.

**No contradiction found** between NFR-3 and NFR-4 once (1) is resolved: NFR-4
says a dead worker's claimed work becomes _available_ again in bounded time,
not that the lost slot is re-run. `03-api-health.md` §3.5.2 closes the loop —
"probeboard treats a missing expected probe as `UNKNOWN` … this is the
user-visible half of NFR-4". A crash produces an `UNKNOWN` slot, never a
duplicate and never a false green.

### 2.2 Code on `main` this touches

| File                                                            | State                                                                                                                | What M4 does with it                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/worker/probing/index.ts`                                   | exports `probe`, `createConnector`, `Clock`, `EndpointProbeConfig`, `ProbeDeps`                                      | the only entry point used; nothing reaches into `utils/`                        |
| `src/worker/main.ts`                                            | boots an application context, logs, `await untilShutdown()`, `app.close()`                                           | gains the scheduler between "started" and the shutdown wait                     |
| `src/worker/lifecycle/shutdown.ts`                              | `untilShutdown()` resolves on SIGTERM/SIGINT; its keep-alive timer holds the loop open                               | unchanged; its own comment already anticipates M4                               |
| `src/worker/worker.module.ts`                                   | `ConfigModule`, `LoggerModule`, `DbModule`                                                                           | gains `SchedulerModule`                                                         |
| `src/core/db/types.ts`                                          | `EndpointsTable.enabled` — "Inert until M4's scheduler reads it"                                                     | gains `EndpointRuntimeTable`; the `enabled` comment is corrected                |
| `src/core/config/schema.ts`                                     | `WORKER_ID`, `SCHEDULER_TICK_MS`, `SCHEDULER_BATCH_SIZE`, `SCHEDULER_LEASE_MS`, `PROBE_CONCURRENCY` already declared | gains bounds and three cross-field rules (§5)                                   |
| `src/core/registration/{url,header-merge,header-decryption}.ts` | in `core`, importable from `worker`                                                                                  | reused as-is to build the probe config — no second implementation               |
| migrations                                                      | latest is `0006`                                                                                                     | ours is `0007`, with its `.down.sql` and a `types.ts` change in the same commit |

`PROBE_CONCURRENCY` (default 50) and the four `SCHEDULER_*` keys already exist
and are read by nothing. M4 is their first reader, so each gains a rejection
test in the same commit, per AGENTS.md.

`src/testing/database.ts` already says it: _"the claim queries that arrive in
M4 cannot be meaningfully tested against a mock"_. `truncateAll()` discovers
tables from `pg_tables`, so `endpoint_runtime` needs no change there.

### 2.3 Prior art — how comparable systems get this wrong

Read directly in `../references/`, not recalled. Each row ends in a decision or
a test.

**Uptime Kuma** (`server/model/monitor.js`, MIT).

- Re-arms with `setTimeout(safeBeat, Math.max(1, beatInterval*1000 - dayjs().diff(bean.time)))`
  (line 1082). The drift compensation is correct _within_ a cycle, but the
  reference is **this beat's actual time**, not a fixed schedule, so the phase
  walks whenever a probe is slow. Our `next_run_at` is derived from the slot,
  so the phase is fixed for the life of the monitor (D4).
- `Math.max(1, …)` is the failure: an endpoint slower than its own interval
  re-arms at **1 ms**, so Kuma probes it back-to-back, continuously. That is
  the burst ADR-0002 names, reached without any outage at all. Our equivalent
  is prevented twice over — the lease keeps a row with a probe still in flight
  out of the claim, and the catch-up guard lands `next_run_at` strictly in the
  future (D4, D7). **Test:** an endpoint whose probe outlives its interval is
  claimed once, not repeatedly.
- `safeBeat`'s catch re-arms at the full interval, so a thrown error silently
  costs a cycle with no record — AGENTS.md's "long-running loop that can exit
  silently when its work throws". **Test:** a probe that rejects still releases
  its lease and still logs (D10).
- Line 3 imports `unlimited-timeout` because Node's `setTimeout` overflows.
  Verified on the pinned runtime, §2.4.1 — and it applies to us.
- No claim, no lease: two instances double everything. This is ADR-0002's
  Option B and the reason it was rejected.

**Gatus** (`watchdog/watchdog.go`, `watchdog/endpoint.go`, Apache-2.0).

- One goroutine and one `time.Ticker` per endpoint, staggered at boot by a
  fixed `time.Sleep(222 * time.Millisecond)` between starts. For 500 endpoints
  that is 111 seconds of startup, and the phase is boot-order-dependent — lost
  on every restart. Our de-herding is a jitter written to the database once, so
  it survives restarts and costs nothing at boot (D8).
- `executeEndpoint` acquires the concurrency semaphore **inside** the ticker
  callback. Go's `Ticker` drops ticks rather than queueing them, so when the
  semaphore is saturated the endpoint's tick is consumed while blocked: slots
  are skipped **silently**, and the effective interval quietly changes under
  load. Ours cannot hide that — an unclaimed slot stays due in the database,
  visible as `next_run_at` in the past, claimable by any other worker (D9).
- Worth adopting as a citation, not code: the comment on the semaphore says it
  exists because _"conditions using response time may become inaccurate"_
  without it. That is NFR-5 arriving at a concurrency limit from the
  measurement side, and it is a second reason for D9 beyond NFR-1.

**openstatus** (`apps/workflows/src/checker/outbox.ts`, AGPL-3.0 — **read
only**, design cited, no code copied). The closest real analogue: a
claim-and-lease loop over a queue table, run on two machines at once.

- Their lease is derived, not guessed:
  `leaseSeconds = ceil(limit / DELIVERY_CONCURRENCY) * timeoutMs + LEASE_SLACK_MS`.
  The `waves` term exists because a claimed row can sit waiting behind a full
  batch. D9 removes that term from our arithmetic by never claiming more than
  the pool can start immediately — ours is the `waves = 1` case (D11).
- Their shutdown is the model for ours: _"Anything still sending keeps its
  lease: the provider call can succeed after we stop watching, so the peer
  waits for the lease to lapse rather than starting a second send while this
  one is outstanding."_ Exactly our SIGTERM problem (D12).
- **A defect to not copy.** `commitReleased`/`commitRetry` clear `lockedBy`
  and `lockedUntil` filtered by **row id alone**. A worker whose lease already
  lapsed therefore clears a lease a _different_ worker has since taken, and the
  row is delivered twice. Their `shutdownOutbox` does guard on
  `lockedBy = workerId`; the per-row commits do not. This is the fencing-token
  problem Kleppmann raises against lease-based locking, and it is a real one:
  the guard must be on every write, not the one someone remembered. D13 guards
  our release on `leased_by` **and** `scheduled_at`, proved by removal.
- Their monitor checks are not hand-rolled at all — they are dispatched through
  Google Cloud Tasks. Their in-process cron (`cron/scheduler.ts`) is only for
  maintenance, and its header states the constraint plainly: _"Every task is
  safe to run on both machines at once."_ In-process cron on N instances is
  safe exactly when every task is idempotent or claim-atomic — which is
  ADR-0002's argument for why `@nestjs/schedule` is not.

**Quartz / Kubernetes CronJob** — the catch-up problem, named. Quartz calls a
slot that could not fire a _misfire_ and makes the policy explicit per trigger
(`MISFIRE_INSTRUCTION_FIRE_ONCE_NOW`, `…_DO_NOTHING`,
`…_RESCHEDULE_NEXT_WITH_REMAINING_COUNT`). Kubernetes CronJob has
`startingDeadlineSeconds` plus a hard rule: if more than 100 schedules are
missed, the controller stops scheduling and logs an error — a documented
failure mode where a long outage wedges the job permanently rather than
resuming. D4 takes Quartz's "fire once now, then reschedule to the next future
slot" and deliberately does **not** take Kubernetes' wedge: a monitor offline
for any length of time resumes, with the gap left as a gap.

**pg-boss / the `SKIP LOCKED` pattern.** ADR-0002 rejected pg-boss for hiding
the mechanism, not for being wrong; it implements the same statement
internally. The pattern's known failure is lease expiry under load — a claim
held longer than its lease, re-claimed, executed twice. D11 makes that a
boot-time impossibility rather than an operational hope.

### 2.4 Mechanics verified directly, not recalled

AGENTS.md: a behaviour claim taken from memory is a finding. Everything below
was run. Postgres is **17.11** (`postgres:17-alpine`, the image
`docker-compose.yml` pins); Node is **22.23.2**, the major `.nvmrc`, both
`Dockerfile` stages and CI pin — this machine's default is Node 24, so the
timer check was re-run inside `node:22-alpine`.

#### 2.4.1 `setTimeout` silently collapses above 2³¹−1 ms

```
$ docker run --rm node:22-alpine node -e "…setTimeout(f, 2**31)…"
node v22.23.2
(node:1) TimeoutOverflowWarning: 2147483648 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
OVERFLOW TIMER FIRED after 2 ms (asked for 2**31 ms)
```

A delay over 24.8 days becomes **1 ms**. `SCHEDULER_TICK_MS` today is
`min(100)` with **no maximum**, so a fat-fingered value turns the tick into a
hot loop hammering the database — the opposite of what was configured. This is
why Uptime Kuma imports `unlimited-timeout`. Fixed by a bound, not a library
(§5, D14).

#### 2.4.2 The claim statement plans as intended, and the index is used

600 endpoints (10% disabled), all due, `LIMIT 100`, `EXPLAIN (ANALYZE, BUFFERS)`:

```
Update on endpoint_runtime r (actual time=0.194..0.614 rows=100 loops=1)
  CTE due
    ->  Limit (actual time=0.030..0.107 rows=100 loops=1)
          ->  LockRows
                ->  Nested Loop
                      ->  Index Scan using endpoint_runtime_next_run_at_idx on endpoint_runtime r_1
                            Index Cond: (next_run_at <= now())
                            Filter: ((leased_until IS NULL) OR (leased_until < now()))
                            (actual rows=111)
                      ->  Index Scan using endpoints_pkey on endpoints e
                            Filter: enabled
Execution Time: 0.721 ms
```

Three things this settles, none of which were assumed:

- `FOR UPDATE OF r SKIP LOCKED` **is** accepted on a join, and locks only
  `endpoint_runtime`.
- The scan is an **index scan on `endpoint_runtime (next_run_at)`**, and the
  `ORDER BY next_run_at` is served by the index — there is no sort node. It
  read 111 rows to return 100: the 11 extra are the disabled ones, rejected by
  the join's `Filter: enabled`. The ordering means the work is bounded by
  `LIMIT`, not by how far behind the fleet is.
- At 600 rows the **outer** `UPDATE` chose a Seq Scan + Hash Join. That is a
  cost decision on a tiny table, not a missing index: repeated at **50,000**
  endpoints it flips, as it should —

```
Update on endpoint_runtime r (actual time=0.063..0.523 rows=100 loops=1)
  ->  Nested Loop
        ->  CTE Scan on due (rows=100)
        ->  Index Scan using endpoint_runtime_pkey on endpoint_runtime r (loops=100)
  … inner scan: Index Scan using endpoint_runtime_next_run_at_idx (actual rows=123)
Execution Time: 0.594 ms
```

0.594 ms at 50,000 endpoints, reading 123 index entries. NFR-6's load test is
M10's, but the statement is not the thing that will need revisiting.

#### 2.4.3 What removing `SKIP LOCKED` actually does — **not** duplicates

This one contradicts the obvious expectation, so it was measured. Session A
claims 5 rows in an open transaction and holds them (`pg_sleep`); the barrier
polls `pg_stat_activity` until A is genuinely executing — no sleep-and-hope.
Session B then runs the same claim.

| B's statement                 | Time                             | Rows       | Overlap with A |
| ----------------------------- | -------------------------------- | ---------- | -------------- |
| `FOR UPDATE OF r SKIP LOCKED` | **2.182 ms**                     | 5 disjoint | 0              |
| `FOR UPDATE OF r` (removed)   | **11 984 ms** — exactly A's hold | 5          | **0**          |

Removing `SKIP LOCKED` produces **blocking, not duplicates**. Postgres's
EvalPlanQual re-checks the locking node's qualifiers against the updated row
version, so B — once unblocked — sees `leased_until` in the future and moves on
to other rows. Disjointness comes from the row lock plus the `leased_until`
predicate; `SKIP LOCKED` supplies the _no-blocking_ half.

This matters for more than accuracy. A "duplicate-prevention test" written to
fail when `SKIP LOCKED` is removed would **not** fail — it would pass, slowly,
which is precisely the M3 defect shape of a test that passes for the wrong
reason. D15 states what each clause is actually proved by, and the removal
proof for `SKIP LOCKED` asserts **promptness**, which does fail, every time,
by ~4 orders of magnitude.

ADR-0002's clause table says `FOR UPDATE SKIP LOCKED` → "NFR-3 — disjoint
batches, no blocking". Both halves are real; they come from different parts of
the clause. Nothing in the ADR needs changing, but the plan says which is which
so the tests do not claim the wrong thing.

#### 2.4.4 `now()` is transaction-stable; `clock_timestamp()` is not

```
BEGIN; n1 := now(); c1 := clock_timestamp();
SELECT pg_sleep(1);
now() = n1                → t
clock_timestamp() = c1    → f      clock_timestamp() - now() → 00:00:01.004
```

So a single-statement claim (autocommit) evaluates **one** `now()` for the
due-check, the lease-expiry check, the lease grant and the catch-up arithmetic.
That is what makes D4's `misses ≥ 0` a proof rather than a hope, verified
directly on a row due exactly at `now()`:

```
misses | strictly_future
     0 | t
```

It also forbids a multi-statement claim with think-time between `SELECT` and
`UPDATE`: `now()` would be the transaction's start and already stale. D1.

#### 2.4.5 The catch-up arithmetic, seven cases

`misses = floor(extract(epoch from (now() - slot)) / interval_s)`,
`next = slot + make_interval(secs => interval_s * (misses + 1))`:

| case                  | now() − slot | misses | next − now() |
| --------------------- | ------------ | ------ | ------------ |
| on time, exact        | 0 s          | 0      | 60 s         |
| on time, mid-interval | 30 s         | 0      | 30 s         |
| one interval late     | 60 s         | 1      | 60 s         |
| 59 min offline        | 3540 s       | 59     | 60 s         |
| one hour exactly      | 3600 s       | 60     | 60 s         |
| one hour + 1 s        | 3601 s       | 60     | 59 s         |

One expression, no branch, always strictly in the future, always on the
original phase. `make_interval(secs => …)` accepts the numeric the `floor`
produces, and yields a fixed-duration interval — adding it to a `timestamptz`
is absolute arithmetic, with none of the calendar behaviour `interval '1 day'`
would bring.

#### 2.4.6 Adoption is idempotent, jitter de-herds, the fence holds

```
INSERT … SELECT … WHERE NOT EXISTS (…) ON CONFLICT (endpoint_id) DO NOTHING
  first run:  INSERT 0 50600
  second run: INSERT 0 0          runtime_rows = endpoint_rows = 50600
```

Jitter `now() + make_interval(secs => random() * least(interval_s, 60))` over
50,600 rows, bucketed by 5 s: 4094–4343 per bucket. Flat.

The fence, with `worker-NEW` holding the lease and the zombie `worker-OLD`
trying to release it:

```
UPDATE … WHERE endpoint_id = … AND leased_by = 'worker-OLD'
→ UPDATE 0        leased_by = worker-NEW, still_leased = t
```

#### 2.4.7 The final statement, run as written

§3.1's statement verbatim — per-endpoint `interval_s` joined into the catch-up
arithmetic, rather than the constant the earlier probes used — against three
endpoints at different intervals, each set 40 intervals in the past:

```
 interval_s | strictly_future | secs_ahead | intervals_jumped | leased_by | lease_secs
         30 | t               |         30 |               41 | worker-1  |         60
         60 | t               |         60 |               41 | worker-1  |         60
        300 | t               |        300 |               41 | worker-1  |         60
(3 rows)                                                   UPDATE 3
```

One row per endpoint — one probe each, not 40 — `next_run_at` exactly one
interval ahead of `now()` and `misses + 1 = 41` intervals ahead of the claimed
slot, on the original phase, at every interval length. The `FROM due JOIN
endpoints e` form needed to reach `e.interval_s` from the `UPDATE` is valid and
does not disturb the plan in §2.4.2.

---

## 3. Design

### 3.1 The claim statement, clause by clause

One statement, issued on a tick, in autocommit:

```sql
WITH due AS (
  SELECT r.endpoint_id
  FROM   endpoint_runtime r
  JOIN   endpoints e ON e.id = r.endpoint_id
  WHERE  e.enabled
    AND  r.next_run_at <= now()
    AND  (r.leased_until IS NULL OR r.leased_until < now())
  ORDER  BY r.next_run_at
  FOR UPDATE OF r SKIP LOCKED
  LIMIT  $batch
)
UPDATE endpoint_runtime r
SET    scheduled_at  = r.next_run_at,
       next_run_at   = r.next_run_at
                       + make_interval(secs => e.interval_s *
                           (floor(extract(epoch from (now() - r.next_run_at))
                                  / e.interval_s) + 1)),
       leased_until  = now() + make_interval(secs => $leaseMs / 1000.0),
       leased_by     = $workerId
FROM   due
JOIN   endpoints e ON e.id = due.endpoint_id
WHERE  r.endpoint_id = due.endpoint_id
RETURNING r.endpoint_id, r.scheduled_at, r.next_run_at;
```

**What it returns.** One row per endpoint this worker now owns, with the slot
it owns it for (`scheduled_at`) and the slot after (`next_run_at`). Nothing
else in the process decides what to probe.

**How the batch is bounded.** `LIMIT $batch`, where `$batch` is
`min(SCHEDULER_BATCH_SIZE, PROBE_CONCURRENCY − inFlight)` computed by the
caller (D9). `ORDER BY r.next_run_at` makes the batch the _oldest_ due work, so
a backlog drains in schedule order rather than index order, and the statement's
cost is set by `LIMIT` rather than by the size of the backlog (§2.4.2: 123
index entries read for 100 rows at 50k endpoints).

**What it sets**, and why each:

| Clause                            | Requirement         | Note                                                                              |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `FOR UPDATE OF r SKIP LOCKED`     | NFR-3, NFR-1, NFR-7 | disjoint batches **without blocking**; §2.4.3 for which half comes from where     |
| `e.enabled`                       | FR-9                | joined, never mirrored (D2)                                                       |
| `r.next_run_at <= now()`          | FR-17               | the only definition of "due"                                                      |
| `leased_until IS NULL OR < now()` | NFR-3, NFR-4        | excludes a probe in flight; a dead worker's row returns when the lease lapses     |
| `ORDER BY r.next_run_at`          | NFR-2               | oldest first; served by the index, no sort                                        |
| `scheduled_at = r.next_run_at`    | NFR-3               | names the slot; the fence and M5's natural key both need it                       |
| `next_run_at = … floor(…) + 1`    | NFR-2               | derived from the slot, never `now() + interval` (D4)                              |
| `leased_until = now() + $lease`   | NFR-4               | bounded reclaim (D11)                                                             |
| `leased_by = $workerId`           | NFR-4, fencing      | who to ask, and the fence on release (D13)                                        |
| no per-worker configuration       | NFR-7               | `$workerId` is identity, not configuration; a new worker needs no change anywhere |

`FOR UPDATE OF r` — the locking clause names the alias, so `endpoints` is read
but never locked. The API writing an endpoint row cannot block a claim, and a
claim cannot block the API.

### 3.2 `endpoint_runtime`

```sql
CREATE TABLE endpoint_runtime (
    endpoint_id   uuid        PRIMARY KEY REFERENCES endpoints (id) ON DELETE CASCADE,
    next_run_at   timestamptz NOT NULL,
    scheduled_at  timestamptz,
    leased_until  timestamptz,
    leased_by     text,
    last_probe_at timestamptz
);
CREATE INDEX endpoint_runtime_next_run_at_idx ON endpoint_runtime (next_run_at);
```

**Why a separate table at all** (`07-architecture.md` §7.5, restated because it
is the design's load-bearing claim): every column here is written on **every
probe**; `endpoints` columns are written almost never. Splitting keeps the hot
row narrow so the update stays HOT, keeps that churn off `endpoints`' five
indexes, and keeps autovacuum away from the configuration table. It also means
the API and the worker write disjoint tables — the API never touches
`endpoint_runtime`, the worker never writes `endpoints`.

**Why each column is not on `endpoints`:**

| Column          | Why not on `endpoints`                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `next_run_at`   | written every probe; and it is the claim's ordering key, so it needs an index that must not sit on the config table          |
| `scheduled_at`  | written every probe; the slot identity NFR-3 is stated in terms of                                                           |
| `leased_until`  | written every probe and every release; a lease on the config row would make the API's `UPDATE endpoints` contend with claims |
| `leased_by`     | as above; also the fence (D13)                                                                                               |
| `last_probe_at` | written every probe; M6 reads it for the `UNKNOWN` sweep                                                                     |

**What is deliberately _not_ here yet** — and D2 is the reason for the first
two, deferral for the rest:

- `enabled`, `interval_s`. §7.5 mirrors them. D2 declines: joined from
  `endpoints` instead.
- `state`, `consecutive_failures`, `consecutive_successes`, `last_success_at`.
  These are **M6's** (`03-api-health.md` §3.7's state machine and FR-24's
  hysteresis). They are named in §7.5 and they do belong on this row — a 1:1
  hot row is exactly where a per-endpoint counter that must be incremented in
  SQL belongs — but M4 has no writer and no reader for them. Columns nothing
  reads are untested, and a `smallint NOT NULL DEFAULT 0` added by M6's own
  migration costs nothing at this size. M6 adds them with the code that
  increments them, in the same change. Recorded as a tracker follow-up so the
  deferral is visible rather than forgotten.

**Indexes.** One: `(next_run_at)`. §7.5 specifies `(next_run_at) WHERE enabled`
— not available once `enabled` is not a column here (D2). Measured consequence,
§2.4.2: the planner index-scans `(next_run_at)` in order and rejects disabled
rows in the nested loop, reading 111 entries for a 100-row batch at 10%
disabled. The `ORDER BY` is served by the index; the outer `UPDATE` uses the
primary key once the table is large enough for that to be the cheaper plan.
The claim is the only query against this table, so there is no second index.

`created_at`/`updated_at` are omitted although every other table has them: this
row is machine state with no audit question to answer, and two more columns
written on every probe is exactly the churn the table split exists to avoid.

### 3.3 Adoption — how a row gets here

`endpoint_runtime` is 1:1 with `endpoints`, so something must create the row.
Two candidates:

- **The API, inside `EndpointsService.createForService`'s transaction.** Costs
  a write in M2 code at three sites (create, and nothing else today — but
  `update` and `setEnabled` become sites the moment anything is mirrored), and
  makes two modules writers of one table.
- **The scheduler, at the top of each tick** (D1):

```sql
INSERT INTO endpoint_runtime (endpoint_id, next_run_at)
SELECT e.id, now() + make_interval(secs => random() * least(e.interval_s, $jitterMaxS))
FROM   endpoints e
WHERE  NOT EXISTS (SELECT 1 FROM endpoint_runtime r WHERE r.endpoint_id = e.id)
ON CONFLICT (endpoint_id) DO NOTHING;
```

The scheduler owns it. The table then has exactly one writer, M2's code is not
touched at all, the migration needs no separate backfill step (the first tick
adopts every pre-existing endpoint), and an endpoint created while every worker
was down is adopted when one returns. `ON CONFLICT DO NOTHING` on top of the
anti-join because two workers adopt concurrently by design; measured idempotent
in §2.4.6. Deletion needs nothing: `ON DELETE CASCADE`.

The cost is one anti-join per tick — two primary-key indexes, and it is
measured in revalidation. The price paid is that a newly created endpoint waits
up to one tick plus its jitter before its first probe, instead of being due
instantly. That is a bounded, stated delay (≤ `SCHEDULER_TICK_MS` +
`SCHEDULER_ADOPT_JITTER_MAX_S`), and the jitter is wanted anyway (D8).

### 3.4 The tick, the pool, and what happens when it is full

One loop, one tick in flight at a time:

```
tick:
  try:
    adopt()                                 -- §3.3
    capacity := PROBE_CONCURRENCY - inFlight.size
    if capacity > 0:                        -- else claim nothing (D9)
      rows := claim(min(SCHEDULER_BATCH_SIZE, capacity))
      for row in rows: start(row)           -- not awaited
  catch err:
    log.error(err)                          -- never rethrown past here
  finally:
    if not stopping: re-arm                 -- D19
```

**The re-arm is in `finally`, and that is the whole point of writing it out.**
`adopt()` and `claim()` are database calls: a PostgreSQL restart, a dropped
connection or a statement error rejects them. If the rejection escaped the
timer callback, this worker would stay alive, healthy-looking, and schedule
nothing ever again — the single worst failure this component has, because a
dead worker is noticed and a silently idle one is not. It is also AGENTS.md's
"long-running loop that can exit silently when its work throws", and it is
exactly the Uptime Kuma defect §2.3 already quotes — `safeBeat`'s catch is
what keeps its loop alive. Citing that failure and then writing a loop with no
`catch` is the mistake this line exists to prevent (D19). **Test:** an adopt
rejection and a claim rejection each leave the next tick running, and each is
logged.

`start(row)` loads the monitor **under `SCHEDULER_LOAD_BUDGET_MS`** (D20),
calls `probe()`, and on settle releases the lease and removes itself from
`inFlight`. A load that overruns its budget releases the row without probing,
so the slot is missed honestly rather than probed under a lease that has
already lapsed. The tick never awaits a probe.

**How many probes run at once:** at most `PROBE_CONCURRENCY` (default 50) per
worker process, counted as `inFlight.size`.

**When the pool is saturated and the next tick arrives:** the tick claims
**nothing** and returns. There is no queue. The work stays due in the database
with `next_run_at` in the past and no lease, so another worker claims it
(NFR-7's scaling answer) or this one does on a later tick. The backlog is
visible as data — the contrast with Gatus, where a saturated semaphore
consumes the tick and the skipped slot leaves no trace (§2.3).

**How a single hung endpoint is prevented from occupying the pool:** it
occupies exactly **one** slot, for at most its own deadline. M3 arms one
`AbortController` for `min(timeout_ms, PROBE_MAX_TIMEOUT_MS)` before the first
hop and it covers DNS, connect, TLS, every redirect and the body read; M3's
verification records the one case where that was not true (`Agent.close()`
waiting on an in-flight request) and its fix to `destroy()`. So the pool
drains, and NFR-1 holds: 49 other probes are unaffected, and the loop itself is
never blocked because the tick does not await.

**Can a tick overlap the previous tick?** No. The loop is a `setTimeout` chain
re-armed _after_ the tick's own work settles, not `setInterval` — which would
queue a second tick behind a slow claim and stack unboundedly. Re-arm delay is
`max(0, SCHEDULER_TICK_MS − elapsed)`, Uptime Kuma's compensation applied to
the tick rather than to a monitor (§2.3), so a 200 ms claim does not push the
next tick to 1200 ms. Overlap is therefore structurally impossible: one timer,
armed only when there is no tick running. Probes started by earlier ticks _do_
overlap later ticks — that is the point — and their number is bounded by
`PROBE_CONCURRENCY`, which is what `capacity` reads.

### 3.5 Lease duration, derived

The lease must outlast everything between the claim committing and the release
committing, for the worst row in the batch.

| Term                            | Worst case                                  | Why                                                                                                                          |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| claim → pool admission          | **0**                                       | capacity-gated: every claimed row starts on the same tick (D9). This is openstatus's `waves` term, and D9 is what makes it 1 |
| pool admission → deadline armed | `SCHEDULER_LOAD_BUDGET_MS` (default 1 500)  | monitor loading: endpoint + service + headers, then decryption. **Not zero** (D20)                                           |
| probe                           | `PROBE_MAX_TIMEOUT_MS` (default 30 000)     | M3 caps the endpoint's own `timeout_ms` at this, so a row saved under an older, larger cap cannot exceed it (M3 D35)         |
| teardown + release round trip   | `SCHEDULER_LEASE_SLACK_MS` (default 15 000) | dispatcher `destroy()`, one `UPDATE`, and the tick granularity around both                                                   |

**The second row is a correction, and it matters.** Capacity-gating removes the
_queue_, but claim-to-deadline-armed is not zero: `start(row)` reads the
endpoint, its service and its headers and decrypts the secret ones before
`probe()` arms anything. Those are database round trips, and a batch of up to
`PROBE_CONCURRENCY` (50) starting at once contends for a pool of
`DATABASE_POOL_MAX` (default 10), so the last row of a batch waits behind nine
others. At the _minimum permitted_ lease the only headroom is the slack, and
slow loading consumes it silently — the lease lapses with the probe still
running, which is this section's own failure case reached through a term the
table had claimed was zero.

It is bounded rather than estimated (D20): the load runs under
`SCHEDULER_LOAD_BUDGET_MS`, and a load that overruns **releases the row without
probing** and logs it. A slot is then missed — honestly, as `UNKNOWN` — instead
of a lease silently expiring under a probe. Every term in the table is now a
bound, which is what lets the inequality below be a proof rather than a hope.

So
`SCHEDULER_LEASE_MS ≥ SCHEDULER_LOAD_BUDGET_MS + PROBE_MAX_TIMEOUT_MS + SCHEDULER_LEASE_SLACK_MS`,
enforced at boot (§5). Defaults: 60 000 ≥ 1 500 + 30 000 + 15 000 = 46 500.
The two budgets are configuration rather than literals precisely because they
are the terms that are judged rather than derived.

**What happens when the two cross** — a probe outliving its lease:

1. The row's lease lapses while the probe is still running.
2. `next_run_at` is already the _next_ slot, so the row is not claimable for
   the slot in flight. It becomes claimable when that next slot arrives —
   another worker probes the endpoint while our probe is still going. Two
   probes of one endpoint concurrently, for **different** slots. NFR-3 is about
   one slot and is not violated, but it is still wrong: the two probes contend,
   and NFR-5's measurement is polluted by our own load.
3. When our probe finally settles, the fence (D13) stops it clearing the other
   worker's lease.

Prevented four ways: the boot-time inequality makes it unreachable by
configuration; the loader budget bounds the one term that was previously
assumed rather than bounded (D20); M3's cap makes it unreachable by stale
data; and a watchdog logs
a warning if a probe is still in flight at `deadline + slack`, so if it happens
anyway there is a record rather than a mystery. We do **not** renew leases
mid-probe — a heartbeat is the right answer for jobs of unbounded length, and
ours are bounded by construction.

### 3.6 The catch-up guard, as an invariant

> **Invariant.** After a claim, `next_run_at` is the earliest instant strictly
> greater than the claim's `now()` that is congruent to the endpoint's original
> phase modulo `interval_s`. Exactly one probe is dispatched per claim,
> whatever the size of the gap.

`next = slot + interval × (floor((now − slot) / interval) + 1)`.

**A monitor 40 intervals behind fires exactly one probe**, and its next
`next_run_at` becomes the next future slot on its original phase — the 40
slots in between are skipped and never probed. At interval 60 s,
`slot = 00:00:00`, `now = 00:40:00`: `misses = 40`, the claim probes the
`00:00:00` slot, and `next = 00:41:00`, so `00:01:00`…`00:40:00` are gaps.
Measured end to end in §2.4.7 (41 intervals jumped = `misses + 1`).

This is "probe once and jump to the next future slot", not "probe once and
advance one interval". Both are defensible; the consequences of the choice:

|                                          | jump to next future slot (**chosen**) | advance one interval                                                         |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Probes after a 1 h outage, interval 60 s | 1                                     | 60, one per tick, a burst                                                    |
| Drift                                    | none — phase preserved exactly        | none, but only after the burst drains                                        |
| Missed slots                             | 40 gaps, no probe, no row             | back-filled with probes whose results describe _now_, labelled as past slots |
| Load on recovery                         | flat                                  | 60× for the duration of the catch-up, across every monitor at once           |

The second column is what ADR-0002 named as the edge case we own by
hand-rolling. Back-filling is worse than a gap for a monitoring system
specifically: it manufactures data about a time nobody observed. The gaps
become `UNKNOWN` in M6 (`03-api-health.md` §3.5.2) — excluded from both
numerator and denominator, never silently `up`.

**Boundary to test** (and the reason the formula is stated with `floor` and
`+1` rather than `ceil`): at `now − slot` an exact multiple of the interval,
`ceil` would yield `next = now`, which is not strictly in the future, and the
row would be immediately due again — a one-tick busy loop at exactly the
boundary. `floor(x) + 1` yields `now + interval`. The case at the boundary and
the case one second past it are both in §2.4.5 and both become tests.

`misses ≥ 0` always, so no branch and no clamp is needed: the predicate
`next_run_at <= now()` and the arithmetic's `now()` are **the same value**
inside one statement (§2.4.4), and that is only true because the claim is a
single statement (D1). A guard against negative `misses` would be inert, so
there is none; the invariant is asserted by a test instead.

### 3.7 Release, and the fence

There are **two** terminal writes, and the difference between them is a number
M6 will publish. On settle — success, failure class, or a thrown error — the
probe ran, so `last_probe_at` advances:

```sql
UPDATE endpoint_runtime
SET    leased_until  = NULL,
       leased_by     = NULL,
       last_probe_at = now()      -- a probe happened
WHERE  endpoint_id   = $id
  AND  leased_by     = $workerId
  AND  scheduled_at  = $slot;
```

When the slot is **abandoned** — D20's loader overrun is the only path today —
no probe ran, so `last_probe_at` must **not** move:

```sql
UPDATE endpoint_runtime
SET    leased_until  = NULL,
       leased_by     = NULL      -- last_probe_at deliberately untouched
WHERE  endpoint_id   = $id
  AND  leased_by     = $workerId
  AND  scheduled_at  = $slot;
```

**Why this is two statements and not one with a flag.** §3.2 hands
`last_probe_at` to M6 as the input to its `UNKNOWN` sweep. Advancing it for a
slot that produced no probe makes an abandoned slot look freshly probed, so the
sweep skips it and the gap is never recorded as `UNKNOWN` — it silently becomes
nothing at all. That is AGENTS.md's first measurement rule, a missing probe
treated as healthy, reached through a release path rather than through
arithmetic. The abandon path is the release minus one assignment, and writing
it out is cheaper than a boolean nobody can see at the call site. **Test:** a
loader overrun leaves `last_probe_at` unchanged while clearing the lease.

**Release is mandatory, not an optimisation.** `PROBE_ALLOWED_INTERVALS_S`
starts at 30 s and `SCHEDULER_LEASE_MS` defaults to 60 000. Without a release,
a 30-second monitor's next slot falls inside its own previous lease, and the
predicate `leased_until < now()` excludes it: the monitor would be probed every
60 s instead of every 30 s — a 100% drift, against NFR-2's 10%, produced by the
lease that exists to protect NFR-3. **Test:** a 30 s monitor is claimed twice in
~60 s, and that test fails if the release is removed.

**The fence.** `leased_by = $workerId AND scheduled_at = $slot` is what stops a
worker whose lease already lapsed from clearing a lease a _different_ worker has
since taken — the openstatus defect in §2.3, and Kleppmann's fencing-token
argument against lease-based locking. Both conjuncts are needed: `leased_by`
alone fails when the same worker re-claims the same endpoint for a later slot
and a straggler from the earlier slot then releases it. Measured in §2.4.6;
proved by removal in the test matrix.

A release that matches zero rows is **not** an error — it means the lease was
lost — but it is logged at `warn` with the endpoint and slot, because it should
not happen and AGENTS.md forbids swallowing it silently.

### 3.8 Clock

**The database clock is the only authority** for `next_run_at`, `leased_until`,
`scheduled_at`, `last_probe_at` and every comparison between them. No JS `Date`
is ever bound as a parameter for these columns; every one is computed by `now()`
inside the statement that writes it. With N workers on N hosts, a worker clock
running fast would otherwise grant itself a lease that looks expired to its
peers — the classic duplicate-execution-under-skew failure, and the reason
Kleppmann's critique of clock-based leases applies to a fleet at all.

The worker clock is used for exactly two things, neither of them a scheduling
decision:

- the tick's own `setTimeout` delay — cadence, not correctness; skew changes
  how often we ask the database, not what it answers;
- M3's `Clock` for probe timings, where `monotonic()` is already the only
  source of every `*_ms` and `wallClock()` the only source of `startedAt`.

Enforced, not merely stated: a unit test compiles the claim and release queries
and asserts no parameter of a date/timestamp type is bound for those columns,
so a later "just pass `new Date()`" cannot pass review by being invisible.

### 3.9 Shutdown

`untilShutdown()` already resolves on SIGTERM/SIGINT. The scheduler's stop must
leave the database in a state a peer reads correctly, without either losing the
bounded reclaim or manufacturing a duplicate.

| At SIGTERM                                  | Action                                      | Why                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tick timer                              | cleared; no further claim or adopt          | claiming during shutdown creates work nobody will run                                                                                                                   |
| A tick mid-statement                        | awaited                                     | it is one statement; abandoning it leaves rows leased with nothing running                                                                                              |
| A probe that settles within the grace       | normal release (§3.7)                       | the row is available immediately — a graceful stop does not look like a crash                                                                                           |
| A probe **still in flight** at grace expiry | **lease left in place**, logged             | openstatus's rule (§2.3): the probe can still complete after we stop watching. Releasing it invites a peer to start a second probe of the same endpoint while ours runs |
| Anything else this worker holds             | released with `WHERE leased_by = $workerId` | the same fence                                                                                                                                                          |

Grace is `SCHEDULER_SHUTDOWN_GRACE_MS`, bounded by the same arithmetic as the
lease (§5): long enough for a worst-case probe to finish, short enough that it
is always less than the lease, so shutdown can never outlive the lease it is
trying to release. A stop is therefore bounded by
`SCHEDULER_SHUTDOWN_GRACE_MS`, and any row it could not release is reclaimable
at lease expiry — NFR-4's bound, unchanged.

`app.close()` runs after, which destroys the Kysely pool (`DbService`), so the
release writes must have completed first. The scheduler's stop is awaited
inside `main.ts` before `app.close()`.

That ordering is also why the in-flight rule is "keep the lease" rather than
"release it late": once the grace has expired the scheduler stops accepting
releases, so a probe that settles a moment afterwards has no live pool to
write through. Attempting the write anyway would race `app.close()` and
surface as a rejection from a destroyed pool during shutdown — a swallowed
failure at best. The lease lapsing is the designed path, and it is bounded.

### 3.10 What NFR-2 actually bounds, and where it is enforced

Drift has two parts, and only one of them is the famous one.

1. **Accumulating drift** — eliminated by construction: `next_run_at` is
   derived from the slot, never from `now()` or from completion (§3.1, §3.6).
   A probe taking 25 s of a 30 s interval shifts nothing.
2. **Per-slot drift** — the gap between the slot and the moment the request
   actually leaves, which is **two** terms, not one:

   - `SCHEDULER_TICK_MS`, because a row becomes due up to one tick before the
     next claim looks; and
   - `SCHEDULER_LOAD_BUDGET_MS`, because D20 permits that much between the
     claim and `probe()` arming its deadline.

   NFR-2's budget is 10% of T, and the smallest T is
   `min(PROBE_ALLOWED_INTERVALS_S)` — 30 s by default, so 3000 ms. **Both**
   terms are inside it: 1000 + 1500 = 2500 ms, checked at boot (§5). Counting
   only the tick would have left 1000 + 5000 = 6000 ms passing a 3000 ms
   budget — the loader budget introduced for the lease silently spending the
   drift budget too. It is why `SCHEDULER_LOAD_BUDGET_MS` defaults to 1500
   rather than the 5000 the lease alone would have tolerated.

   NFR-2 is therefore a configuration invariant rather than a hope — and the
   drift **test measures actual probe start times**, not the scheduled slots,
   since slots are computed by the arithmetic under test and would agree with
   themselves however late the probe actually left.

Neither part covers a worker saturated past `PROBE_CONCURRENCY` — that is a
load condition, it is visible as an overdue row, and quantifying it is the
M10 load test's job, not a claim made here.

### 3.11 What "reclaim" costs, derived — and why it is not just the lease

A worker is killed at slot `T`. Its row has `next_run_at = T + interval` (D5
advanced it at claim time) and `leased_until = T + lease`. The claim needs
**both** predicates, so the row returns to circulation at

```
reclaim_at = max(T + interval_s × 1000, T + SCHEDULER_LEASE_MS) + up to one tick
```

**The lease is not always the binding term.** It binds only when
`interval_s × 1000 ≤ SCHEDULER_LEASE_MS`:

| Monitor | `interval` | `lease` | Binding term | Time to reclaim |
| ------- | ---------- | ------- | ------------ | --------------- |
| 30 s    | 30 000     | 60 000  | **lease**    | ~60 s + tick    |
| 60 s    | 60 000     | 60 000  | either       | ~60 s + tick    |
| 300 s   | 300 000    | 60 000  | **interval** | ~300 s + tick   |
| 3600 s  | 3 600 000  | 60 000  | **interval** | ~1 h + tick     |

At the default lease, every interval in `PROBE_ALLOWED_INTERVALS_S` except 30
and 60 is governed by the interval, not the lease. **NFR-4 still holds** — the
interval is a bound, and a bounded time is what the requirement asks for — but
the honest statement of the bound is the `max`, not the lease.

This corrects an earlier draft of D6, which claimed
`SCHEDULER_LEASE_MS + SCHEDULER_TICK_MS` unconditionally. The consequence was
not academic: §9's containers demonstration would naturally have used a short
interval to keep the run quick, measured `lease + tick`, and published it as
the general bound — a number that is right for the case tested and wrong for
four of the five intervals the system actually allows. Measuring the easy
regime and reporting it as the general one is the same defect shape as a test
that passes for the wrong reason.

So the exit test and §8's reclaim rows both run **two** monitors: one below the
lease (30 s) and one above it (300 s), asserting the `max` in each regime and
that the _other_ term is not what governed.

A note for M6, not a change here: the `UNKNOWN` span after a crash is
`reclaim_at − T`, so it is the interval that sets it for most monitors. That is
the correct behaviour — the endpoint genuinely has no observation for that
span — and it is why §3.5.2's `UNKNOWN` matters more than the lease tuning.

**How `docs/m4-verification.md` must word this.** NFR-4 reads _"its claimed
work becomes available to another worker within a bounded time rather than
being lost."_ Under D5 the **slot** is lost and the **endpoint** returns. The
verification record says exactly that, in those words, and offers the
`UNKNOWN` span as the evidence the slot is _accounted for_ rather than
silently dropped — `03-api-health.md` §3.5.2 already makes `UNKNOWN` a
first-class state excluded from uptime arithmetic. The evaluation chapter is
read against the requirement's literal text, so the gap between "the slot" and
"the endpoint" is stated by us rather than found by an examiner.

---

## 4. Decisions

| #   | Decision                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The claim is **one statement** in autocommit, never `SELECT` then `UPDATE` with think-time                                                                     | one `now()` governs due-check, lease check, lease grant and catch-up arithmetic (§2.4.4); the row lock is held for the statement only, with `leased_until` as the real exclusion afterwards                                                                                                                                                                                                  |
| D2  | `endpoint_runtime` does **not** mirror `enabled`/`interval_s`; the claim joins `endpoints`                                                                     | deviates from §7.5. A mirror needs a second writer and has no enforcement; a stale copy is a paused monitor that keeps being probed (FR-9 broken, silently) or an interval change that never lands. The join is measured at 0.594 ms/50k (§2.4.2). Cost: the §7.5 partial index `WHERE enabled` is not available; consequence measured, not assumed. **Docs follow-up for the orchestrator** |
| D3  | The **database clock** is authoritative for every scheduling value; no `Date` is ever bound for one                                                            | §3.8; enforced by a compiled-query test                                                                                                                                                                                                                                                                                                                                                      |
| D4  | Catch-up is `floor((now − slot)/interval) + 1` intervals from the slot — one expression, no branch                                                             | §3.6; the on-time case is the degenerate case, so there is no second code path to get wrong                                                                                                                                                                                                                                                                                                  |
| D5  | **At-most-once per slot.** `next_run_at` advances at claim time (§7.2 step 2)                                                                                  | NFR-3 in its own words. A crash loses that slot, which becomes `UNKNOWN` (§3.5.2), rather than producing a duplicate probe                                                                                                                                                                                                                                                                   |
| D6  | The reclaim bound is **`max(interval_s × 1000, SCHEDULER_LEASE_MS) + SCHEDULER_TICK_MS`** — the lease binds only when `interval_s × 1000 ≤ SCHEDULER_LEASE_MS` | the claim needs `next_run_at <= now()` **and** a lapsed lease, and D5 already advanced `next_run_at` to the next slot, so whichever is later governs. §3.11 derives it. The exit test must demonstrate **both** regimes, or it measures the easy one and reports it as the general bound                                                                                                     |
| D7  | The claim excludes a row whose probe is still in flight (`leased_until`)                                                                                       | Uptime Kuma's 1 ms re-arm (§2.3) is what its absence looks like: an endpoint slower than its interval probed continuously                                                                                                                                                                                                                                                                    |
| D8  | First `next_run_at` is jittered: `now() + random() × least(interval_s, SCHEDULER_ADOPT_JITTER_MAX_S)`                                                          | monitors created together would otherwise share a phase forever and arrive in one tick. Written once to the database, so it survives restarts — unlike Gatus's boot-order stagger (§2.3). Measured flat, §2.4.6                                                                                                                                                                              |
| D9  | **Capacity-gated claiming**: never claim more than `PROBE_CONCURRENCY − inFlight`; at zero capacity claim nothing                                              | makes the pool's queue empty by construction, which removes the `waves` term from the lease arithmetic (§3.5), bounds per-slot drift, and leaves an unclaimed slot visible in the database instead of silently skipped (§2.3, Gatus)                                                                                                                                                         |
| D10 | Every probe releases its lease on settle, including on a thrown error                                                                                          | a rejected probe that kept its lease would freeze the monitor for the lease duration                                                                                                                                                                                                                                                                                                         |
| D11 | `SCHEDULER_LEASE_MS ≥ SCHEDULER_LOAD_BUDGET_MS + PROBE_MAX_TIMEOUT_MS + SCHEDULER_LEASE_SLACK_MS`, checked at boot                                             | ADR-0002's second named edge case, made unreachable by configuration rather than watched for. The loader term is not optional — without it the inequality is satisfiable by a configuration in which loading alone exhausts the slack (D20, §3.5)                                                                                                                                            |
| D12 | On SIGTERM, a probe still in flight at grace expiry **keeps its lease**                                                                                        | openstatus's rule (§2.3): releasing it invites a peer to start a second probe while ours is still running                                                                                                                                                                                                                                                                                    |
| D13 | Release is fenced on `leased_by = $workerId AND scheduled_at = $slot`                                                                                          | the openstatus defect in §2.3; both conjuncts needed (§3.7)                                                                                                                                                                                                                                                                                                                                  |
| D14 | `SCHEDULER_TICK_MS` gains a maximum                                                                                                                            | above 2³¹−1 ms `setTimeout` fires at 1 ms on the pinned runtime (§2.4.1), turning the tick into a hot loop                                                                                                                                                                                                                                                                                   |
| D15 | The `SKIP LOCKED` removal proof asserts **promptness**, not disjointness                                                                                       | measured: removal blocks, it does not duplicate (§2.4.3). A disjointness test would pass with the clause removed — the M3 "passes for the wrong reason" shape                                                                                                                                                                                                                                |
| D16 | The scheduler owns adoption; M2's code is not touched                                                                                                          | one writer for `endpoint_runtime` (§3.3)                                                                                                                                                                                                                                                                                                                                                     |
| D17 | M6's `state`/counter columns are **not** created now                                                                                                           | no writer, no reader, no test; M6 adds them with the code that increments them (§3.2). Tracker follow-up                                                                                                                                                                                                                                                                                     |
| D19 | The tick re-arms in a `finally`, and its body's failures are caught and logged, never rethrown past the callback                                               | a rejected `adopt()`/`claim()` — a PostgreSQL restart is enough — would otherwise leave the process alive and permanently scheduling nothing. AGENTS.md's silently-exiting loop, and the Uptime Kuma defect §2.3 already quotes. Codex #4057684678                                                                                                                                           |
| D20 | Monitor loading is **bounded** by `SCHEDULER_LOAD_BUDGET_MS` and is a named term in the lease arithmetic; an overrun releases the row without probing          | claim→deadline-armed is not zero: it is database round trips for endpoint, service and headers plus decryption, contending for `DATABASE_POOL_MAX` (10) across a batch of up to `PROBE_CONCURRENCY` (50). §3.5 had claimed zero. Codex #4057684684                                                                                                                                           |
| D21 | Compose's `stop_grace_period` and `SCHEDULER_SHUTDOWN_GRACE_MS` are a pair and move together; the worker gets `stop_grace_period: 40s`                         | at compose's 10 s default, D12's keep-the-lease path never runs outside its own test. §10.4                                                                                                                                                                                                                                                                                                  |
| D18 | M4 logs the `ProbeOutcome` and discards it                                                                                                                     | M5 owns persistence; the exit test needs real probes in flight regardless                                                                                                                                                                                                                                                                                                                    |

---

## 5. Config

All five scheduler keys already exist in `src/core/config/schema.ts` and are
read by nothing. M4 is their first reader, so each gains a rejection test in
the same commit (AGENTS.md).

| Key                            | Today                                     | Change                                                  | Why                                                                                   |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `WORKER_ID`                    | `min(1)`, defaults `${hostname()}-${pid}` | none                                                    | already correct; its comment already explains why PID alone is not enough             |
| `SCHEDULER_TICK_MS`            | `int().min(100)`                          | **add `.max(60_000)`**                                  | D14                                                                                   |
| `SCHEDULER_BATCH_SIZE`         | `int().min(1)`                            | **add `.max(10_000)`**                                  | a batch larger than any plausible pool is a claim that leases rows nothing will start |
| `SCHEDULER_LEASE_MS`           | `int().min(1000)`                         | none, but see the refine below                          |                                                                                       |
| `PROBE_CONCURRENCY`            | `int().min(1)`                            | **add `.max(10_000)`**                                  | it is the pool size; unbounded means unbounded sockets                                |
| `SCHEDULER_LEASE_SLACK_MS`     | —                                         | **new**, `int().min(1000).max(300_000).default(15_000)` | the one judged term in §3.5's arithmetic                                              |
| `SCHEDULER_SHUTDOWN_GRACE_MS`  | —                                         | **new**, `int().min(0).max(300_000).default(35_000)`    | §3.9                                                                                  |
| `SCHEDULER_LOAD_BUDGET_MS`     | —                                         | **new**, `int().min(500).max(60_000).default(1_500)`    | D20; the loader's bound, a named term in §3.5's lease **and** in §3.10's drift budget |
| `SCHEDULER_ADOPT_JITTER_MAX_S` | —                                         | **new**, `int().min(0).max(3600).default(60)`           | D8; `0` disables jitter, which the herd test uses                                     |

Three cross-field rules, each turning a requirement into a boot-time check:

```
SCHEDULER_LEASE_MS >= SCHEDULER_LOAD_BUDGET_MS
                      + PROBE_MAX_TIMEOUT_MS
                      + SCHEDULER_LEASE_SLACK_MS
  -- or a slow probe's own lease expires mid-flight and a second worker
  -- probes the same endpoint concurrently (ADR-0002; §3.5). The loader term
  -- is not optional: without it the inequality is satisfiable by a
  -- configuration in which loading alone exhausts the slack (D20)

SCHEDULER_SHUTDOWN_GRACE_MS < SCHEDULER_LEASE_MS
  -- or a graceful stop can outlive the lease it is trying to release,
  -- and a peer starts a second probe while ours is still draining (§3.9)

SCHEDULER_TICK_MS + SCHEDULER_LOAD_BUDGET_MS
    <= min(PROBE_ALLOWED_INTERVALS_S) * 1000 / 10
  -- NFR-2's 10% drift budget at the shortest permitted interval (§3.10).
  -- Both terms, because a probe starts late by the tick it waited to be
  -- claimed *plus* the time it then spent loading (D20)
```

Defaults satisfy all three: 60 000 ≥ 1 500 + 30 000 + 15 000 = 46 500;
35 000 < 60 000; 1000 + 1500 = 2500 ≤ 3000.

**The configuration that already exists passes all three.** AGENTS.md asks for
a story for data that predates a new rule, and a boot-time refine rejects a
running deployment as surely as a schema constraint rejects a row.
`.env.example` already pins four of these keys — `SCHEDULER_TICK_MS=1000`,
`SCHEDULER_BATCH_SIZE=100`, `SCHEDULER_LEASE_MS=60000`, `PROBE_CONCURRENCY=50`
— and every one is inside the new bounds and satisfies every new refine
(notably `60000 ≥ 1500 + 30000 + 15000`), with the new keys falling to their
defaults. `docker-compose.yml` sets none of them.
So nothing that exists today stops booting, and there is no compatibility path
to write. `.env.example` gains the four new keys with a comment each, in the
same commit as the schema change.

**`WORKER_ID` in containers.** The compose `worker` service does not set it, so
it falls to `${hostname()}-${pid}`. Under
`docker compose up --scale worker=3` — the line already in the compose file as
NFR-7's demonstration — each container gets a distinct hostname, so the three
workers get distinct ids without configuration. That is NFR-7's "no change to
configuration of existing components" holding literally, and it is what makes
`leased_by` readable in the exit test's `psql` output.

---

## 6. Module layout

`worker/scheduler/`, a feature module with role folders (CLAUDE.md level 2).
`core` gains only the table type.

```
src/core/db/
  migrations/0007_endpoint_runtime.up.sql
  migrations/0007_endpoint_runtime.down.sql
  types.ts                                   EndpointRuntimeTable + Database entry

src/worker/scheduler/
  scheduler.module.ts
  scheduler.service.ts                       the tick loop, capacity, start/stop
  scheduler.service.test.ts
  repositories/
    endpoint-runtime.repository.ts           adopt, claim, release
    endpoint-runtime.repository.test.ts      compiled-SQL assertions (D3)
    endpoint-runtime.repository.int.test.ts  the claim, against real Postgres
  services/
    probe-pool.service.ts                    bounded in-flight set, drain
    probe-pool.service.test.ts
    monitor-loader.service.ts                row -> EndpointProbeConfig
    monitor-loader.service.test.ts
  e2e/
    scheduler.int.test.ts                    two workers, races, reclaim, shutdown
```

`monitor-loader.service.ts` reuses `effectiveUrl`, `mergeHeaderRows` and
`decryptHeaderValue` from `src/core/registration/` — all three are already in
`core`, so there is no second implementation of header merging or URL joining
in the worker (AGENTS.md: a fix that duplicates instead of sharing).

`src/architecture.test.ts` keeps holding: `worker` → `core` only.

Coverage: `*.repository.ts` is already excluded (database behaviour, covered by
the integration suite). `scheduler.service.ts` is a timer loop over I/O — it
gets real unit tests with an injected clock and a fake repository for the
capacity and re-arm logic, and is **not** added to the exclusion list.

---

## 7. Security properties, and how each is proved

Nothing here is user-facing, so the properties are integrity ones. Each is
proved by removing the guard and watching the named test fail — on the final
code, recorded in the commit message.

| Property                                                  | Guard                                                                          | Proved by                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two workers never probe one endpoint for one slot (NFR-3) | the row lock + `leased_until` predicate                                        | barrier test: A's claim committed on a second connection, B's batch disjoint                                                                                                  |
| A claim never blocks another worker (NFR-3, NFR-1, NFR-7) | `SKIP LOCKED`                                                                  | promptness test: B returns while A holds. Removal → B blocks for A's whole hold (§2.4.3, measured 2 ms → 11 984 ms)                                                           |
| A probe in flight is not claimed again (D7)               | `leased_until IS NULL OR < now()`                                              | barrier test with a lease held; removal → the second worker claims it                                                                                                         |
| A dead worker's row returns in bounded time (NFR-4)       | `max(next_run_at, lease expiry)` — §3.11                                       | reclaim tests in **both** regimes: one monitor below the lease, one above. Each asserts not-before and within-one-tick-after, and that the _other_ term was not what governed |
| A zombie cannot clear a live lease (fencing)              | `leased_by = $workerId AND scheduled_at = $slot`                               | removal → the straggler's release clears the new owner's lease and the endpoint is claimed twice                                                                              |
| Drift does not accumulate (NFR-2)                         | `next_run_at` from the slot                                                    | 10 consecutive claims of one monitor land on exact multiples of the interval from the first slot, with an artificial delay injected in each probe                             |
| A long outage does not burst (ADR-0002)                   | the catch-up expression                                                        | a monitor 40 intervals behind is claimed **once**; `next_run_at` is the next future slot                                                                                      |
| A hung endpoint does not hold the pool (NFR-1)            | M3's deadline + `inFlight` accounting                                          | one endpoint hangs; the other 49 slots still turn over                                                                                                                        |
| A paused monitor is not probed (FR-9)                     | `e.enabled` in the claim                                                       | removal → a disabled endpoint is claimed                                                                                                                                      |
| No worker-clock value reaches a scheduling column (D3)    | queries compute `now()` in SQL                                                 | compiled-query test asserting no timestamp parameter is bound                                                                                                                 |
| Secret headers never reach a log                          | M3's contract — `probe()` receives decrypted values and holds no "secret" flag | the loader is tested to pass values through and the scheduler logs only ids, classes and timings                                                                              |

---

## 8. Test matrix

**Unit** (`npm test`, no I/O):

| Test                                  | Asserts                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduler.service.test.ts`           | re-arm delay is `max(0, tick − elapsed)`; a slow tick does not stack; capacity = `PROBE_CONCURRENCY − inFlight`; zero capacity claims nothing; stop clears the timer                  |
| `probe-pool.service.test.ts`          | never exceeds the cap; a rejected probe leaves the set; drain resolves when the last settles; drain honours its grace and reports what was still in flight                            |
| `monitor-loader.service.test.ts`      | endpoint + service + headers → `EndpointProbeConfig`; service headers merged under endpoint headers; secret headers decrypted; `timeout_ms` passed as stored (M3 applies its own cap) |
| `endpoint-runtime.repository.test.ts` | compiled SQL for claim/release/adopt: `now()` present, no bound timestamp parameter (D3); the fence conjuncts present                                                                 |
| `schema.test.ts` additions            | each new bound rejects a bad value; each of the three cross-field rules rejects a violating pair                                                                                      |

**Integration** (`npm run test:int`, real Postgres — the claim is not
meaningfully testable otherwise):

| Test                                                                 | Asserts                                                                                                                                                                  | Guard it proves by removal                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| claim: disjoint **while A still holds**                              | A's claim is issued in an open, **uncommitted** transaction and observably holding its row locks (polled via `pg_stat_activity`); B's claim then runs and shares nothing | the **row lock** — the concurrent-claim window, which a committed-first ordering never enters |
| claim: disjoint after A commits                                      | A's claim committed first; B's batch shares nothing                                                                                                                      | the `leased_until` predicate alone                                                            |
| claim: prompt under a barrier                                        | B returns inside a bound while A holds an open transaction                                                                                                               | **`SKIP LOCKED`** (D15)                                                                       |
| claim: respects `enabled`                                            | a disabled endpoint is never returned                                                                                                                                    | `e.enabled`                                                                                   |
| claim: ordering and batch bound                                      | oldest slots first; never more than `LIMIT`                                                                                                                              | —                                                                                             |
| lease: in-flight row excluded                                        | a leased row is not re-claimed before expiry                                                                                                                             | `leased_until` predicate                                                                      |
| lease: reclaim, **interval below the lease** (30 s at a 60 s lease)  | claimable within one tick of **lease** expiry, **not** before; asserts the interval was not what governed                                                                | both bounds of NFR-4                                                                          |
| lease: reclaim, **interval above the lease** (300 s at a 60 s lease) | the lapsed lease does **not** make it claimable; it returns at `next_run_at`, per §3.11's `max`                                                                          | D6's corrected bound                                                                          |
| lease: release un-blocks the next slot                               | a 30 s monitor is claimed twice within ~60 s at a 60 s lease                                                                                                             | the release (§3.7)                                                                            |
| fence: straggler release                                             | a stale `(workerId, slot)` release matches 0 rows and the live lease survives                                                                                            | the fence conjuncts                                                                           |
| catch-up: 40 intervals behind                                        | one claim, `next_run_at` = next future slot, phase preserved                                                                                                             | the catch-up expression                                                                       |
| catch-up: exact-multiple boundary                                    | `now − slot` an exact multiple → `next = now + interval`, strictly future                                                                                                | `floor(…)+1` vs `ceil`                                                                        |
| drift: 10 cycles with injected delay                                 | every **actual probe start** within the NFR-2 budget of a slot that is an exact multiple of the interval from the first                                                  | slot-derived `next_run_at`                                                                    |
| loader: overrun releases without probing                             | a load held past `SCHEDULER_LOAD_BUDGET_MS` releases the row, never calls `probe()`, and logs                                                                            | D20's budget                                                                                  |
| tick: survives an `adopt()` rejection                                | the error is logged and the **next tick still runs**                                                                                                                     | D19's `finally`                                                                               |
| tick: survives a `claim()` rejection                                 | as above                                                                                                                                                                 | D19's `finally`                                                                               |
| adopt: idempotent and concurrent                                     | two adopters, one row per endpoint                                                                                                                                       | `ON CONFLICT DO NOTHING`                                                                      |
| adopt: jitter spreads                                                | with jitter on, slots spread across the window; with `0`, they do not                                                                                                    | D8                                                                                            |
| e2e: two schedulers, one database                                    | over N ticks no `(endpoint, slot)` is probed twice                                                                                                                       | the whole claim                                                                               |
| e2e: a killed scheduler's work is picked up                          | stop one mid-probe without releasing; the other claims within the D6 bound                                                                                               | lease expiry                                                                                  |
| e2e: graceful shutdown                                               | settled probes released; an in-flight probe keeps its lease; stop returns inside the grace                                                                               | D12                                                                                           |
| e2e: hung endpoint                                                   | one endpoint hangs for its whole timeout; others keep turning over                                                                                                       | NFR-1                                                                                         |

Every race uses an explicit barrier — a competing statement committed on a
second connection, or `pg_stat_activity` polled for `wait_event_type = 'Lock'`
on another backend. Never `Promise.all`, never a sleep. AGENTS.md's note about
row locks blocking on `transactionid` rather than on the relation applies
directly here and cost M3 606 seconds; the barrier helper polls
`pg_stat_activity`, which is what §2.4.3's measurement already used.

---

## 9. Delivery — 3 PRs

| PR                                  | Content                                                                                                                                                                                                                                                                                                                            | Commits                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **1. Plan**                         | this document                                                                                                                                                                                                                                                                                                                      | 1                                                                                                         |
| **2. Schema, config and the claim** | migration `0007` + `.down.sql` + `types.ts`; the config bounds, four new keys, three cross-field rules and their rejection tests, plus those keys in `.env.example`; `EndpointRuntimeRepository` (adopt, claim, release) and its unit + integration tests, including every guard-removal proof in §7 that is a property of the SQL | migration + types; config + `.env.example` + tests; repository + unit tests; repository integration tests |
| **3. The loop**                     | `SchedulerService`, `ProbePoolService`, `MonitorLoaderService`, `SchedulerModule`, wiring into `worker.module.ts` and `main.ts`; the e2e integration suite; `docs/m4-verification.md`                                                                                                                                              | pool + tests; loader + tests; service + tests; wiring; e2e suite; verification record                     |

PR 2 is coherent alone: it ships a table, its types, its configuration and a
tested claim query. PR 3 is the only thing that makes any of it run, and
splitting the loop from the pool would produce two PRs that only make sense
together — the shape CLAUDE.md's cost-discipline rule sends back.

No HTTP surface, so no `http/` file and no `openapi.yaml` change. No new CLI
script, so no `:dist` twin. Both stated so the absence is a checked conclusion
rather than an oversight.

**Revalidation** is the full treatment, not the pure-logic shortcut: a
migration, a database change, and a multi-process behaviour claim. Fresh clone
(`npm ci`, `npm run build`, `npm run verify`, `npm run test:int`), a real
`docker compose up -d --build` with `psql` checks, every guard re-proved by
removal on the final code, and the exit test run **in containers** — two worker
processes, monitors due, `docker kill` one mid-probe, then `psql` evidence that
no `(endpoint, slot)` was probed twice and the measured time to reclaim against
the D6 bound — **in both regimes**, with one monitor whose interval is below
the lease and one above it (§3.11), so the demonstration reports the `max` and
not only the case that happens to be quick to run.

---

## 10. Open questions — flagged, not resolved quietly

1. **D2 deviates from `07-architecture.md` §7.5**, which mirrors `enabled` and
   `interval_s` onto `endpoint_runtime` and specifies the partial index
   `(next_run_at) WHERE enabled`. The join is measured at 0.594 ms/50k
   endpoints (§2.4.2), so the performance argument for the mirror does not bite
   at any scale this thesis reaches — but the docs repo should be corrected
   rather than left disagreeing with the code. **Docs follow-up for the
   orchestrator**, not something this milestone edits.

2. **D17 defers M6's columns** (`state`, `consecutive_failures`,
   `consecutive_successes`, `last_success_at`), which §7.5 shows on this table.
   They belong here; they have no writer in M4. Tracker follow-up so M6 adds
   them rather than discovering the table.

3. **D5's at-most-once reading** makes a crash cost one slot, recorded as
   `UNKNOWN`. The alternative — advance `next_run_at` on _release_ instead of on
   claim, making the slot retried after lease expiry — gives at-least-once and a
   literal "the other worker picks up that slot". It was rejected because NFR-3
   is written per-slot and `07-architecture.md` §7.2 orders the write before the
   probe explicitly. Worth Levon's eye because it is the one decision that
   changes what the milestone's exit test demonstrates (D6).

4. ~~**`SCHEDULER_SHUTDOWN_GRACE_MS`'s default of 35 s** vs compose's 10 s
   default stop timeout.~~ **Resolved — set it, in PR 3.** Without
   `stop_grace_period`, compose SIGKILLs at 10 s, so D12's keep-the-lease path
   would never run outside its own e2e test — dead code exercised only by the
   test that asserts it, which is the "passes for the wrong reason" shape this
   plan exists to avoid. The compose `worker` service gets
   `stop_grace_period: 40s`, above the 35 s grace. **The compose value and
   `SCHEDULER_SHUTDOWN_GRACE_MS` are a pair**: raising the grace without
   raising `stop_grace_period` silently converts every graceful stop into a
   SIGKILL, so both move together or neither does (D21).

---

## Sources

- `probeboard-docs/en/02-requirements.md` — FR-9, FR-17, NFR-1…5, NFR-7
- `probeboard-docs/en/03-api-health.md` §3.5.2, §3.7
- `probeboard-docs/en/04-prior-art.md` §4.2, §4.6
- `probeboard-docs/en/07-architecture.md` §7.1, §7.2, §7.3, §7.5, §7.9, §7.10
- `probeboard-docs/en/08-plan.md` row M4, §2.3 acceptance criteria
- `probeboard-docs/en/adr/ADR-0001`, `ADR-0002`
- `docs/m3-plan.md` D35, D37; `docs/m3-verification.md` defects 1, 4, 6
- `references/uptime-kuma/server/model/monitor.js` (MIT) — lines 3, 439, 1082, 1106
- `references/gatus/watchdog/{watchdog,endpoint}.go` (Apache-2.0)
- `references/openstatus/apps/workflows/src/checker/outbox.ts`,
  `src/cron/scheduler.ts` (AGPL-3.0 — **read only**, design cited, no code copied)
- Quartz misfire instructions; Kubernetes CronJob `startingDeadlineSeconds` and
  its 100-missed-schedules rule
- Kleppmann, "How to do distributed locking" — fencing tokens, clock-based leases
- PostgreSQL 17 docs: `FOR UPDATE … SKIP LOCKED`, EvalPlanQual, `now()` vs
  `clock_timestamp()`, `make_interval`
- Measurements in §2.4 run on PostgreSQL 17.11 (`postgres:17-alpine`) and
  Node 22.23.2 (`node:22-alpine`), the versions this repository pins
