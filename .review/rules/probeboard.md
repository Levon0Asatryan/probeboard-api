# probeboard rules

Mined from 114 review findings across the merged pull requests of M1–M3
(#28–#49). Every rule below is something a reviewer already caught in this
repository, usually more than once in different words.

These are **project rules**. They live in the repository and apply only to it.
Nothing here is loaded from, or written to, a corpus outside this folder.

Sections group by what goes wrong. IDs are stable — never renumber.

---

## Configuration and limits

### 1. Every limit comes from validated configuration, never a literal or a database default

A cap, timeout, interval, redirect limit or page size is read from the
validated config object. It is not a number in a schema, a `DEFAULT` clause in
a migration, or a constant in a handler.

```ts
// ✅
const max = cfg.ENDPOINT_QUOTA_PER_USER;

// ❌
const max = 100;
```

**Why:** Six separate findings across #28, #30 and #34 — timing defaults in a
migration, the redirect limit, the OpenAPI pagination cap, the list cap and the
quota default. A `DEFAULT` in PostgreSQL is worse than a literal: it is applied
when a caller _omits_ the column, so a bug that forgets to pass a value is
silently given a number nobody validated, and the omission is invisible in the
insert. Config is the one place a value is bounded, documented and testable.

**Tags:** `concern:config` `layer:persistence` `lang:ts` `severity:must`
**Check:** [sql] `DEFAULT [0-9]` :: a numeric column default hides an omitted value — require it and source it from validated config
**Relates:** requires #2
**Sources:** #28, #30, #34

### 2. A column the configuration owns has a test proving it rejects omission

When a value must come from config, prove the database will not supply one:
insert without it and assert the failure.

**Why:** "Prove configuration-owned columns reject omitted values" (#28). Rule
1 is unenforceable without this test — remove the `NOT NULL` and nothing fails.

**Tags:** `concern:testing` `concern:config` `layer:persistence` `severity:must`
**Relates:** proves #1

---

## Ordering: durability, locks and measurement

### 3. Persist the recovery record before the destructive step, not after

Write the record that makes an operation recoverable, and commit it, before
deleting or overwriting what it describes.

**Why:** Found twice in the same shape — "Persist recovery records before
committing removals" and "Persist recovery data before deleting the assertion"
(#35, #37). A crash between the two orderings is the difference between a
recoverable state and silent data loss.

**Tags:** `concern:data-integrity` `layer:persistence` `flow:write` `severity:must`

### 4. Do slow, fallible, external work before acquiring a database lock

Resolve DNS, decrypt, call out — then open the transaction and take the lock.

**Why:** "Resolve DNS before acquiring database locks" (#35). A lock held
across a network round trip converts one slow dependency into contention for
every other writer, and a DNS timeout becomes a lock timeout somewhere
unrelated.

**Tags:** `concern:concurrency` `concern:performance` `layer:persistence` `severity:must`
**Relates:** complements #5

### 5. Take locks in one documented order, and lock before reading what the decision depends on

When an operation touches two tables, the order is fixed and stated. Rows whose
values decide the outcome are locked before they are read.

**Why:** "Lock headers before resolving secret keep entries" (#34) and the
users-then-sessions ordering from the OAuth work. A read before the lock is a
decision made on a value another transaction is about to change.

**Tags:** `concern:concurrency` `concern:data-integrity` `layer:persistence` `severity:must`

### 6. Stop the clock when the measured work ends, not when cleanup finishes

Record the timestamp at the boundary of the thing being measured. Teardown,
`destroy()`, flushes and logging happen after the measurement is taken.

```ts
// ✅
const failedAt = nowMs();
await dispatcher.destroy();

// ❌
await dispatcher.destroy();
const failedAt = nowMs();
```

**Why:** "Record failure time before awaiting dispatcher teardown" and "Measure
only actual DNS work in dnsMs" (#49). This system exists to report numbers a
user trusts; teardown time inside `total_ms` is a wrong number that looks
plausible, which is the worst defect class in this repository.

**Tags:** `concern:correctness` `concern:observability` `layer:worker` `severity:must`
**Relates:** complements #7

### 7. A partial result keeps what it already established

When a later stage fails, the values earlier stages produced are still
reported: the status code survives a body-read failure, a DNS error survives
being wrapped, a resolver failure without a `code` is still preserved.

**Why:** "Preserve the received status when body reading fails", "Preserve the
DNS failure in the emitted log", "Preserve resolver failures that lack a code"
(#48, #49). Discarding what is known turns a diagnosable failure into
`UNKNOWN`, and M6 _excludes_ `UNKNOWN` from uptime — so the outage is not
merely mislabelled, it is unrecorded.

**Tags:** `concern:correctness` `concern:error-handling` `layer:worker` `severity:must`

---

## Trust boundaries

### 8. Validate the shape before it reaches a query or a driver

Check UUIDs, cursors, numbers and header values at the boundary. A malformed
value is rejected, never passed down to PostgreSQL or to the HTTP client to
fail its own way.

**Why:** Eight findings — UUIDs on ids and cursors, non-finite numbers in
assertion values, non-Latin-1 header values, header data Node cannot send,
malformed base64 decoded silently, colon-containing tag keys (#30, #33, #34,
#43, #48). A driver-level error is an unhandled 500 and a log line nobody can
map back to the request that caused it.

**Tags:** `concern:security` `concern:data-integrity` `layer:api` `flow:inbound` `severity:must`

### 9. Treat inherited property names as hostile when traversing untrusted paths

Traversal uses own-property checks. `__proto__`, `constructor` and named
segments on arrays are rejected or handled explicitly, never resolved.

**Why:** "Reject named segments when traversing arrays" and "Preserve
prototype-named headers in the filtered map" (#43, #48). User-supplied
`json_path` expressions and header names both reach object traversal.

**Tags:** `concern:security` `layer:worker` `severity:must`

### 10. Every operation is scoped to the requesting owner, in the query

Ownership is a `WHERE` clause, not a check in a service. Ownership columns are
excluded from update patches so they cannot be rewritten.

**Why:** "Scope header and tag operations to the requesting owner", "Enforce
that endpoint and service owners match", "Exclude ownership columns from update
patches" (#28, #34). Cross-user access is the one defect class in this project
that is unambiguously a vulnerability rather than a bug.

**Tags:** `concern:security` `layer:persistence` `severity:must`

### 11. The SSRF blocklist is the full IANA special-purpose registry, and every entry cites it

New ranges are added with their registry reference. Exceptions the registry
itself carries, such as `192.88.99.2`, are preserved rather than folded into a
wider rule.

**Why:** Six separate findings adding ranges one at a time — NAT64 local-use,
IPv6 documentation, IETF protocol assignments, deprecated site-local, and the
192.88.99.2 exception (#37, #48). Each was a real hole found only because a
reviewer went back to the registry. The table remains hand-maintained by
decision, so the citation is what makes the next audit possible.

**Tags:** `concern:security` `layer:worker` `severity:must`
**Sources:** #37, #48; tracker follow-up on generating it from the registries

---

## Tests that can actually fail

### 12. A race is forced with a barrier, never with a sleep or a hopeful `Promise.all`

Commit the competing write on a second connection, or poll
`pg_stat_activity` for the waiting backend. Timing is never the mechanism.

**Why:** "Replace the timing sleep with a real concurrency barrier" and "Test
every replacement race behaviorally" (#28, #30). A sleep-based race test passes
on a fast machine whether or not the guard exists.

**Tags:** `concern:testing` `concern:concurrency` `severity:must`
**Check:** [ts] `(setTimeout|sleep|delay)\(.*\)\s*;?\s*$` :: a timing delay in a concurrency test proves nothing — use a barrier
**Relates:** proves #5

### 13. Prove the test fails for the reason it names, not merely that it passes

Remove the guard and watch _this_ test fail. Check that the assertion could not
be satisfied another way — a loopback address is already in the SSRF blocklist,
so an `ADDRESS_NOT_ALLOWED` result proves nothing about the guard under test.

**Why:** M3 shipped two tests that passed for the wrong reason, and #49's
`SKIP LOCKED` measurement showed a third shape: removing the clause makes the
claim _block_, not duplicate, so a disjointness test passes with the guard
gone. The removal proof must assert the property that actually changes —
there, promptness.

**Tags:** `concern:testing` `severity:must`
**Relates:** complements #12

### 14. Cover every branch of a constraint, including the shapes it is meant to reject

An XOR constraint gets a test per failure mode. A ciphertext rule gets the
non-secret case as well as the secret one.

**Why:** "Cover both owner-XOR failure modes", "Test ciphertext rejection for
non-secret headers", "Prove secret headers require complete ciphertext
metadata" (#28, #34). A constraint tested only on its happy path is a comment.

**Tags:** `concern:testing` `concern:data-integrity` `severity:must`

---

## Structure and parity

### 15. Logic shared by the API and the worker lives in `core`, not in either consumer

Header decryption, effective-URL construction and header merging are `core`
concerns. A role folder owns its kind of code: helpers in `utils/`, queries in
the repository.

**Why:** Five findings moving code after the fact — probe-time header
decryption, effective-header merging, effective URL construction, URL helpers
into `utils/`, tag filtering back inside the endpoint queries (#33, #35, #48).
Two processes run from one codebase; logic that drifts between them produces
results that disagree about the same endpoint.

**Tags:** `concern:structure` `layer:core` `severity:should`

### 16. Anything runnable ships its `:dist` twin and is proved inside the image

A new CLI script gets a `:dist` entry in `package.json`, and the real run
executes it in the built container, not from `tsx`.

**Why:** "Make the audit command runnable in the runtime image" (#37). A
maintenance command that cannot run where the data is has no operational value
at all.

**Tags:** `concern:ops` `severity:must`

### 17. A filter that must stay selective states which index serves it, measured

When a query is written for a plan — a LATERAL join, a partial index, an
ordering served without a sort — the plan is checked with `EXPLAIN`, not
assumed, and the measurement is recorded.

**Why:** "Preserve an indexed path for selective tag filters" and "Retain
behavioral coverage for large tag-filtered lists" (#38) — the tag-filter hang
was a plan that changed after bulk inserts. M4's claim query repeated the
lesson deliberately, measuring at 600 and 50,000 rows.

**Tags:** `concern:performance` `layer:persistence` `severity:should`

### 18. The OpenAPI document and `http/` move in the same change as the endpoint

A new or changed route regenerates `openapi.yaml`, adds its request to
`http/<module>.http`, and keeps `$ref`s pointing at components that exist.

**Why:** "Represent create-service alternatives in OpenAPI", "Point recursive
assertion refs at an existing component", "Remove the hard-coded OpenAPI
pagination cap" (#30, #43). The document is the contract the thesis presents;
drift in it is drift in the evidence.

**Tags:** `concern:api-contract` `layer:api` `severity:must`

---

## Failure reporting

### 19. A failure that ends the process flushes its report first

The final log or report is written and flushed before `process.exit()`, and a
teardown that itself fails is surfaced rather than swallowed.

**Why:** "Let the final failure report flush before exiting", "Surface
dispatcher-destruction failures" (#37, #48). A diagnostic that loses its last
message is worse than none: it says the run ended cleanly.

**Tags:** `concern:error-handling` `concern:observability` `severity:must`

### 20. Secrets and response text never enter a log, a result or a recovery stream

Decrypted header values, authorization codes, tokens and status text stay out
of anything persisted or emitted.

**Why:** "Keep status text off the JSONL recovery stream" (#37), and the
standing rule that secret header values never appear in a response, a log, an
error or a probe result.

**Tags:** `concern:security` `concern:observability` `severity:must`

### 21. A guard that can silently match zero rows is proved by a test asserting it matched

An equality fence — a lease fence, an optimistic-concurrency check, a natural
key — fails **open**: a statement that affects no rows is not an error, so
nothing throws, nothing logs, and the guard is simply never enforced. Any such
predicate ships with a test asserting the write touched the row it was
supposed to touch, not merely that the call returned.

Be most suspicious when the compared value crosses a driver boundary. A value
read from PostgreSQL and bound back is not necessarily the value PostgreSQL
stored: `timestamptz` keeps microseconds, node-postgres parses it into a JS
`Date`, which holds milliseconds, and the comparison then never matches.

```ts
// ✅ carry PostgreSQL's own text, cast it back, and assert on rows affected
scheduled_at: string; // 2026-09-21 08:45:12.178512+00
sql`... AND scheduled_at = ${slot}::timestamptz`;
expect(await repo.release(id, worker, slot)).toBe(1);

// ❌ round-tripped through Date: 178512µs becomes 178ms, and this matches nothing,
//    quietly, for ever
sql`... AND scheduled_at = ${slot}`;
```

**Why:** M4's release fence. The claim returned `scheduled_at` as a `Date` and
the release bound it back to identify the slot it was ending, so every release
and every abandon matched **zero rows**. No lease would ever have been
cleared: each monitor would be probed once and then sit blocked until its
lease lapsed — the failure `docs/m4-plan.md` §3.7 names as the reason release
is mandatory rather than an optimisation. Measured on PostgreSQL 17:
`2026-09-21 08:45:12.178512+00` arrives as `...178Z`; binding the `Date` back
compares false, binding the text compares true.

The timestamp is the instance; the class is the point. Rule #13 says a test
must fail for the reason it names. This is its mirror — a guard that never
fires, and whose silence is indistinguishable from success.

**Tags:** `concern:data-integrity` `concern:concurrency` `layer:persistence` `severity:must`
**Check:** [ts] `scheduled_at\s*=\s*\$\{[a-zA-Z]+\}(?!::)` :: a value bound back into a fence without a cast may not match what the database stored
**Relates:** mirrors #13; proves #5
**Sources:** M4 PR 2
