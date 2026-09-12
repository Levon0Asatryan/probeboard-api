# probeboard-api

Backend for **probeboard**, an API monitoring dashboard. Two processes from one
codebase: **api** (`src/api/main.ts`) serves HTTP under `/v1` and never probes;
**worker** (`src/worker/main.ts`) schedules and executes probes, rolls up
statistics, opens incidents and sends notifications.

Design documents live in
[probeboard-docs](https://github.com/Levon0Asatryan/probeboard-docs). Chapter
references below point there.

- Node 22, TypeScript (ESM, `nodenext`), NestJS, Kysely over PostgreSQL.
- **Kysely is a query builder, not an ORM.** The core mechanisms are raw SQL an
  ORM would abstract badly: `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO UPDATE`
  with array-subscript increment, declarative partitioning.
- PostgreSQL is the only infrastructure dependency (ADR-0001).
- `npm run verify` runs format, lint, typecheck and tests.

## Code Review Rules

Flag consequential, repository-specific problems. **Do not** report formatting,
import order, naming style, or type errors — Prettier, ESLint and `tsc` run in
CI on every pull request and already block on those.

### Measurement correctness

This system's entire purpose is producing numbers a user will trust. A wrong
number that looks plausible is the worst defect class here.

- Flag any code path where a probe that probeboard **refused to run** counts as
  endpoint downtime. `blocked_by_policy` is our refusal, not their outage, and
  must be excluded from uptime arithmetic (chapter 3.4).
- Flag a missing probe result being treated as healthy. Absent data is
  `UNKNOWN`, excluded from both numerator and denominator — never silently `up`
  (chapter 3.5.2).
- Flag an incident timed from the probe that crossed the failure threshold
  rather than the **first** failed probe of the run. The former under-reports
  every outage by `(N-1) × interval` (chapter 3.8).
- Flag percentiles computed by averaging percentiles, or a long-window statistic
  that reads raw probe rows instead of aggregates. Percentiles are not
  averageable; that is why histogram buckets are stored (ADR-0003, NFR-9).
- Flag a latency measurement that includes probeboard's own queueing delay. The
  recorded time is the endpoint's (NFR-5).

### Concurrency and data integrity

Multiple workers run concurrently by design. Anything safe only in one process
is a bug.

- Flag read-modify-write on shared rows. Aggregate counters must be incremented
  inside SQL (`ON CONFLICT DO UPDATE SET x = table.x + 1`), never loaded into a
  worker, mutated and written back.
- Flag work claimed without `FOR UPDATE SKIP LOCKED` and a lease that expires.
  Two workers must never probe the same endpoint for one slot (NFR-3), and a
  dead worker's claim must become reclaimable (NFR-4).
- Flag a next-run time computed from `now()` rather than from the scheduled
  time. Drift must not accumulate (NFR-2).
- Flag a multi-step write that can half-commit. An incident and its
  notification are written in one transaction, or neither (ADR-0008).
- Flag retryable work that is not idempotent.

### Security

- Flag any outbound request built from a user-supplied URL that does not resolve
  the hostname, classify **every** resolved address, and pin the connection to a
  validated IP. Validating the URL string is not sufficient: DNS rebinding
  resolves safe at check time and to a private address at connect time
  (NFR-11, chapter 4.8).
- Flag redirect following that does not re-validate each hop.
- Flag a response body read without a byte cap, or a full body persisted.
  Bodies are bounded and used only for assertions (NFR-13).
- Flag internal detail reaching an HTTP response: stack traces, SQL text, driver
  messages. Responses carry a stable `code` and a safe message; the cause goes
  to the log.
- Flag `403` where a resource belongs to another user. Use `404` — confirming an
  id exists is itself a disclosure.
- Flag a monitor's user-supplied request headers being logged. They routinely
  carry the user's API keys.

### Failure handling

- Flag a swallowed failure: an empty catch, an ignored rejection, a fallback
  that hides the cause. If ignoring is correct, it is logged with the reason.
- Flag reading `err.message` where the value may be an `AggregateError`, whose
  own message is empty. Use `describeError()`.
- Flag a new `EventEmitter` whose `error` event has no listener. In Node that is
  a fatal uncaught exception — it is how a database restart once killed the api
  and every worker at once.
- Flag a long-running loop that can exit silently when its work throws.

### Structure

- Flag a directory that has grown into a flat list of unrelated files. A module
  is split into subfolders by cohesion once it passes roughly ten files --
  `sessions/`, `passwords/`, `rate-limiting/`, `http/` -- rather than
  accumulating everything at one level. A flat folder of twenty files hides
  which pieces belong together and makes every later addition worse.
- Flag an import from `src/core/` into `src/api/` or `src/worker/`, or between
  those two. `core` depends on nothing; the other two never depend on each
  other (ADR-0006). `src/architecture.test.ts` enforces this.
- Flag domain logic added to `src/api/` that the worker will also need. Shared
  logic belongs in `core` so both processes use one definition.
- Flag probe-execution code that reaches for a database, a scheduler, or global
  state. The probe executor is a pure function of its config (chapter 7.4).

### Configuration and migrations

- Flag a literal where configuration belongs: timeouts, limits, intervals, URLs,
  credentials. Everything is declared in `src/core/config/schema.ts` and
  validated at boot.
- Flag a migration without a matching `.down.sql`, or one that is not
  idempotent-safe to re-run.
- Flag a schema change in `src/core/db/migrations/` without the corresponding
  update to `src/core/db/types.ts`.
- Flag retention implemented as `DELETE` on the probe write path. Partitions are
  dropped instead (ADR-0007).

### Tests

- Flag a bug fix with no test that fails without it.
- Flag a focused or skipped test (`.only`, `.skip`).
- Flag a test asserting on implementation detail rather than behaviour.
- Flag a new guard, filter or check with no test proving it **fails** when it
  should. A guard never observed to fail is not known to work — this repository
  has shipped two that silently did nothing.
