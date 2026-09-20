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

### What to report, and what to leave alone

This is a university thesis on a deadline, reviewed by an automated reviewer
whose every round costs five to seven minutes of waiting. A review that lists
nine things of which two matter is more expensive than one that lists the two.
So the bar is deliberately high.

**Report a finding only if it is one of these:**

- a **wrong result** — a number, status or verdict the user would read and
  trust, that is not what the code computes;
- a **security hole** — SSRF, a secret in a log or response, an authorization
  gap, injection;
- **data loss or corruption**, including a lost update or a broken invariant;
- a **concurrency defect** — a duplicate, a lost claim, a race, a deadlock;
- a **broken build, broken test, or a test that cannot fail** — including a
  test that passes for a reason other than the behaviour it names;
- a **resource leak** that a long-running process would accumulate;
- a **documented contract violated** — the code contradicts a sentence in
  `docs/mN-plan.md`, an ADR, `openapi.yaml` or the requirements.

**Do not report** — these are either mechanically enforced, or not worth a
round at this stage:

- formatting, import order, naming style, or type errors: Prettier, ESLint and
  `tsc` block on those in CI already;
- suggestions phrased as "consider", "it might be cleaner", "a more idiomatic
  way", or preference between two correct spellings of the same thing;
- defensive code for inputs the type system or a validated config already
  excludes;
- hardening, tooling, abstraction or generality that only pays off at a scale
  this system will never reach: there is no deployment, no production data and
  no operator (see `CLAUDE.md`, "Build for this thesis, not for a fleet");
- missing tests for a case already covered by another test, or coverage as a
  number rather than a named uncovered behaviour;
- anything already recorded as a deferred follow-up in `docs/tracker.md`.

### Reviewing a design document

A plan (`docs/mN-plan.md`) is a **proposal**, not an artifact that can be
correct. It has no tests; the only thing a fix can produce is more prose, and
each fix opens new surface. #52 — one markdown document — took seven review
rounds in 82 minutes, and several rounds were defects introduced by the
previous round's fix.

On a plan, report only what changes the **design**:

- a contradiction with a requirement, a story, an ADR or measured evidence;
- an arithmetic or logical error in a stated invariant or bound;
- a security property the plan omits from a surface it covers;
- a test the plan specifies that could not fail.

Do **not** report wording, completeness, section ordering, extra detail that
could be added, or a test-matrix row that could be split. Those are settled in
the implementation PR, where a test can decide them.

**One round on a plan, then it merges.** The plan's job is to be good enough to
start from.

**Shape of a finding.** One comment per defect, not per occurrence — if the
same mistake appears in six places, that is one comment naming all six. State
the concrete failure: the input, the resulting wrong behaviour, and why. A
finding that asserts a fact — a limit, a default, a specification, a library's
behaviour — must cite it, because the author is instructed to check the premise
and push back with evidence when it is wrong.

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
- The same applies to a maintenance script, backfill or one-off repair: the
  API stays up while it runs, so a read-compute-write over a live table needs
  `SELECT ... FOR UPDATE`, a re-read of the locked value, and a barrier test
  committing the competing write inside the window. "It only runs once" is
  not an exemption.
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
- Flag a user-supplied path, key or field name used to index an object
  without an own-property check. Plain `value[segment]` access walks the
  prototype chain, so `$.constructor.name` resolves against any object and a
  JSON-path assertion whose path is absent from the response would report the
  endpoint healthy. Use `Object.hasOwn()` for every object step and an
  explicit bounds check for every array index.
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
- Flag traversal of a linked structure a library handed back, with no
  termination guard. Node's detailed peer certificate makes a self-signed
  root its own `issuerCertificate`, so "walk the chain" loops forever on an
  ordinary trusted chain — and synchronously, so no timeout or abort can
  fire. Stop on identity (issuer === current) or track visited nodes.
- Flag the only record of a destructive change being written after that change
  commits. M3's audit deleted an assertion and _then_ printed the line needed
  to restore it, so everything already removed when the process died had no
  record at all. `process.stdout.write()` returns before a slow pipe has
  delivered anything and reports `EPIPE` asynchronously — an unobserved stream
  write is not persistence. Write the record inside the same transaction as
  the destructive step, await the flush, and let a write failure roll that
  step back. A record for a change that rolled back is a no-op; a change with
  no record cannot be undone at all.

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
- Flag an operator command that cannot run where operators run it. `npm run
migrate` and M3's audit were both advertised only as `tsx` entries, while
  the runtime image copies just `dist/` and installs `--omit=dev` — neither
  the `.ts` source nor the `tsx` binary exists there, so the documented
  command fails in the one place it is required to work. A command meant for
  the container needs a compiled `:dist` twin, proved by running it in the
  built image.
- Flag a documented workaround nobody executed. `http/README.md` shipped a
  Compose port override that did nothing: Compose merges `ports` as a
  _unique-resource sequence_ and **appends** entries whose published port
  differs, so the override published the base port as well and still collided.
  `!override` (or `!reset`, Compose 2.24+) replaces the list. Run the commands
  a doc tells the reader to run, and put the observed output in the review.

### Tests

- Flag a bug fix with no test that fails without it.
- Flag a focused or skipped test (`.only`, `.skip`).
- Flag a `*.int.test.ts` that does not need PostgreSQL, or a socket-only test
  hidden behind that suffix. `vitest.config.mts` excludes `*.int.test.ts`
  from `npm test`/`npm run verify`, and `vitest.integration.mts` gives it a
  Postgres `globalSetup`: here the suffix means "needs the database", not
  "does I/O". A test that only needs a local socket belongs in the default
  suite, where `verify` actually runs it.
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
- Flag a race proved with a sleep. A fixed delay between starting the
  competing statement and letting the code under test proceed is not a
  barrier: on a loaded runner the statement may not have reached the database
  yet, so the test passes having exercised nothing — and keeps passing when
  the lock it exists to prove is deleted. Synchronise on observable state, and
  confirm the removal proof fails _every_ time rather than occasionally.
- Flag a PostgreSQL lock barrier that waits on the wrong object. A statement
  blocked on a **row** lock does not wait on the relation — it blocks on the
  holding transaction's `transactionid` lock, whose `pg_locks.relation` is
  `NULL`. So `pg_locks` joined to `pg_class` on `relname` never fires, and the
  barrier times out instead of releasing: in M3 that turned a 700ms suite into
  a 606s one that failed for a reason unrelated to the code under test. Poll
  `pg_stat_activity` for `wait_event_type = 'Lock'` on another backend.

### Design docs / plans

M3's plan (`docs/m3-plan.md`) took twelve review rounds and 46 findings —
33 of them P1 — before a clean pass, and they were the same handful of
mistake shapes repeating. Check for these explicitly before submitting a
plan for review, not just after Codex finds them:

- **Flag a Node/Web-API behaviour claim taken from memory instead of run.**
  `fetch()` wraps transport errors in `.cause` rather than throwing them
  directly (`error.code` on the caught error is `undefined`; the real code
  is one level down). A `ReadableStream` reader stays locked after
  `done: true` — cancelling the stream through anything but that reader
  throws. `reader.read()` yields whole transport chunks, not a requested
  byte count. `dns.promises.resolve4`/`resolve6` accept no `AbortSignal`.
  Each of these produced a real M3 finding because the plan stated the API's
  behaviour as if it were the obviously-simpler version. Verify with a live
  snippet against the actual dependency (M2's SSRF investigation and M3's
  §2.4 both did this correctly for other claims) rather than asserting from
  general familiarity.
- **Flag a cleanup/ownership rule stated per-mechanism instead of per-case.**
  M3 separately wrote "close the reader" and "close the dispatcher, except
  the last hop" and "cancel the redirect body, except the last hop" as three
  independent rules, each plausible alone — none of them accounted for what
  the _other_ two implied about the one case they all touch (the final
  hop's resources), and one of the three miscounted which response is
  "the last hop" in the first place (the terminal over-budget redirect is
  the last loop iteration, but is not the one that's evaluated — the same
  gap in different phrasing that keeps producing these findings). When a
  resource has more than one rule about when it's released, write out who
  owns closing it in _every_ terminal case as one table or list, not as
  separate prose paragraphs that each sound complete alone.
- **Flag a fix that duplicates the thing it was fixing instead of sharing
  it.** M3's first fix for a schema/evaluator grammar mismatch added a
  second, independent copy of the grammar into the API layer, because the
  worker's copy isn't importable from there (`core`/`api`/`worker`,
  ADR-0006) — recreating the exact drift the fix was for, one layer deeper.
  When a fix needs the same logic in two layers that can't import each
  other, the fix is a new `src/core/` module both call, never a second
  implementation of the same rule.
- **Flag a fix applied to one instance of a pattern without checking for
  siblings.** A redirect method rewritten to `GET` needed its
  body-describing headers dropped too (a Fetch-spec detail two separate
  findings caught in sequence, not one). A header-removal rule needed to be
  case-insensitive because the codebase already case-folds header names
  elsewhere for the same reason. Before calling a fix complete, grep the
  rest of the document/code for the same shape of case and confirm the fix
  covers all of them, not only the one a reviewer already named.
- **Flag a renamed file, path, or type left stale anywhere else in the same
  document.** A module-layout correction changed one file's declared path
  and missed two other places that still named the old one, including the
  delivery section implementation would actually read from. After any
  rename, `grep` the whole document for the old name before calling the
  edit done — the automated fix-cycle already learned to check
  `grep -rn` project-wide rather than trust a single edit's surrounding
  context; the same discipline applies within a single long document.
- **Flag a new validation rule with no story for the data that predates it.**
  M3 constrained the accepted `json_path` grammar at the DTO, which only runs
  on the next create or update — every row M2 had already stored under the
  old "any non-empty string" rule would have started failing every probe
  forever the moment the evaluator read it. A constraint added to a schema
  needs an answer for rows that already violate it: a repair step, a
  compatibility path, or an explicit "none exist, and here is the query that
  says so".
- **Flag a fix specified in a mechanism that cannot carry it out.** That
  repair was first written as a `*.up.sql` migration "calling the shared
  grammar function" — the migrator hands SQL files straight to
  `client.query` (`src/core/db/migrator/`), so a SQL file can never call
  TypeScript. Check what the chosen mechanism can actually execute before
  specifying work inside it.
- **Flag a fix that writes state the shared contract cannot express.** The
  same repair then marked bad assertions `enabled: false` — a key
  `EndpointAssertion` does not have, the DTO schemas reject, and the
  evaluator never reads, so the write would have changed nothing observable.
  If a fix needs a new state, either add it to the shared type (with its
  semantics, docs and tests) or use a state the contract already has.
- **Flag "it's only a script, so the rules are softer".** That same audit is
  a read-modify-write on a live table while the API serves traffic: it needs
  the `SELECT ... FOR UPDATE`, the re-read inside the lock, and the barrier
  test this file already demands of request-path code. Scripts, backfills
  and migrations are not exempt from the Concurrency section.
- **Flag a correction that was never itself reviewed as new work.** Eight of
  M3's forty-six findings were defects in earlier fixes rather than in the
  original draft. A fix is new design: run it through the same questions as
  the thing it replaced — does the mechanism execute it, does it duplicate
  what it was meant to unify, does it cover every sibling case, does it
  leave a stale reference behind.
- **Flag a claim verified against a runtime the project does not pin.** M3's
  undici connector and timeout research ran on whatever Node the
  environment happened to have (24) while `.nvmrc`, both `Dockerfile`
  stages and every CI job pin 22. Check the pin before treating a live
  experiment as evidence for the deployed runtime.
- **Flag a documented payload whose field names differ from the type that
  emits it.** M3's plan described the audit's recovery record as
  `{endpointId, removedAssertion}` in two places while `RemovedAssertion` and
  the CLI emit `removed` — anyone parsing the documented contract reads
  `undefined`, destroying the single recovery path the design offers in place
  of a `.down.sql`. Copy field names from the type rather than paraphrasing
  them, and `grep` the document for the old spelling after any rename.
- **Flag a configured maximum quoted as though it were the default.** D59
  justified paging with "the quota allows 100,000 endpoints per user" — that
  is the ceiling `ENDPOINT_QUOTA_PER_USER` will accept; the default is 100.
  The same mistake arrived from the other direction in review, sizing a page
  against `API_BODY_LIMIT`'s 8 MB maximum when the default is `64kb` (a 128×
  difference, and the whole basis of the finding). Quote the default, cite the
  `schema.ts` line, and check a reviewer's premise the same way before
  implementing — a wrong premise is a reason to push back with the evidence,
  not to write code.
- **Flag a design that re-breaks a rule already written in this file.** M3's
  OpenAPI gap — `z.toJSONSchema` silently drops `.refine()`, so the document
  advertises what the server rejects — is already a rule under
  "Configuration and migrations" above, and the plan walked into it anyway.
  Read the sections of this file that touch the area being designed while
  designing it, not only while reviewing it.
