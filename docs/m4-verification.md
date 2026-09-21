# M4 verification record

What was executed to accept M4 — the scheduler — and what it produced. Method
follows [m3-verification.md](m3-verification.md): the suites prove each piece
behaves in isolation, the real container stack is where a multi-process claim
either holds or does not.

M4 shipped as three PRs against `docs/m4-plan.md` §9: #52 (the plan itself),
#59 (schema, config and the claim query), and this one (the tick, the pool,
the loader, and the wiring that makes any of it run).

Date: 2026-09-21 · Postgres 17-alpine · Node 22 in CI and the image, 24
locally · two `worker` replicas via `docker compose --scale worker=2`.

## Method

1. **The suites**, local — 1073 unit tests, 359 integration tests (1 skipped,
   inherited from M3), 95.4% statement / 90.8% branch coverage.
2. **A fresh clone** at the head commit (`npm ci`, `npm run build`,
   `npm run verify`, `npm run test:int`).
3. **The real container stack**, `docker compose up -d --build --scale
worker=2`, with monitors registered directly against the running
   `postgres` container (M4 has no HTTP surface, so there is no registration
   endpoint to drive this through) and probed by the shipped worker image.

Every guard was re-proved by removal on the final code, in its own commit's
message: D19's three per-step `catch` blocks, D20's load-budget deadline,
D22's `REPEATABLE READ` isolation level, D23's two independently-guarded
terminal writes, NFR-1's capacity floor, and `ProbePoolService.drain`'s
settled/still-running split.

## Results

### The suites

| Check                               | Result                                              |
| ----------------------------------- | --------------------------------------------------- |
| `npm run verify` (fresh clone)      | pass — format, lint, types, openapi, 1073 tests     |
| `npm run build` (fresh clone)       | pass                                                |
| `npm run test:int` vs real Postgres | 359 passed, 1 skipped (M3's D69, unrelated to M4)   |
| `npm run test:coverage`             | 95.39% statements, 90.84% branches                  |
| Migration `0007`                    | applies, re-runs as a no-op, rolls back, re-applies |

### The real container stack

`docker compose up -d --build --scale worker=2` from an empty volume.

| Check                                                                           | Result                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `migrate`                                                                       | ran to completion, exited 0                                    |
| `api`                                                                           | `Up (healthy)`, `/readyz` → `{"status":"ok","database":"ok"}`  |
| `worker-1`, `worker-2`                                                          | `Up`, both logged `worker started` with distinct `workerId`s   |
| A monitor registered directly against `postgres`, pointed at `api:3000/healthz` | claimed, probed, released within one tick; `last_probe_at` set |

### The exit test, in containers

> _"Two workers running against one database probe nothing twice, and killing
> one mid-probe makes its claimed work available to the other within a
> bounded time."_

**Disjointness.** 21 monitors registered directly, both workers running at
production defaults (`SCHEDULER_TICK_MS=1000`, `SCHEDULER_LEASE_MS=60000`) for
several minutes while the kill scenario below also ran. The plan's own
evidence query (§9):

```sql
SELECT endpoint_id, scheduled_at, count(*) FROM claim_log
GROUP BY 1, 2 HAVING count(*) > 1;
-- 0 rows
```

`claim_log` recorded **5554 claims across 5 distinct `worker_id`s** (two
container restarts included) over the run, with zero duplicate
`(endpoint_id, scheduled_at)` pairs.

**Killing one mid-probe.** A monitor was pointed at `192.0.2.1` (TEST-NET-1,
publicly routable-looking but answering nothing) with the worker's SSRF guard
disabled for this one demonstration run only — every other check in this
record used the guard at its production default. The connect stalls until
M3's own connect timeout, giving a genuine in-flight window rather than an
instant `BLOCKED_BY_POLICY`.

| Event                                                                    | Time (UTC)   |
| ------------------------------------------------------------------------ | ------------ |
| `worker-1` (`ad22f362a102-1`) claims the slot                            | 14:37:10.797 |
| `docker kill -s SIGKILL probeboard-worker-1`                             | 14:37:35     |
| Row still shows `leased_by = ad22f362a102-1`, `last_probe_at` still null | 14:37:44     |
| `worker-1`'s lease (`leased_until`) lapses                               | 14:38:10.797 |
| `worker-2` (`7baf7a1fe3c5-1`) claims the **next** slot                   | 14:38:10.925 |

Reclaim took **35.9s** from the kill (60s lease minus the 24.2s already
elapsed when the kill happened, plus one tick) — bounded by the below-lease
regime of D6's `max(interval_s × 1000, SCHEDULER_LEASE_MS) + tick`, here
`max(30000, 60000) + 1000 = 61000ms` from the _claim_, which matches: claim at
14:37:10.797, reclaim at 14:38:10.925, a difference of 60.1s.

**D5, visible in the same evidence.** `worker-2`'s reclaim is a **different**
slot (`scheduled_at = 14:37:39.972`) from the one the killed worker held
(`14:37:09.972`) — the reclaim is not a second attempt at the same slot, it is
the slot after it, exactly as D5 requires. The killed worker's own attempt
never produced an observation (`last_probe_at` stayed null for that slot):
the process died before either its own probe timeout or its abandon write
could complete, and the row was still recovered correctly by lease expiry
alone — the scenario D19/D23 are bounded for, not eliminated.

Both reclaim regimes (below- and above-lease) are proved with a controlled
barrier — a directly-committed claim standing in for a killed worker, without
needing a second real process — in
[`scheduler.int.test.ts`](../src/worker/scheduler/e2e/scheduler.int.test.ts);
this container run demonstrates the below-lease regime once, live, against
the shipped image.

**Where `docs/m4-verification.md` must be read against NFR-4's literal text**
(§3.11): under D5 the **slot** the killed worker held is lost — no observation
was ever produced for it — and the **endpoint** returns to circulation within
the bound. The evidence above supports that reading, not a stronger one.

Afterwards `docker compose down`; the machine was left with only
`probeboard-postgres-1` running.

## Deviations from the merged plan

None. PR 3 implements §6's module layout, §3.4's tick, §3.5's lease
arithmetic (unchanged from PR 2), §3.7's guarded terminal writes, and §3.9's
shutdown ordering as written.

One elaboration not spelled out in the plan: `ProbePoolService.drain` snapshots
the in-flight key set at the moment `drain` is called, so a slot started after
shutdown begins (structurally impossible once the tick timer is cleared, but
not assumed away) is credited to neither `settled` nor `stillRunning`.

## What is not verified

- **The above-lease reclaim regime, live, in containers.** Proved by the
  automated e2e suite (§8's test matrix); the container run above demonstrates
  the below-lease regime only, to keep the demonstration's wall-clock cost to
  one lease period rather than two.
- **`SCHEDULER_LOAD_BUDGET_MS` overrunning in production.** M4's own suite
  proves the abandon path fires (D20); nothing in this record measures real
  loader latency under production `DATABASE_POOL_MAX` contention, which is
  M10's load test's job (§3.10).
- **M5's persistence of `ProbeOutcome`.** M4 discards every outcome after
  releasing the lease (D18); this record's disjointness evidence is
  necessarily `claim_log`-based rather than a check on stored results, for the
  reason §9 gives.

## Deferred to follow-ups

Tracked in `docs/tracker.md` by the orchestrator, not this record: D2's
paused-row re-measurement, `claim_log` retention (M5), D17's M6 columns, the
reconcile fleet scan, M5's `(endpoint_id, scheduled_at)` natural key
correction (raised by Codex on #59).
