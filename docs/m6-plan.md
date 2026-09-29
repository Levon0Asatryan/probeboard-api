# M6 — Incidents: implementation plan

Turns the stream of stored probe results into incidents: a state machine with
hysteresis, an honest `opened_at`, the `UNKNOWN` sweep and maintenance
windows. M5 stores and folds results; M7 delivers notifications; M8 serves
statistics.

Requirements: **FR-24…FR-27**, stories **D-1…D-7** (PRD §6.7), `03-api-health.md`
§3.5.2, §3.7, §3.8, `07-architecture.md` §7.1 (tick table), §7.6, §7.7.
ADR-0008 (transactional outbox).

Milestone exit test (`08-plan.md` row M6): _an endpoint goes down, an incident
opens after three failures timed from the first, and closes after two
successes._

---

## 1. Scope

**In**

- The evaluator: a worker loop on a 10 s tick that consumes `probe_results`
  behind the same `xid8` horizon as the rollup, runs the state machine, opens
  and closes incidents, and writes one outbox row per transition — all in one
  transaction with its watermark.
- `endpoint_health`: per-endpoint state and counters, in the database.
- `incidents`, with the evidence of the first failed probe **copied** in.
- `notification_outbox`, minimal: one row per open and per close. M7 drains it.
- The `UNKNOWN` sweep.
- `degraded`, written at result time against the endpoint's
  `latency_warn_ms`, which fills `count_degraded` and `degraded_seconds`
  through the existing fold.
- Maintenance windows: table, write-time flag on each result, the evaluator's
  suppression, `count_maintenance`, and an HTTP surface to declare them.
- Incident history over HTTP (D-5, FR-27) and the current state on
  `GET /v1/endpoints/:id`.
- M5's four named leftovers (§3.12) and M3-14 (§3.9).

**Out**

- Delivery, grouping (E-3), re-notification (E-4), payload rendering,
  verified addresses — M7. M6 only enqueues.
- Service-level rollup of state (C-1), the list's current status (FR-10),
  uptime and statistics routes — M8.
- Recurring maintenance windows (cron-like). One-off windows only; a recurring
  schedule is a UI convenience over the same table, and every recurring
  implementation surveyed (§2.3) is where the timezone bugs live.
- Deleting raw `probe_results` rows of a deleted endpoint: they age out within
  `RETENTION_RAW_DAYS` (default 7) and no read path can reach them (§3.12).

---

## 2. Investigation

### 2.1 Requirements and architecture read together — contradictions found

| #   | Where                                                                                         | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Resolution                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 07 §7.5 / M4 D17: `state`, `consecutive_*` on `endpoint_runtime`                              | That row is the scheduler's hot row. The claim locks it `FOR UPDATE … SKIP LOCKED`, so every row the evaluator holds is **skipped** by a concurrent claim — a due probe delayed by a tick for no reason — and the row stops being narrow, which 07 §7.3 gives as the reason it exists.                                                                                                                                                                          | D1: a separate `endpoint_health` table, written only by the evaluator.                                                                                        |
| C2  | 07 §7.5: `consecutive_failures`/`consecutive_successes smallint`                              | `consecutive_successes` grows on every healthy probe. At 30 s it passes 32,767 after **11.4 days** of uptime; the next write raises `22003` and poisons every evaluator pass.                                                                                                                                                                                                                                                                                   | D19: `integer` (2,000 years at 30 s).                                                                                                                         |
| C3  | 07 §7.6 pseudo-code                                                                           | Three defects as written: **(a)** no rule returns `PENDING` to `UP` on a success, so `F, S, S…` stays `PENDING` for ever; **(b)** a slow success while an incident is open moves `DOWN → DEGRADED`, after which `state DOWN and successes ≥ M` never matches again and **the incident never closes**; **(c)** with `N = 1`, whether one failure opens depends on whether the rules are applied in sequence or first-match. No rule covers an `unknown` outcome. | D4: state is **derived** from (open incident, counters, this observation), not from transition rules keyed on the previous state. Each defect is a test (§8). |
| C4  | 07 §7.6 "counted as `count_maintenance`"; 03 §3.5.1 case 3; M5 fold                           | The fold counts every row by outcome and adds seconds for `up`/`down`/`degraded`, so a maintenance-window outage lowers uptime — the side effect §3.5.1 says must be a deliberate decision.                                                                                                                                                                                                                                                                     | D6: maintenance rows are counted **only** in `count_maintenance` and add no seconds. The raw row keeps its true outcome.                                      |
| C5  | 07 §7.7 outbox `UNIQUE (group_key)`, `not_before = now() + 60 s`                              | That is E-3's grouping, which is M7's. Writing it here fixes M7's design from M6.                                                                                                                                                                                                                                                                                                                                                                               | D9: one row per incident transition, `UNIQUE (incident_id, kind)`. M7 groups at drain time.                                                                   |
| C6  | 07 §7.6 sweep: "`last_probe_at` older than `2 × interval + grace`"                            | A new endpoint has `last_probe_at IS NULL`; a resumed one has a stale value. Both read as `UNKNOWN` at once, before their first slot is due.                                                                                                                                                                                                                                                                                                                    | D10: anchored on `greatest(last_probe_at, endpoints.updated_at)`.                                                                                             |
| C7  | 03 §3.7 lists `MAINTENANCE` and `PAUSED` as states                                            | Both are functions of configuration (`enabled`, a window covering `now()`), not of observations. Written by the evaluator they are stale by up to a tick after every API write.                                                                                                                                                                                                                                                                                 | D4: the evaluator writes only `up`/`degraded`/`pending`/`down`/`unknown`; the read path derives `paused` and `maintenance` (§3.10).                           |
| C8  | PRD D-4; `RETENTION_RAW_DAYS = 7`                                                             | An incident outlives the raw row that explains it. A reference to `probe_results` dangles after a week.                                                                                                                                                                                                                                                                                                                                                         | D8: the first failed probe's class, code, status and assertion detail are **copied** into the incident.                                                       |
| C9  | PRD D-4, C-3; full-system verification M3-14                                                  | A body failure and a `json_path` failure store identical rows; the evaluator's `reason` is discarded (`probe.ts:455-462`). D-4 cannot be built on that.                                                                                                                                                                                                                                                                                                         | D11: M6 adds it.                                                                                                                                              |
| C10 | PRD §6.12 item 3: "an email within one probe interval + one minute of an endpoint going down" | With the default `N = 3` the third failure arrives up to **3 intervals** after the outage began (the first probe after it can be a full interval late), plus the evaluator tick (10 s) and E-3's 60 s grouping (07 §7.7). At 60 s: up to 3 min + 70 s, against a 2 min bound. Even `N = 1` gives up to one interval + 70 s — over by the tick.                                                                                                                  | Not M6's to fix; open question 1.                                                                                                                             |
| C11 | Handoff: "inside a window … no notification is queued"; D-6                                   | An incident opened **before** a window and recovering inside it: suppressing its close leaves the user believing it is still down.                                                                                                                                                                                                                                                                                                                              | D6: nothing opens inside a window; a close is always queued. Open question 2.                                                                                 |

### 2.2 Code on `main` this touches

- **Writer** — `scheduler.service.ts:314-356` `persistAndRelease` →
  `result-recorder.service.ts:55-90`: result insert and lease release in one
  transaction. `outcome-mapping.ts:28-34` maps success → `up`,
  `BLOCKED_BY_POLICY`/`UNKNOWN_ERROR`/no class → `unknown`, everything else →
  `down`. `degraded` and maintenance are decided here (D6, D7).
- **Classification** — `failure-classes.ts` on `main` after #74:
  `ESERVFAIL`/`EREFUSED`/`ETIMEOUT`/… → `DNS_FAILURE` on the guard path
  (`RESOLVER_CODE_TO_CLASS`), `EHOSTUNREACH`/`ENETUNREACH` →
  `CONNECTION_TIMEOUT`. So a DNS outage is `down / dns_failure` and opens an
  incident; the only `unknown` rows are the two policy classes and a
  classless failure. The state machine builds on exactly that split.
- **Assertions** — `evaluate.ts`: `AssertionResult` carries a free-text
  `reason`; `evaluateAssertions` stops at the first failure and does not
  report its index. The reasons contain the configured path, never response
  text.
- **Rollup** — `rollup.repository.ts:118-160`: counts by `outcome`, seconds for
  `up`/`down`/`degraded`. Writing `degraded` needs no fold change;
  maintenance does (D6). Single-flight by `FOR UPDATE SKIP LOCKED` on
  `rollup_state` — the evaluator reuses the table with its own row.
- **Retention guard** — `retention.service.ts:303-323` refuses to drop a raw
  partition holding `insert_xid ≥` the rollup's `last_xid`. It knows one
  consumer; M6 adds a second (D14).
- **`endpoint_runtime.last_probe_at`** — set by the release only when an
  observation exists; `abandon` leaves it (`endpoint-runtime.repository.ts:293-303`),
  written so M6's sweep can see a gap. The sweep reads it.
- **`endpoints`** — `latency_warn_ms integer NULL`, `failure_threshold` and
  `success_threshold smallint` with `CHECK (… BETWEEN 1 AND 10)` since 0010
  (#78). The API accepts all three already (`create-endpoint.dto.ts:42-44`).
  M6 adds no endpoint column.
- **Save-time URL check** — `core/ssrf/host-validator.ts:280-288` refuses
  `SSRF_BLOCKED_PORTS` with `PORT_NOT_ALLOWED`; nothing refuses the Fetch
  spec's blocked ports (D12).
- **Enums** — `endpoint_state` (`0001`) already has all seven values;
  `probe_outcome` has `degraded`. No `ALTER TYPE`.
- Migrations run to `0010`; the next is `0011`, with `types.ts` in the same
  commit.

### 2.3 Prior art and published defects

| Source                                        | What it does                                                                                                                                                                                                        | What M6 takes                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Uptime Kuma `server/model/monitor.js:945-963` | `retries` on each heartbeat; `PENDING` until `maxretries`, then `DOWN`. The notified beat is the **Nth** — no incident record, so downtime is timed from confirmation. Recovery is **one** `UP`.                    | The `PENDING` shape (03 §3.7 cites it). Contrast for D-2 and D-3.                                                                     |
| Uptime Kuma `monitor.js:475-477`              | Inside maintenance the probe is **not run**; status is `MAINTENANCE`.                                                                                                                                               | D-6 requires the opposite: run and record.                                                                                            |
| Uptime Kuma #2846                             | A monitor down **before** a window is notified as newly down **after** it (`MAINTENANCE → DOWN` is "important", `monitor.js:1402-1403`).                                                                            | Test: an incident open across a window stays the same incident; one open row in the outbox.                                           |
| Uptime Kuma #3016                             | Maintenance hides whether the monitor is up or down.                                                                                                                                                                | D6: the raw row keeps its true outcome; only the aggregates and the evaluator treat it differently.                                   |
| Gatus `watchdog/alerting.go:28-117`           | `NumberOfFailuresInARow` / `NumberOfSuccessesInARow` against per-alert thresholds: the same hysteresis as FR-24/25. Counters live in the **process** (`endpoint.Endpoint`), so a restart forgets a run in progress. | The thresholds; the handoff's "state in the database" is exactly the difference. Test: restart between failure 2 and 3.               |
| Gatus `watchdog/endpoint.go:59-70`            | Inside maintenance, alert handling is skipped whole: counters neither advance nor reset.                                                                                                                            | Contrast for D6, which lets successes close a prior incident.                                                                         |
| Gatus #1815                                   | Maintenance windows silently not applied to SSH and DNS endpoints: validation returned early for those types.                                                                                                       | Test: service-level and endpoint-level windows each suppress, on every write path. A suppression that fails open is the defect shape. |
| Gatus #1274                                   | `hh:mm` + timezone windows misread.                                                                                                                                                                                 | Windows are `timestamptz` pairs; no wall-clock arithmetic anywhere.                                                                   |
| 07 §7.7 / ADR-0008                            | Outbox row in the incident's transaction.                                                                                                                                                                           | D9, with the grouping left to M7 (C5).                                                                                                |

### 2.4 Mechanics verified directly, not recalled

PostgreSQL 17.11 (`postgres:17-alpine`, the image compose pins), scratch
container, removed afterwards. Node checks on the pinned **22.23.2** (`.nvmrc`)
and repeated on 24.20.0, undici **8.11.2**.

1. **A foreign key from the evaluator's tables deadlocks with deletion.** An
   evaluator-shaped transaction — `UPDATE endpoint_health` for an endpoint,
   then `INSERT INTO incidents` referencing `endpoints` — raced against
   `DELETE FROM endpoints` cascading into `endpoint_health`: **20 of 20**
   rounds deadlocked with both FKs, **0 of 20** without them. The same shape
   as M4's `claim_log` (the insert's `FOR KEY SHARE` on the parent is taken
   after the child row lock, the inverse of the cascade). Without the FKs the
   20 incidents remained as orphans — so no-FK needs a deletion story (D13).
2. **One open incident per endpoint, in the schema.**
   `CREATE UNIQUE INDEX … (endpoint_id) WHERE closed_at IS NULL` refused a
   second open row (`23505`); `INSERT … ON CONFLICT (endpoint_id) WHERE
closed_at IS NULL DO NOTHING` infers it and inserts nothing; after the first
   closes, a new open row is accepted. `CHECK (closed_at >= opened_at)` refused
   an inverted row. `tstzrange '[a,b)'` contains `a` and not `b`.
3. **Adding columns to `probe_results` is metadata-only.** `ADD COLUMN
in_maintenance boolean NOT NULL DEFAULT false, ADD COLUMN failure_detail
jsonb` on a partitioned table with a 2,000,000-row (100 MB) partition took
   **0.78 ms**. A partition created afterwards by `PartitionService`'s path —
   `CREATE TABLE (LIKE parent INCLUDING ALL)` + `ATTACH` — carries both
   columns.
4. **The Fetch spec's blocked ports.** `fetch('http://127.0.0.1:1/')` and
   `…:10080/` reject with `TypeError('fetch failed')` whose `cause` is
   `Error('bad port')` with **no `code`** — before any socket, on both Node
   versions. undici's list (`lib/web/fetch/constants.js:14-21`) is 80 ports
   and includes **6000, 6665–6669 and 10080**, ports someone could plausibly
   serve HTTP on — not only `tcpmux` as M3 D73 assumed.
5. **Arithmetic.** `smallint` max 32,767 × 30 s = 983,010 s = 11.4 days (C2).
   `integer` max × 30 s ≈ 2,041 years.

---

## 3. Design

### 3.1 Schema — migration `0011_incidents`

```sql
-- Results carry what M6 needs to judge them (D6, D11). Metadata-only (§2.4.3).
ALTER TABLE probe_results
    ADD COLUMN in_maintenance boolean NOT NULL DEFAULT false,
    ADD COLUMN failure_detail jsonb;          -- NULL unless assertion_failed (D11)

CREATE TABLE maintenance_windows (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    service_id  uuid        REFERENCES services (id) ON DELETE CASCADE,
    endpoint_id uuid        REFERENCES endpoints (id) ON DELETE CASCADE,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_windows_one_target CHECK ((service_id IS NULL) <> (endpoint_id IS NULL)),
    CONSTRAINT maintenance_windows_ordered    CHECK (ends_at > starts_at)
);
CREATE INDEX maintenance_windows_service_idx  ON maintenance_windows (service_id, ends_at)  WHERE service_id  IS NOT NULL;
CREATE INDEX maintenance_windows_endpoint_idx ON maintenance_windows (endpoint_id, ends_at) WHERE endpoint_id IS NOT NULL;
CREATE INDEX maintenance_windows_user_idx     ON maintenance_windows (user_id);

-- The evaluator's state. No FK (§2.4.1, D13); written only by the evaluator.
CREATE TABLE endpoint_health (
    endpoint_id            uuid           PRIMARY KEY,
    state                  endpoint_state NOT NULL,
    state_since            timestamptz    NOT NULL,   -- when state last changed: the observation's started_at, or the sweep's now()
    consecutive_failures   integer        NOT NULL DEFAULT 0 CHECK (consecutive_failures  >= 0),
    consecutive_successes  integer        NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
    -- The first failed probe of the current run (D-2), and its evidence (C8).
    run_started_at         timestamptz,
    run_failure_class      failure_class,
    run_failure_code       text,
    run_status_code        smallint,
    run_failure_detail     jsonb,
    -- The first success of the current recovery run (03 §3.8, closed_at).
    recovery_started_at    timestamptz,
    open_incident_id       uuid,
    last_success_at        timestamptz,
    -- Ordering fence (D3): the newest observation applied.
    applied_started_at     timestamptz,
    applied_attempt_id     uuid,
    updated_at             timestamptz    NOT NULL DEFAULT now(),
    CHECK (state IN ('up','degraded','pending','down','unknown')),
    CHECK ((consecutive_failures = 0) = (run_started_at IS NULL))
);

CREATE TABLE incidents (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id        uuid          NOT NULL,          -- no FK (D13)
    service_id         uuid          NOT NULL,          -- denormalized: an endpoint never changes service
    user_id            uuid          NOT NULL,
    opened_at          timestamptz   NOT NULL,          -- first failed probe (D-2)
    confirmed_at       timestamptz   NOT NULL,          -- the Nth failure: detection latency = confirmed_at - opened_at
    failures_to_open   smallint      NOT NULL,          -- N in force when it opened
    cause_class        failure_class NOT NULL,          -- of the first failed probe
    cause_code         text,
    cause_status_code  smallint,
    cause_detail       jsonb,
    closed_at          timestamptz,                     -- first success of the recovery run
    close_confirmed_at timestamptz,                     -- the Mth success
    CHECK (confirmed_at >= opened_at),
    CHECK ((closed_at IS NULL) = (close_confirmed_at IS NULL)),
    CHECK (closed_at IS NULL OR (closed_at > opened_at AND close_confirmed_at >= closed_at))
);
CREATE UNIQUE INDEX incidents_one_open_idx ON incidents (endpoint_id) WHERE closed_at IS NULL;
CREATE INDEX incidents_endpoint_idx ON incidents (endpoint_id, opened_at DESC, id);
CREATE INDEX incidents_service_idx  ON incidents (service_id,  opened_at DESC, id);
CREATE INDEX incidents_user_idx     ON incidents (user_id,     opened_at DESC, id);

CREATE TYPE notification_kind AS ENUM ('incident_open', 'incident_close');

CREATE TABLE notification_outbox (
    id           uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  uuid              NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    kind         notification_kind NOT NULL,
    user_id      uuid              NOT NULL,
    service_id   uuid              NOT NULL,
    created_at   timestamptz       NOT NULL DEFAULT now(),
    -- M7's; present so M7 starts from 07's shape without a migration of its own.
    not_before   timestamptz       NOT NULL DEFAULT now(),
    attempts     smallint          NOT NULL DEFAULT 0,
    delivered_at timestamptz,
    last_error   text,
    UNIQUE (incident_id, kind)                          -- E-1 "sent once", in the schema
);

-- The evaluator's watermark: a second consumer row beside the rollup's.
-- Started at the horizon, not at 0: incidents for results that predate M6
-- would be computed with no prior state and queue notifications for the past.
INSERT INTO rollup_state (name, last_xid)
VALUES ('incident_evaluator', pg_snapshot_xmin(pg_current_snapshot()));
```

`outbox → incidents` keeps its FK: both are written by the evaluator in one
transaction, and deleting an incident is only ever the evaluator's orphan
sweep (D13), so the cascade has no second writer to deadlock with.
`maintenance_windows` keeps its FKs: only the API writes it; the worker reads it
without locks. `down.sql` drops the new objects, the two columns and the
`incident_evaluator` row.

### 3.2 The writer — what a result says about itself

`toResultRow` (`outcome-mapping.ts`) gains three inputs, all decided **once, at
write time**, so a later threshold edit or window change never rewrites a
recorded verdict (the same rule as M5 D7's `interval_s`):

| Column                 | Rule                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outcome = 'degraded'` | `success` **and** `latency_warn_ms IS NOT NULL` **and** `total_ms > latency_warn_ms` (D7). Otherwise §3.3 of M5 unchanged.                                                                                                                       |
| `failure_detail`       | `{ index, assertion, reason }` for `ASSERTION_FAILED` (D11); `NULL` otherwise.                                                                                                                                                                   |
| `in_maintenance`       | `EXISTS` a window on the endpoint or on its service with `starts_at <= started_at < ends_at` — evaluated **in the insert statement itself** (`INSERT … SELECT …, EXISTS (…)`), so no extra round trip and no lock on `endpoints` (a plain read). |

`latency_warn_ms` reaches the writer from `MonitorLoaderService`, which already
loads the endpoint row; it is not added to `EndpointProbeConfig` — `probe()`
stays ignorant of verdicts about latency.

### 3.3 The evaluator pass

A worker tick every `EVALUATOR_TICK_MS` (10 s, 07's table), shaped exactly like
the rollup (M5 §3.4). **One transaction:**

1. `SELECT last_xid FROM rollup_state WHERE name = 'incident_evaluator' FOR
UPDATE SKIP LOCKED`. No row → another worker holds it: return.
2. `horizon := pg_snapshot_xmin(pg_current_snapshot())`, read once, bound
   thereafter (M5 §3.4 step 2).
3. Loop in batches of `EVALUATOR_BATCH_XIDS` whole xids below the horizon
   (M5's `OFFSET n LIMIT 1` bound). For each batch, read the rows **joined to
   `endpoints`** (thresholds, `service_id`, `user_id`; a deleted endpoint's
   rows drop out of the join), ordered `endpoint_id, started_at, attempt_id`.
4. For the batch's endpoints: `SELECT … FROM endpoint_health WHERE
endpoint_id = ANY($ids) ORDER BY endpoint_id FOR UPDATE`; a missing row
   starts from the initial state (§3.4).
5. Fold each endpoint's observations through the **pure** state machine
   (§3.4), producing the new health row and zero or more transitions.
6. Write: upsert `endpoint_health`; `INSERT` an incident on open; `UPDATE` it
   on close; one `notification_outbox` row per transition. The incident and
   outbox inserts are **plain** inserts: the partial unique index (§2.4.2) and
   `UNIQUE (incident_id, kind)` are backstops that turn a state-machine bug
   into a failed, logged, rolled-back pass — never a silently skipped insert
   that would leave `open_incident_id` naming a row that does not exist.
7. The `UNKNOWN` sweep (§3.6) and the orphan sweep (§3.12), in the same
   transaction.
8. Advance `last_xid`; commit.

**Why state lives in TypeScript for one step, and why that is safe.**
`AGENTS.md` forbids read-modify-write on shared rows. The state machine is a
branchy function of seven inputs; as SQL it would be unreviewable. It is safe
here because the rows are **not shared**: the evaluator is the only writer of
`endpoint_health` and `incidents`, the pass is single-flight under the
`rollup_state` row lock (step 1), and step 4 reads under `FOR UPDATE` inside
the same transaction — the "lock, re-read, write" form `AGENTS.md` requires of
a script. The barrier test (§7) holds a pass open and runs a second: the
second returns without reading.

**Exactly once.** State, incidents, outbox and watermark commit together. A
crash anywhere rolls all four back and the next pass re-reads the same rows
from the same state — a restart mid-incident can neither reopen nor lose one
(handoff constraint).

**No row lost to commit order.** The horizon (M5 C3). A slow probe — the kind
most likely to be a failure — commits late; it is evaluated when it passes
the horizon, never skipped.

### 3.4 The state machine — derived, not transition rules (C3)

Pure: `step(health, observation, thresholds) → { health', transitions }` in
`worker/incidents/utils/state-machine.ts`. An observation is `{ startedAt,
attemptId, outcome, inMaintenance, failureClass, failureCode, statusCode,
failureDetail, totalMs }`. Thresholds are `N = failure_threshold`,
`M = success_threshold`, read at evaluation time.

Initial state: `unknown`, counters `0`, no run, no incident.

**Late observation.** If `(startedAt, attemptId) ≤ (applied_started_at,
applied_attempt_id)` the observation is not applied: it is counted and logged
(`warn`, `late result not applied to incident state`). It is still stored and
folded — only the state machine ignores it. See D3.

Otherwise, by the observation's class:

| Observation                              | Counters                         | Runs                                                                         | Incident                                                                                                                  | New state                                                               |
| ---------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **failure** (`down`), not in maintenance | `failures += 1`, `successes = 0` | if `failures` became 1: `run_* :=` this probe; `recovery_started_at := NULL` | none open **and** `failures ≥ N` → **open**: `opened_at = run_started_at`, `confirmed_at = startedAt`, cause from `run_*` | open incident → `down`; else `pending`                                  |
| **failure**, in maintenance              | `failures = 0`, `successes = 0`  | run cleared; `recovery_started_at := NULL`                                   | never opens (D-6)                                                                                                         | open incident → `down`; else `pending`                                  |
| **success** (`up` / `degraded`), either  | `successes += 1`, `failures = 0` | run cleared; if `successes` became 1: `recovery_started_at := startedAt`     | open **and** `successes ≥ M` → **close**: `closed_at = recovery_started_at`, `close_confirmed_at = startedAt`             | open incident still open → `down`; else the outcome (`up` / `degraded`) |
| **unknown**                              | unchanged                        | unchanged                                                                    | unchanged                                                                                                                 | `unknown`                                                               |

`last_success_at` moves on every success; `applied_*` on every applied
observation; `state_since` only when `state` changes.

Properties the table is written to have, each a test (§8):

- `N = 1`: one failure opens, timed from itself. No evaluation-order question
  exists, because state is computed from counters after they move (C3c).
- `F, S` returns to `up` (C3a). A slow success during an incident counts toward
  closing it and the state stays `down` until `M` (C3b); `degraded` is shown
  only when no incident is open.
- A threshold lowered mid-run takes effect at the next failure (`≥`, not `=`).
- An `unknown` neither extends nor breaks a run: `F, U, F, F` opens at the
  third failure, `opened_at` at the first (D5).
- The same observation applied twice is refused by the ordering fence, so the
  function is idempotent per observation even outside the transaction's
  guarantee.

### 3.5 Timing — the acceptance sentence, precisely

Failures started at 10:01, 10:02, 10:03 (N = 3): the incident has
`opened_at = 10:01`, `confirmed_at = 10:03`; detection latency 2 min is
recorded, not hidden. Successes at 10:10, 10:11 (M = 2): `closed_at = 10:10`,
`close_confirmed_at = 10:11`; duration `closed_at − opened_at` = 9 min. The
evaluator's own tick delay appears nowhere in these values — they are all
probe `started_at`s (NFR-5's rule applied to incidents).

### 3.6 The `UNKNOWN` sweep

In the evaluator pass, after the batches (same `now()`):

```sql
INSERT INTO endpoint_health (endpoint_id, state, state_since)
SELECT e.id, 'unknown', now()
FROM   endpoints e
JOIN   endpoint_runtime r ON r.endpoint_id = e.id
WHERE  e.enabled
  AND  greatest(r.last_probe_at, e.updated_at)
         < now() - make_interval(secs => 2 * e.interval_s) - $grace
ON CONFLICT (endpoint_id) DO UPDATE
   SET state = 'unknown', state_since = now(), updated_at = now()
 WHERE endpoint_health.state <> 'unknown';
```

- Reads `last_probe_at`, which only a stored observation moves (M4, M5 §3.3) —
  so a slot abandoned, a write that exhausted its retries, a dead worker and a
  stopped scheduler all surface here, and evaluator lag does not.
- `greatest(…, e.updated_at)` (C6): a created, resumed or edited endpoint is
  given `2 × interval + grace` from that moment. The cost: an edit restarts the
  clock once.
- Paused endpoints are excluded: paused is not unknown (C7).
- Counters, runs and an open incident are untouched — no evidence of recovery.
- `UNKNOWN_GRACE_MS` default 90 s; `refine`: `≥ SCHEDULER_ADOPT_JITTER_MAX_S ×
1000 + SCHEDULER_TICK_MS + SCHEDULER_LOAD_BUDGET_MS` (62.5 s at defaults), so
  a new endpoint's first slot, which adoption may jitter by 60 s, cannot be
  flagged before it is due.

This is what makes a permanently failing-to-probe monitor visible: M5's
uptime excludes `unknown` (correctly), and the sweep plus `unknown`
observations turn that exclusion into a state the user sees.

### 3.7 Maintenance windows

- One-off `[starts_at, ends_at)`, on a service (all its endpoints) or on one
  endpoint. Stored as `timestamptz`; no local-time arithmetic (Gatus #1274).
- **Effect is decided at write time** (§3.2): a probe is in maintenance iff a
  window covered its `started_at` when it was stored. Creating, editing or
  deleting a window never rewrites recorded rows or past incidents. The API
  therefore refuses `ends_at ≤ now()` on create and on edit (a window wholly in
  the past could only pretend to have applied); a `starts_at` in the past is
  accepted and applies from the moment it is saved.
- Bounds: `ends_at − starts_at ≤ MAINTENANCE_MAX_DURATION_DAYS` (default 31);
  at most `MAINTENANCE_WINDOW_QUOTA_PER_USER` (default 100) windows whose
  `ends_at > now()` per user, counted under the user row lock the endpoint
  quota already takes (M2 §5.3) — a signed-in user cannot grow the table
  without bound.
- Evaluator: §3.4's second row. Rollup: D6.
- Notifications: nothing opens inside a window, so nothing is queued for an
  open; a close is always queued (C11, open question 2).

### 3.8 Outbox

One row per transition, in the transaction that makes it (ADR-0008, rule g14).
`UNIQUE (incident_id, kind)` makes "sent once, on open" (E-1) a property of
the schema. The payload is not stored: M7 renders from the incident row, which
holds the cause, the times and the counts E-1's content list needs. Grouping by
service (E-3) is a query over `created_at` at drain time — M7's decision (C5).

### 3.9 Which assertion failed (M3-14)

- `AssertionResult`'s failure arm gains a stable `code` beside the prose
  `reason`: `substring_absent`, `forbidden_substring_present`,
  `truncated_absence_unprovable`, `truncated_not_parsed`, `not_json`,
  `path_not_found`, `value_mismatch`. `evaluateAssertions` returns the failing
  `index`.
- `ProbeOutcome` gains `assertionFailure?: { index, code }`;
  `toResultRow` writes `failure_detail = { index, code, assertion }`, where
  `assertion` is a snapshot of the configured assertion at that index (it can
  be edited later; the incident must say what was checked **then**).
- **No response text is stored** (NFR-13): the snapshot is the user's own
  configuration, bounded by the DTO; the code is from a closed list. A test
  serves a body containing a sentinel and asserts the sentinel appears in no
  column of any row.
- `FailureDetail` is a type in `core/db/types.ts`, read by the API and written
  by the worker — one definition (`AGENTS.md`, "a fix that duplicates").

### 3.10 HTTP surface

All under the session guard; every read **joins `endpoints` on `id` and
`user_id`**, so another user's id and a deleted endpoint's id both answer the
same `404` as a random UUID (`AGENTS.md`; M5 §3.8's rule).

```
GET    /v1/incidents?status=open|closed&cursor&limit
GET    /v1/incidents/:id
GET    /v1/services/:id/incidents?status&cursor&limit          D-5 per service
GET    /v1/endpoints/:id/incidents?status&cursor&limit         D-5, FR-27
GET    /v1/endpoints/:id                                       + `health` (below)

POST   /v1/maintenance-windows            { serviceId | endpointId, startsAt, endsAt, reason? }
GET    /v1/maintenance-windows?serviceId&endpointId&active&cursor&limit
GET    /v1/maintenance-windows/:id
PATCH  /v1/maintenance-windows/:id        { startsAt?, endsAt?, reason? }
DELETE /v1/maintenance-windows/:id
```

- Incident: `id, endpointId, serviceId, status, openedAt, confirmedAt,
closedAt, closeConfirmedAt, durationMs` (closed only),
  `detectionLatencyMs`, `failuresToOpen`, `cause { class, code, statusCode,
assertion }`. Ordered `opened_at DESC, id DESC`; the cursor is the last
  incident's `id`, resolved to its `(opened_at, id)` inside the owner-scoped
  query.
- `health` on the endpoint: `state` (effective: `paused` if disabled, else
  `maintenance` if a window covers `now()`, else the stored state, else
  `unknown` when no row exists), `stateSince`, `consecutiveFailures`,
  `failureThreshold` — so the UI can say "failing, 2 of 3" (03 §3.7) —
  `openIncidentId`, `lastSuccessAt`.
- Errors carry stable codes (`VALIDATION_FAILED`, `MAINTENANCE_WINDOW_IN_PAST`,
  `MAINTENANCE_WINDOW_TOO_LONG`, `MAINTENANCE_WINDOW_QUOTA_EXCEEDED`). A
  target that does not exist or is another user's is `404`, never `403`.
- `http/incidents.http` and `http/maintenance.http` with the failure cases;
  `npm run openapi` in the same commit; the drift test covers the new routes.

### 3.11 Blocked ports (M5 leftover 2)

The two options the handoff names are different products; M6 takes **both**,
because each covers a case the other cannot:

1. **Save time refuses them** (B-7: "I am stopped from registering something
   unmonitorable"). `core/ssrf` gains `FETCH_BLOCKED_PORTS`, the Fetch spec's
   list, checked beside `SSRF_BLOCKED_PORTS` with the same `PORT_NOT_ALLOWED`
   code and a message that names the reason. It is a constant, not
   configuration: it is the HTTP client's hard limit, not policy. A drift test
   reads undici's `constants.js` and asserts equality, so an undici bump that
   changes the list fails CI.
2. **A redirect can still reach one**, and save time cannot see it. `probe()`
   checks every hop's effective port against the same constant before
   `fetch` and records `BLOCKED_BY_POLICY` with code `BAD_PORT` — honest (it
   is probeboard's client refusing), classified rather than `UNKNOWN_ERROR`
   with no code, and still `unknown` under D-7. The endpoint's state shows
   `unknown` from the first such probe (§3.4), so it is visible, not silently
   excluded.

Rows saved before the check (M3 D73's pre-existing gap): **none deployed**; a
development database's rows keep probing as `unknown / blocked_by_policy /
BAD_PORT` and show `unknown` — visible, which is the property the tracker row
asks for. The verification record includes the query that counts them.

### 3.12 M5's named leftovers

1. **`degraded` is never written** → §3.2 / D7. The fold already sums
   `count_degraded` and `degraded_seconds` by outcome; no fold change.
2. **`fetch`-blocked ports** → §3.11.
3. **D17's `endpoint_runtime` columns** → not added; `endpoint_health` instead
   (C1, D1). `last_success_at` moves with them.
4. **Orphans of a deleted endpoint** — decided once, for every table keyed on
   `endpoint_id` without an FK (D13):

| Table                                                               | Who removes a deleted endpoint's rows | When                                                                                                                                                                           | Under which lock                                |
| ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `endpoint_health`, `incidents` (→ `notification_outbox` by cascade) | the evaluator                         | every pass, anti-join on `endpoints`                                                                                                                                           | the evaluator's `rollup_state` row              |
| `probe_stats` (m1, h1, d1)                                          | the rollup                            | once per `STORAGE_MAINTENANCE_INTERVAL_MS`, for `endpoint_id`s in `probe_stats_d1` with no endpoint (every folded endpoint has a d1 row, since all grains come from one batch) | the rollup's `rollup_state` row, taken blocking |
| `probe_results`                                                     | retention                             | at `RETENTION_RAW_DAYS`                                                                                                                                                        | —                                               |
| `claim_log`                                                         | retention                             | at `RETENTION_CLAIM_LOG_DAYS`                                                                                                                                                  | —                                               |

Each consumer deletes only rows it writes, under the lock that serializes its
own writes, so a delete can never race a concurrent upsert of the same row.
The user sees the deletion **immediately** anyway: every read joins
`endpoints`. `maintenance_windows` cascades by FK.

---

## 4. Decisions

| #   | Decision                                                                                                                                                                                                                                                               | Why                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `endpoint_health`, a new table, not columns on `endpoint_runtime`                                                                                                                                                                                                      | C1: the claim `SKIP LOCKED`s rows the evaluator holds; the hot row stays narrow; one writer per table                                   |
| D2  | The evaluator is an `xid8`-watermark consumer of `probe_results` with its own `rollup_state` row, single-flight by row lock; state, incidents, outbox and watermark in one transaction                                                                                 | M5 C3 applies unchanged; exactly-once and restart-safety by construction                                                                |
| D3  | Per endpoint, observations apply in `(started_at, attempt_id)` order; one older than the last applied is stored and folded but **not** applied to state                                                                                                                | a zombie write (lease lapsed, M5 C3) arrives after its successor; applying it would rewind a run or close an incident on stale evidence |
| D4  | State derived from (open incident, counters, observation); the evaluator writes only `up`/`degraded`/`pending`/`down`/`unknown`; `paused` and `maintenance` are derived on read                                                                                        | C3, C7                                                                                                                                  |
| D5  | `unknown` leaves counters, runs and incidents alone and sets state `unknown`                                                                                                                                                                                           | D-7: neither evidence of failure nor of recovery. Breaking the run instead would let a policy block reset a real outage's `opened_at`   |
| D6  | Maintenance: flag on the row at write; inside a window a failure never counts and clears the run, a success counts; an open incident persists and can close; the fold counts maintenance rows only in `count_maintenance` and adds no seconds; the raw outcome is kept | D-6, C4, C11, Kuma #2846/#3016. Failures inside a window must not seed a run that opens with `opened_at` inside the window              |
| D7  | `degraded` = success with `total_ms > latency_warn_ms`, decided at write; `NULL` threshold = never. Counts as a success for closing                                                                                                                                    | PRD §6.5 "crossing it means `DEGRADED`, not `DOWN`"; `total_ms` is the latency every chart shows                                        |
| D8  | Incident copies the first failed probe's evidence; `opened_at`/`confirmed_at`/`closed_at`/`close_confirmed_at` are probe `started_at`s                                                                                                                                 | D-2, 03 §3.8, C8                                                                                                                        |
| D9  | Outbox: one row per transition, `UNIQUE (incident_id, kind)`, no payload, no grouping                                                                                                                                                                                  | ADR-0008; C5                                                                                                                            |
| D10 | Sweep anchored on `greatest(last_probe_at, updated_at)`, enabled only, grace `refine`d above adoption jitter                                                                                                                                                           | C6; §3.6                                                                                                                                |
| D11 | `failure_detail jsonb` on results and incidents: index, closed-list code, configured-assertion snapshot; no response text                                                                                                                                              | C9; NFR-13                                                                                                                              |
| D12 | Fetch-blocked ports refused at save and classified `BLOCKED_BY_POLICY / BAD_PORT` per hop                                                                                                                                                                              | §3.11; §2.4.4                                                                                                                           |
| D13 | No FK from `endpoint_health` or `incidents` to `endpoints`; each consumer sweeps its own orphans under its own lock                                                                                                                                                    | §2.4.1: 20/20 deadlocks with the FK; §3.12                                                                                              |
| D14 | The raw retention guard treats a row as unconsumed if `insert_xid ≥ least(rollup, evaluator)` watermark; a missing row is `0` (fails closed)                                                                                                                           | dropping a partition the evaluator has not read would lose an outage's evidence for ever                                                |
| D15 | Evaluator watermark starts at the migration's horizon                                                                                                                                                                                                                  | incidents computed for pre-M6 history would have no prior state and queue notifications for the past                                    |
| D16 | Pausing leaves an open incident open; the sweep ignores paused endpoints                                                                                                                                                                                               | no evidence of recovery exists; closing would fabricate one. The duration includes the pause, and the UI shows `paused`                 |
| D17 | Thresholds are read at evaluation time                                                                                                                                                                                                                                 | #78 bounds them to 1–10 in the schema; a change applies from the next observation                                                       |
| D18 | HTTP surface per §3.10, including maintenance CRUD                                                                                                                                                                                                                     | D-6 needs a way to declare a window; D-5 needs history; 07 §7.8 names both                                                              |
| D19 | Counters `integer`                                                                                                                                                                                                                                                     | C2                                                                                                                                      |
| D20 | Windows one-off, `timestamptz`, effect decided at write, past-ending windows refused, bounded in length and count                                                                                                                                                      | §3.7                                                                                                                                    |

---

## 5. Config

`src/core/config/schema.ts`, validated at boot; each key ships with a
rejection test.

| Key                                 | Type / bound                     | Default  | Note                               |
| ----------------------------------- | -------------------------------- | -------- | ---------------------------------- |
| `EVALUATOR_TICK_MS`                 | `int().min(100).max(600_000)`    | `10_000` | 07's table                         |
| `EVALUATOR_BATCH_XIDS`              | `int().min(1).max(100_000)`      | `5000`   | M5's batching                      |
| `EVALUATOR_STALE_TICKS`             | `int().min(1).max(1000)`         | `10`     | `warn` when the watermark is older |
| `UNKNOWN_GRACE_MS`                  | `int().min(1000).max(3_600_000)` | `90_000` | `refine` §3.6                      |
| `MAINTENANCE_MAX_DURATION_DAYS`     | `int().min(1).max(366)`          | `31`     |                                    |
| `MAINTENANCE_WINDOW_QUOTA_PER_USER` | `int().min(1).max(100_000)`      | `100`    | windows with `ends_at > now()`     |

---

## 6. Module layout

```
src/core/ssrf/fetch-blocked-ports.ts    (+ drift .test.ts against undici)
src/core/db/types.ts                    FailureDetail, new tables
src/worker/incidents/
  incidents.module.ts
  services/evaluator.service.ts         the tick (RollupService's shape)
  repositories/evaluator.repository.ts  the pass, sweeps, watermark
  utils/state-machine.ts (+ .test.ts)   pure step()
  e2e/evaluator.int.test.ts
  e2e/incidents-acceptance.int.test.ts
src/worker/storage/utils/outcome-mapping.ts    degraded, failure_detail
src/worker/storage/repositories/probe-result.repository.ts   in_maintenance in the insert
src/worker/rollup/repositories/rollup.repository.ts          count_maintenance; stats orphan sweep
src/worker/storage/services/retention.service.ts             two-watermark guard
src/worker/probing/assertions/evaluate.ts                    codes and index
src/worker/probing/utils/probe.ts                            per-hop blocked-port check
src/api/incidents/        incidents.module.ts, incidents.controller.ts, incidents.service.ts,
                          dto/, repositories/incident.repository.ts, e2e/
src/api/maintenance/      maintenance.module.ts, maintenance.controller.ts, maintenance.service.ts,
                          dto/, repositories/maintenance-window.repository.ts, e2e/
src/api/registration/     endpoint response gains `health`
src/core/db/migrations/0011_incidents.{up,down}.sql
http/incidents.http, http/maintenance.http
```

`FailureDetail` is the only incident symbol both processes need, and it is a
row type, so it lives in `types.ts`; the effective-state derivation is
API-only. `core` depends on nothing; `api` and `worker` never import each
other (`architecture.test.ts`).

---

## 7. Integrity properties, and how each is proved

Every row: the test, and the removal that must make it fail.

| Property                                                                          | Mechanism                                | Proved by / removed to see it fail                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`opened_at` is the first failure** (D-2)                                        | `run_started_at`                         | acceptance: 10:01/10:02/10:03 → `opened_at 10:01`, `confirmed_at 10:03`. Removal: open with `startedAt` → `10:03`                                                                         |
| One bad probe never opens (D-1)                                                   | `failures ≥ N`                           | `F,S,F,S,F` at N=3 → no incident. Removal: `≥ 1`                                                                                                                                          |
| N = 1 opens on the first failure (C3c)                                            | derived state                            | one failure → incident at itself                                                                                                                                                          |
| `F, S` returns to `up` (C3a)                                                      | derived state                            | state `up`, counters 0. Removal: 07's rules → `pending`                                                                                                                                   |
| A slow success during an incident still closes it (C3b)                           | successes count regardless of `degraded` | `F×3, S(slow), S` → closed. Removal: 07's rules → never closes                                                                                                                            |
| Closes after M, timed from the first success (D-3)                                | `recovery_started_at`                    | `closed_at` = first success. Removal: use the Mth                                                                                                                                         |
| `unknown` neither opens nor breaks a run (D-7, D5)                                | table row 4                              | `U×10` → no incident, state `unknown`; `F,U,F,F` → opens, `opened_at` = first F. Removal: treat `unknown` as failure → opens on `U×3`                                                     |
| **A DNS outage opens an incident** (#74)                                          | real resolver, real writer               | guard on, test resolver answers `SERVFAIL`, three slots through the real scheduler path → `down / dns_failure`, incident opens                                                            |
| Maintenance suppresses opening, on every path (D-6, Gatus #1815)                  | row flag                                 | service-level window and endpoint-level window, each: `F×5` inside → no incident, no outbox row. Removal: ignore the flag → opens                                                         |
| A window boundary is `[start, end)`                                               | `EXISTS` predicate                       | probes at `start` in, at `end` out                                                                                                                                                        |
| An incident open across a window is the same incident (Kuma #2846)                | D6                                       | open, window, still failing, window ends → one incident, one `incident_open` row                                                                                                          |
| A success inside a window closes a prior incident, and queues the close           | D6                                       | close row present                                                                                                                                                                         |
| Failures inside a window do not seed `opened_at`                                  | run cleared                              | `F,F` in window, `F` after → `failures = 1`, no incident until two more                                                                                                                   |
| **Exactly once across a crash**                                                   | one transaction                          | error injected after the incident insert, then a clean pass → one incident, one outbox row, counters as if once. Removal: commit the watermark in a second transaction → duplicate counts |
| No result lost to commit order                                                    | horizon                                  | barrier: a second connection holds a lower-xid failure open; a later row commits; pass; assert not applied; commit; pass; applied once, in order                                          |
| A zombie result does not rewind state (D3)                                        | ordering fence                           | commit `S@10:05` then `F@10:04` → no run starts. Removal: apply in xid order → `pending`                                                                                                  |
| Single-flight                                                                     | `FOR UPDATE SKIP LOCKED`                 | held pass + second pass → second skips. Removal → double counts                                                                                                                           |
| Incident and outbox commit together (ADR-0008)                                    | same transaction                         | outbox insert forced to fail → no incident, state unchanged                                                                                                                               |
| One open incident per endpoint, in the schema                                     | partial unique index                     | a direct second open insert → `23505`                                                                                                                                                     |
| A restart mid-run does not forget it (Gatus contrast)                             | state in the database                    | real worker: two failures, `SIGTERM`, restart, third failure → opens, `opened_at` = first                                                                                                 |
| Sweep marks a silent endpoint `unknown`                                           | §3.6                                     | no result for `2 × interval + grace` → `unknown`; paused → not; new endpoint → not before its window. Removal: drop the `updated_at` anchor → new endpoint flagged at once                |
| Counters survive a long healthy run (C2)                                          | `integer`                                | `consecutive_successes = 40000` then a success → no error. Removal: `smallint` → `22003`                                                                                                  |
| `degraded` written and folded (D7)                                                | writer                                   | success at 900 ms, threshold 500 → `outcome degraded`, `count_degraded 1`, `degraded_seconds = interval`; `NULL` threshold → `up`                                                         |
| Maintenance excluded from uptime (D6)                                             | fold                                     | per bucket `count_up+down+degraded+unknown+maintenance = rows`; maintenance rows add no seconds. Removal: count by outcome → `count_down` moves                                           |
| Retention waits for the evaluator (D14)                                           | two-watermark guard                      | partition with rows the evaluator has not passed → kept. Removal: rollup watermark only → dropped                                                                                         |
| Deleting an endpoint cannot deadlock the evaluator (D13)                          | no FK                                    | 20 rounds of a service delete racing a pass that opens incidents on its endpoints → 0 `40P01`                                                                                             |
| A deleted endpoint's history is gone for the user at once, and from storage later | join on read; sweeps                     | `404` immediately; rows gone after the next pass / maintenance tick                                                                                                                       |
| Which assertion failed is stored, and no body is (M3-14, NFR-13)                  | D11                                      | a body and a `json_path` failure produce different `failure_detail`; a sentinel in the body appears in no column. Removal: drop `index` → identical rows                                  |
| Incident reads are tenant-scoped                                                  | join `endpoints.user_id`                 | bob on alice's incident, endpoint and service incidents, window: `404`, byte-identical to a random UUID; lists exclude. Removal: drop the `user_id` conjunct → bob reads                  |
| Blocked ports refused and classified (D12)                                        | constant + per-hop check                 | save on 1, 6000, 10080 → `400 PORT_NOT_ALLOWED`; redirect to `:10080` → `unknown / blocked_by_policy / BAD_PORT`. Drift test fails on a list edit                                         |

---

## 8. Test matrix

**Unit (no I/O):** `step()` — every row of §3.4's table at N, M ∈ {1, 3, 10};
C3a–c; late observations; threshold lowered and raised mid-run; `unknown`
interleavings; maintenance entry and exit with and without an open incident.
Assertion codes for every failure path and the failing index. `toResultRow`
for `degraded` at `total_ms = threshold` (not degraded) and `threshold + 1`.
Blocked-port constant against undici. Config `refine`s with rejection cases.
Effective state derivation (`paused` > `maintenance` > stored > `unknown`).

**Integration (PostgreSQL):** every row of §7; migration up/down/up; the
real-writer maintenance flag against service and endpoint windows; the two
orphan sweeps; the deadlock race.

**Acceptance (`e2e/incidents-acceptance.int.test.ts`)** — the exit test, through
the real writer and the real evaluator pass:

1. An endpoint with N = 3, M = 2. Results at 10:00 `up`, 10:01, 10:02 `down`
   → state `pending`, `consecutiveFailures 2`, no incident.
2. 10:03 `down` → one incident, `opened_at 10:01`, `confirmed_at 10:03`, cause
   from the 10:01 probe; state `down`; one `incident_open` outbox row.
3. 10:04 `up` → still open, state `down`.
4. 10:05 `up` → closed, `closed_at 10:04`, `close_confirmed_at 10:05`; state
   `up`; one `incident_close` row.
5. `GET /v1/endpoints/:id/incidents` returns it with `durationMs 180000` and
   `detectionLatencyMs 120000`.

---

## 9. Delivery — 3 PRs after this plan

1. **Record.** `0011` (+ `types.ts`, `.down`); M3-14 codes and index through
   `ProbeOutcome` to `failure_detail`; `degraded` and `in_maintenance` in the
   writer; the fold's `count_maintenance` rule; the blocked-port constant,
   save-time refusal and per-hop check; the two-watermark retention guard.
   Database change → fresh clone and a real run: rows show `degraded`,
   `failure_detail`, `in_maintenance`; port 10080 refused at save.
2. **Evaluate.** `step()`, the evaluator pass, the sweep, both orphan sweeps,
   config, wiring into `WorkerModule` and `main.ts`'s stop order; the §7 rows
   that need no HTTP; the acceptance test to step 4.
3. **Show, and prove.** Incident and maintenance routes, `health` on the
   endpoint, `http/`, `openapi.yaml`, acceptance step 5, and
   `docs/m6-verification.md`. Last PR: fresh clone and a real run from an empty
   volume.

**`docs/m6-verification.md`** records, from `docker-compose down -v`, two
workers, the built image:

| Run                                                              | Evidence                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The exit test live: a target toggled down then up, interval 30 s | incident row, `opened_at` against the target's own log of the first failed request; close after two                       |
| Detection latency                                                | `confirmed_at − opened_at` per incident, and the evaluator's wall-clock delay after `confirmed_at`, against the 10 s tick |
| DNS outage (`SERVFAIL`) and connection refused                   | each opens an incident with its class                                                                                     |
| A policy block (rebinding to a private address) for 10 slots     | no incident, state `unknown`                                                                                              |
| `SIGKILL` a worker between failures 2 and 3                      | the survivor opens it, `opened_at` = first                                                                                |
| Worker stopped for `2 × interval + grace`                        | every endpoint `unknown`; recovers on restart                                                                             |
| Maintenance window across an outage, service-level               | no incident inside; an incident open before it continues                                                                  |
| Endpoint deleted mid-incident                                    | `404` at once; rows swept                                                                                                 |
| `count_maintenance`, `count_degraded`, `degraded_seconds`        | non-zero where M5's run had 0                                                                                             |

Numbers appear there only once measured.

---

## 10. Open questions — flagged, not resolved quietly

1. **PRD §6.12 item 3 cannot hold as written** (C10). An email "within one
   probe interval + one minute" is up to `N × interval + 70 s` at the
   defaults — `3 × interval + 70 s` at N = 3, and still `interval + 70 s` at
   N = 1, because the evaluator tick and E-3's grouping add 70 s on their own.
   M7's criterion, but M6's thresholds and tick decide it; recommendation:
   amend it to `N × interval + tick + grouping window`.
2. **A close inside a maintenance window is queued** (C11). The handoff says
   "no notification is queued" inside a window; this plan reads D-6 as "no
   incident opens, so no open is queued" and still queues the close of an
   incident that opened before the window — otherwise the user was told it
   broke and never told it recovered. Recommendation: as planned.
3. **`probeboard-docs` needs corrections** (outside this checkout — reported,
   not made): 07 §7.6's pseudo-code (C3), the `smallint` counters (C2), state
   columns on `endpoint_runtime` (C1), the outbox's `group_key` (C5, if Levon
   agrees M7 owns grouping), 03 §3.7's `MAINTENANCE`/`PAUSED` as written states
   (C7), and M3 D73's "nobody runs HTTP on those ports" (§2.4.4).
4. **Maintenance latency counts in the percentiles.** D6 removes maintenance
   rows from uptime but leaves M5's latency population (D6 there: "responded")
   unchanged, so a slow deploy inside a window moves p95. One rule for
   latency is simpler to reason about; excluding them is a one-line `FILTER`.
   Recommendation: keep them.

---

## Sources

- `probeboard-docs/en/02-requirements.md` FR-24…FR-28; `06-prd.md` §6.5, §6.6,
  §6.7, §6.8, §6.12; `03-api-health.md` §3.4, §3.5, §3.7, §3.8;
  `07-architecture.md` §7.1, §7.3, §7.5, §7.6, §7.7, §7.8; `08-plan.md` row M6
- `docs/m4-plan.md` D17; `docs/m5-plan.md` §3.3–§3.5, §3.7, C3, D12;
  `docs/full-system-verification.md` M3-14, M3-20, M5-6, defects 1–2;
  `docs/tracker.md` follow-ups #59, #68, M5/M6
- `references/uptime-kuma/server/model/monitor.js` (MIT) — 440–477, 925–1000,
  1385–1450; issues louislam/uptime-kuma#2846, #3016
- `references/gatus/watchdog/alerting.go`, `watchdog/endpoint.go` (Apache-2.0);
  issues TwiN/gatus#1815, #1274
- undici 8.11.2 `lib/web/fetch/constants.js:14-21`, `lib/web/fetch/index.js:584-589`;
  the Fetch standard, "block bad port"
- PostgreSQL 17 docs: partial unique indexes and `ON CONFLICT` inference,
  `ALTER TABLE … ADD COLUMN` on partitioned tables, `FOR KEY SHARE` and FK
  checks, `tstzrange`
- Measurements in §2.4: PostgreSQL 17.11, Node 22.23.2 and 24.20.0, undici 8.11.2
