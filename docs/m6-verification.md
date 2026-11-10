# M6 — Incidents: verification record

What was executed against the finished milestone, and what it produced. Plan:
[m6-plan.md](m6-plan.md). PRs: #83 (plan), #84 (Record), #97 (Evaluate), and
the Show-and-prove PR this record ships with.

Environment: PostgreSQL 17 (`postgres:17-alpine`, as `docker-compose.yml`
pins). Node 22 in the containers; Node 24.20.0 ran the test suites on the
machine (CI runs 22). One laptop. Every container run started from an empty
volume (`docker-compose down -v`), used the built image, and ran **two
workers**. Every figure below is a query result or a response from that run.

## The exit test

> An endpoint goes down; an incident opens after three failures timed from the
> first, and closes after two successes. (`08-plan.md`, row M6)

Live, at a 30 s interval with N = 3 and M = 2. `/flaky/exit` on a target whose
switch was flipped down at 12:44:33.390 and up at 12:46:05:

| what                            | stored (probe `started_at`)         | the target's own log           |
| ------------------------------- | ----------------------------------- | ------------------------------ |
| first failed probe, `opened_at` | **12:44:58.429**                    | `12:44:58.431 /flaky/exit 503` |
| third failure, `confirmed_at`   | 12:45:57.639                        | —                              |
| first success, `closed_at`      | **12:46:27.757**                    | —                              |
| second success                  | 12:46:57.931 (`close_confirmed_at`) | —                              |

`opened_at` is the first failed request, 2 ms before the target logged it;
not the third, which would under-report the outage by 59 s. The outbox holds
one `incident_open` row and one `incident_close` row.

Over HTTP, acceptance step 5 is the first case of
`api/incidents/e2e/incidents-http.int.test.ts`: the rows the worker's step 4
produces answer `durationMs 180000` and `detectionLatencyMs 120000`. Steps 1–4
run through the real writer and the real evaluator in
`worker/incidents/e2e/evaluator.int.test.ts`.

## The run — `docs/m6-plan.md` §9's table

**Overlay** (not committed). The default network was put on `45.33.100.0/24`,
a subnet outside every IANA special-purpose range, so that **the SSRF guard
stayed on, at its default, for the whole run** and the target was still
reachable. No traffic left the Docker bridge. It also added:

- `target` (`45.33.100.10`): `/flaky/<switch>` answers 503 while its switch
  is down, `/down` always 503, `/slow` 900 ms, `/ok` 200; every request logged.
- `dns` (`45.33.100.53`): answers re-read from a JSON file on every query
  (TTL 0), so a name could be re-pointed or made to `SERVFAIL` mid-run. `api`
  and `worker` reached it through Docker's embedded resolver.

Eight endpoints, all created over HTTP. At save time, guard on, `:10080`
answered `400 PORT_NOT_ALLOWED` ("port 10080 cannot be probed: HTTP clients
refuse it") and `http://10.0.0.1` answered `400 ADDRESS_NOT_ALLOWED`.

| Run                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                              | Result |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| The exit test live, 30 s interval                                                                      | above                                                                                                                                                                                                                                                                                                                                                                                 | PASS   |
| Detection latency                                                                                      | `confirmed_at − opened_at`: **59–60 s** for all five incidents (two intervals at N = 3). The evaluator's delay, outbox `created_at − confirmed_at`: **2.68, 3.28, 6.67, 8.72, 9.70 s** on opens and **3.09, 6.49, 8.56 s** on closes — every one inside the 10 s tick                                                                                                                 | PASS   |
| DNS outage (`SERVFAIL`)                                                                                | `servfail.test` re-pointed to `SERVFAIL` after save: 20 results `down / dns_failure / ESERVFAIL`, through c-ares under the guard; incident `cause_class dns_failure`, `cause_code ESERVFAIL`, `opened_at 12:44:45.378`                                                                                                                                                                | PASS   |
| Connection refused                                                                                     | `target.test:8099`: `down / connection_refused / ECONNREFUSED` from 12:44:17.298; incident opened (logged 12:45:24.254). That endpoint was then deleted, below                                                                                                                                                                                                                        | PASS   |
| A policy block (rebinding to a private address), 10 slots                                              | `rebind.test` resolved to the target at save, then to `10.0.0.1`: **20 slots** `unknown / blocked_by_policy / ADDRESS_NOT_ALLOWED`, **0 incidents**, health `unknown` from 12:44:51                                                                                                                                                                                                   | PASS   |
| `SIGKILL` a worker between failures 2 and 3                                                            | `/flaky/kill`: failures at 12:44:35.347 and 12:45:05; `probeboard-worker-1` (`477d4b7d4299`) SIGKILLed at 12:45:06. The third failure, 12:45:35.568, was probed by the survivor `953b059945a9-1`, which opened the incident with **`opened_at 12:44:35.347`** (the target logged `12:44:35.351`). Closed at the first success, 12:46:05.673                                           | PASS   |
| Worker stopped for `2 × interval + grace` (150 s)                                                      | Both workers stopped 12:52:26 → 12:55:28 (182 s). The first pass after restart logged `endpoints with no recent result marked unknown {endpoints: 7}` at 12:55:28.388 (the eighth was already `unknown`). The next slots moved each back: `/ok`, `/flaky/*` `up`, `/slow` `degraded`, `/down` `down`, by 12:56:47                                                                     | PASS   |
| Maintenance window across an outage, service-level                                                     | `POST /v1/maintenance-windows` on service Maint, 12:46:00 → 12:50:05. **`/flaky/pre`**, incident open since 12:44:51 (before the window), failed 8 times inside it (`in_maintenance`) and 3 more after; it stayed **the same incident** (one `incident_open` row) and closed at 12:51:51.731. Health over HTTP inside the window: `maintenance`, since 12:46:00, `openIncidentId` set | PASS   |
| A failing endpoint created inside a service-level window (the composition gap in §7's maintenance row) | `/down` (always 503), created at 12:46:05 under the window's service: **8 failures inside, all `in_maintenance`, 0 incidents, 0 outbox rows**, health `maintenance` with `consecutiveFailures 0`. After the window ended, its incident opened at the third failure with **`opened_at 12:50:31.262`** — after the window, so failures inside it seeded nothing                         | PASS   |
| Endpoint deleted mid-incident                                                                          | `GET /v1/incidents/:id` 200; `DELETE /v1/endpoints/:id` 204; the same `GET` **404 at once**, and `GET /v1/endpoints/:id/incidents` 404, while the incident row was still stored (no FK, D13). By the next pass (≤ 10 s): incident, health and outbox rows **0**                                                                                                                       | PASS   |
| `count_maintenance`, `count_degraded`, `degraded_seconds`                                              | `count_maintenance` **8** (`/down`) and **8** (`/flaky/pre`), adding no seconds (`/flaky/pre`: `covered_seconds 420` = 14 non-maintenance rows × 30). `/slow`: `count_degraded` **22**, `degraded_seconds` **660**. M5's run had 0 for all three                                                                                                                                      | PASS   |

Logs: the surviving worker logged one `incident opened` or `incident closed`
line per transition (9), no `late results`, no failed pass, and no `error`
line. The only two warnings were the evaluator's and the rollup's stale
watermark after the 182 s stop: the diagnostic doing its job.

## Earlier container runs

**#84 (Record).** From `down -v`, guard off, a target on the compose network.
`/slow` with `latencyWarnMs 500` stored `degraded` at 907–910 ms.
`/json` stored `failure_detail {index: 1, code: value_mismatch, assertion: …}`.
An endpoint window flipped `in_maintenance` from `f` to `t` at its start.
A redirect to `:25` and one to `:10080` each stored
`unknown / blocked_by_policy / BAD_PORT`, 9 of 9. A body sentinel appeared in
0 rows. The fold counted maintenance rows apart.

**#97 (Evaluate).** From `down -v`, two workers. Both workers were SIGKILLed
between failures 2 and 3; a restarted worker opened the incident with
`opened_at` equal to the first failure (12:10:19.125, the target logged
12:10:19.127). It closed at the first success.

## The suites

| PR   | Unit | Integration | Coverage (stmts / branches) |
| ---- | ---- | ----------- | --------------------------- |
| #84  | 1294 | 513         | 94.72% / 90.86%             |
| #97  | 1339 | 538         | 94.78% / 90.93%             |
| PR 3 | 1363 | 562         | 94.87% / 91.17%             |

Every guard M6 adds was removed on the final code of its PR and seen failing
its named test; the tables are in each PR's body.

## Defects found by running it

- **#84**: seven writer tests pinned `2026-09-29`, a date only a long-lived
  local volume still had a partition for. Green locally, red in CI with
  `23514`. Fixed in `2eacb88`. Since then the integration suite runs on a
  freshly created volume before every push.
- **#97 draft**: a shared result object let every pass re-report every incident
  opened earlier on that worker (one incident logged "opened" five times).
  Fixed before review in `b77a282`.

## Not verified

- The full chain over HTTP in one test. The api may not import the worker
  (ADR-0006), so acceptance step 5 reads seeded rows; the chain end to end is
  this record's run.
- Rebinding was triggered by DNS re-pointing, not by an attacker's resolver.
  The same `ADDRESS_NOT_ALLOWED` path was also proved in the full-system run
  (C-6).
