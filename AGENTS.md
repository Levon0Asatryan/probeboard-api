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
- Flag a check-then-act sequence that spans an `await` (a DNS lookup, an HTTP
  round trip to an OAuth provider, Argon2 verification) without holding or
  re-acquiring a row lock and re-validating the condition right before the
  write. The pre-await read is stale by the time the write happens — this has
  produced sessions issued past a revocation, OAuth identities linked past a
  logout-all, and lost updates on concurrent header/tag replace. Also flag a
  timestamp used for an expiry/ordering check that was captured at request
  entry instead of after the await. Prove the fix with a barrier test that
  commits the competing write inside the exact window, not a hopeful
  `Promise.all`.

### Security

- Flag any outbound request built from a user-supplied URL that does not resolve
  the hostname, classify **every** resolved address, and pin the connection to a
  validated IP. Validating the URL string is not sufficient: DNS rebinding
  resolves safe at check time and to a private address at connect time
  (NFR-11, chapter 4.8).
- Flag redirect following that does not re-validate each hop.
- Flag an IP-address classifier (SSRF host validation) built as a
  hand-enumerated list of "private" ranges. It has repeatedly missed entries
  from the IANA special-purpose registries — deprecated IPv6 site-local,
  NAT64, 6to4, IPv4-translated, multicast, documentation ranges — because each
  fix only ever adds the one prefix just discovered missing. Classify against
  the full registry (or a vetted library), not memory. Also flag folding any
  DNS resolver error other than `ENOTFOUND`/`ENODATA` into "no address" —
  `SERVFAIL`, timeout, and refused must fail closed. And flag a port check
  that trusts the URL's literal port text: `:80`/`:443` are normalized away,
  so `SSRF_BLOCKED_PORTS` must check the resolved port, not the URL string.
- Flag a response body read without a byte cap, or a full body persisted.
  Bodies are bounded and used only for assertions (NFR-13).
- Flag internal detail reaching an HTTP response: stack traces, SQL text, driver
  messages. Responses carry a stable `code` and a safe message; the cause goes
  to the log.
- Flag `403` where a resource belongs to another user. Use `404` — confirming an
  id exists is itself a disclosure.
- Flag a monitor's user-supplied request headers being logged. They routinely
  carry the user's API keys.
- Flag a password/credential-verification endpoint, or any new endpoint doing
  another expensive or security-sensitive operation, with no rate-limiter
  admission. The limiter does not apply itself to new endpoints — check this
  explicitly whenever one is added, and prove it with a burst test against
  that endpoint specifically. Also flag one endpoint's failure counter being
  shared with another's (e.g. registration retries locking out the same
  address's login).
- Flag validation of a value against a JS-level approximation of a downstream
  constraint instead of the real one: `.max()` on a string counts UTF-16 code
  units, not the `Buffer.byteLength` a byte cap means; a header-value regex
  must match what Node's HTTP client accepts at send time, not just
  reject CR/LF; a numeric config bound must fit the Postgres column type it
  lands in (`int4` overflows silently error at insert); a decoded fixed-length
  value (e.g. base64 secret) must be checked by round-tripping the canonical
  encoding, not just by decoded length.

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

- Flag a file placed against the structure rules in `CLAUDE.md`: a technical
  grouping where a feature module belongs, a supporting file left at a module's
  root instead of its role folder (`dto/`, `guards/`, `decorators/`,
  `services/`, `repositories/`, `utils/`), or a name without its NestJS role
  suffix.
- Flag an import from `src/core/` into `src/api/` or `src/worker/`, or between
  those two. `core` depends on nothing; the other two never depend on each
  other (ADR-0006). `src/architecture.test.ts` enforces this.
- Flag domain logic added to `src/api/` that the worker will also need. Shared
  logic belongs in `core` so both processes use one definition.
- Flag probe-execution code that reaches for a database, a scheduler, or global
  state. The probe executor is a pure function of its config (chapter 7.4).
- Flag a new or changed endpoint whose request is missing from `http/`. One
  `.http` file per module; a new module needs a new one. A collection that lags
  the code is worse than none, because a missing request reads as "this
  endpoint does not exist".
- Flag a child-resource repository (headers, tags, anything hanging off a
  service or endpoint) that filters by parent ID alone. Ownership scoping on
  the parent does not propagate automatically — a caller who learns another
  tenant's parent UUID can read or replace its children unless every child
  method re-derives `userId` explicitly.
- Flag an update DTO/type built as `Updateable<Table>` (or any type-level
  spread of the full row) without `Omit`-ing FK and ownership columns
  (`service_id`, `user_id`, …) at the type level. Runtime validation that
  happens to reject those fields today is not enough — the type must make
  including them a compile error, so removing the runtime check later can't
  silently reopen a tenant-transfer bug.
- Flag a fix (validation, error-translation, a cap) applied to one of two
  request shapes that resolve to the same write (an explicit nested form vs.
  an implicit shorthand, a create vs. its corresponding update) without
  checking the other shape got it too. Factor the shared logic into one
  function both paths call instead of fixing each path separately.

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
- Flag a `bigserial`/`bigint` column typed as `number` in `types.ts`.
  node-postgres returns `int8` as a string; the type must say so.
- Flag `CREATE TABLE IF NOT EXISTS` (or similar) proposed as the fix for
  migration idempotency where the migration and its registry-insert already
  run in one transaction — that's already atomic; the guard would be inert,
  not a real fix.
- Flag an OpenAPI schema generated from a Zod type that uses `.refine()` or
  other cross-field validation without a hand-written `oneOf`/manual check.
  `z.toJSONSchema` silently drops `.refine()`, so the generated doc marks
  fields optional that the server actually requires together.
- Flag a documented route missing a status code it can reach through shared
  middleware (body-size limit, auth guard) — not just the codes the
  controller itself returns.

### Tests

- Flag a bug fix with no test that fails without it.
- Flag a focused or skipped test (`.only`, `.skip`).
- Flag a test asserting on implementation detail rather than behaviour. This
  includes asserting a setup function (e.g. `setGlobalPrefix`) was _called_
  with the right argument instead of exercising the real running server, and
  computing an "actual" route/wiring table by walking decorator metadata
  instead of asking the booted app — a metadata-derived actual can agree with
  a metadata-derived expected while both diverge from what Nest really serves.
- Flag a new guard, filter or check with no test proving it **fails** when it
  should. A guard never observed to fail is not known to work — this repository
  has shipped two that silently did nothing. This applies to a new field or
  bound added to `src/core/config/schema.ts` too: it ships with a rejection
  test in the same commit (a malformed spelling for a boolean — `yes`, `1`,
  `TRUE` — or an out-of-bound numeric value), not only a valid-value test.
- Flag a fix to build/packaging tooling (incremental compile state, artifact
  copy logic) proven only by a single fresh build. Require a test or CI step
  that reproduces the real sequence the bug needs: build twice without
  cleaning, or clean → build → delete `dist` → build again.
