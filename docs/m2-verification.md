# M2 verification record

What was executed to accept M2 — registration (services, endpoints, save-time
SSRF, secret headers, tags and filtering) — against the real container stack,
and what it produced. Kept for the same reason as
[m1-verification.md](m1-verification.md): the tests prove each unit behaves,
and every defect found on this milestone (below) was an _interaction_ or
_specification_ property no unit test alone caught until a reviewer or a
registry lookup found it.

M2 shipped as five PRs (#28–#35, `docs/m2-plan.md` §8) across two review
rounds this record covers together: the five PRs themselves, and a sixth,
`fix/m2-review-findings` (PR #37), that closed every Codex thread the first
round left unreplied, fixed what those threads found, and was itself
reviewed twice more -- defects #9, #10 and #11 below are from those two
follow-up rounds on this same branch.

Date: 2026-09-15 · branch `fix/m2-review-findings` at `eeb1a0d` (this record
is its own next commit) · Postgres 17-alpine · Node 22-alpine · NestJS 12

## Method

The stack was started from an empty volume with `docker compose up -d
--build`, and every check below ran against it over HTTP with `curl`, with
the database inspected directly through `psql` where the visible response
does not prove the stored state. Nothing was stubbed. The SSRF and
bind-parameter checks additionally needed synthetic scale (70,000 rows, a
stalled DNS resolution) that a real deployment would take too long to
reproduce on demand -- those ran as integration tests instead, proven by
removal against the code they guard, not only by passing once.

## Results

### Services and endpoints CRUD

| Check                                                        | Result                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Create explicit `{name, baseUrl}` with a secret header + tag | `201`; response's header carries `isSecret: true`, no `value`                                                          |
| Create implicit (B-3) from a bare URL                        | `201 {service, endpointId}`; second URL at the same origin attaches, does not duplicate                                |
| Duplicate explicit `baseUrl`                                 | `409 CONFLICT`                                                                                                         |
| List, get, update, delete                                    | all behave per `docs/m2-plan.md` §5.5                                                                                  |
| Header override (B-4)                                        | endpoint's `x-api-key: override` wins over the service's secret, case-insensitively -- confirmed in `effectiveHeaders` |
| `PATCH` a path with `../` segments                           | canonicalized to the resolved path, `200` (same origin)                                                                |
| Pause / resume                                               | `enabled` flips `false`/`true`                                                                                         |
| `DELETE` a service                                           | `204`; cascades to its endpoints, headers, and tags (`psql`: all three tables 0 rows after)                            |

### SSRF guard

| Check                                                              | Result                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Loopback, RFC1918, link-local, CGNAT, metadata literals            | `400 ADDRESS_NOT_ALLOWED` (pre-existing, unchanged)                |
| DS-Lite AFTR/B4 (`192.0.0.1`, IANA IPv4 registry, newly blocked)   | `400 ADDRESS_NOT_ALLOWED`                                          |
| TEST-NET-1 (`192.0.2.1`, newly blocked)                            | `400 ADDRESS_NOT_ALLOWED`                                          |
| IPv6 documentation (`2001:db8::1`, RFC 3849, newly blocked)        | `400 ADDRESS_NOT_ALLOWED`                                          |
| Port Control Protocol Anycast (`192.0.0.9`, IANA-global exception) | `201` -- deliberately not blocked (see the comparison table below) |
| ORCHIDv2 (`2001:20::1`, IANA-global IPv6 exception)                | `201` -- deliberately not blocked                                  |
| Unnamed non-global address inside `192.0.0.0/24` (`192.0.0.11`)    | `400 ADDRESS_NOT_ALLOWED` -- see defect #11                        |
| Unnamed non-global address inside `2001::/23` (`2001:5::1`)        | `400 ADDRESS_NOT_ALLOWED` -- see defect #11                        |
| `PATCH baseUrl` to a blocked address                               | `400` -- re-validated on every save (D10), not only at create      |

### Header/tag replace atomicity

| Check                                                                                                                             | Result                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `HeaderRepository`/`TagRepository` `.replaceForService`/`.replaceForEndpoint` given a plain, non-transactional `Kysely<Database>` | no longer compiles -- `@ts-expect-error` proof in both `*.int.test.ts` files                                 |
| Two concurrent full-set replacements of the same owner's headers/tags                                                             | serialized by the row lock; final set is exactly the later call's, never a union (pre-existing, re-verified) |

### Tag filtering and pagination

| Check                                                                     | Result                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `?tag=key:value` on all three list routes                                 | matches only tagged rows, paginates with `cursor`/`limit`                                           |
| Tag key containing a colon (`team:region`)                                | `400 VALIDATION_FAILED` -- unfilterable otherwise                                                   |
| 70,000 rows carrying the same tag (integration test, not a live curl run) | still returns one page -- see "Defects found" #2, superseded by #12                                 |
| Compiled parameter count for a tag filter (`LATERAL` join, since #12)     | fixed (6 or 7, by route), independent of the number of matching rows -- fast unit test, no database |

### OpenAPI document

| Check                                                                  | Result                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run openapi -- --check`                                           | up to date                                                                                 |
| `GET /docs-json` (the served document)                                 | `200`; `components.schemas.JsonValue` present                                              |
| Every `$ref` in the document resolves to something that exists         | integration test walks the whole document and checks each one                              |
| `?cursor`/`?limit`/`?tag` validation failures on the three list routes | `400` now documented in the response map (fixed in #34's own review round, confirmed here) |

### Suites and tooling

| Check                                               | Result                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck`                                 | clean                                                                             |
| `npm run lint`                                      | clean                                                                             |
| `npx vitest run` (unit)                             | 636 passed, 55 files                                                              |
| `npm run test:coverage`                             | 97.48% stmts / 91.58% branches / 98.32% fns / 98.04% lines -- above the 90% floor |
| `npm run test:int` (real Postgres)                  | 303 passed, 18 files, ~18s (was timing out intermittently -- see defect #8)       |
| `docker compose up -d --build` from an empty volume | postgres, migrate, api, worker healthy                                            |

## Defects found

Seven. Two were found and fixed during PR4/PR5's own Codex review rounds
(#1–#2, listed for completeness since this is where their proof lives); five
were found in the post-merge review that produced this branch (#3–#7).

### 1. SSRF/DNS validation held the user or endpoint row lock

`EndpointsService.createForService`/`.update` ran `assertSaveableUrl` --
which does a real DNS resolution against a user-controlled hostname -- inside
the transaction, after the row lock. A slow or attacker-stallable resolution
held that lock for its duration, able to stall unrelated requests for the
same user. Fixed with double-checked locking: validate with an unlocked read
before opening the transaction, re-validate inside the lock only if the
joined base+path changed since that read. Proven by removal:
`endpoints-lock-ordering.int.test.ts` stalls the validation behind a gate and
races a second lock on the same row -- passes against the fix, hangs and
times out against the reverted lock-then-validate order.

### 2. Tag filter joined a materialized id list

`ServicesService`/`EndpointsService` pre-fetched every matching id via a
separate query, then passed the list into `.where('id', 'in', ids)`. An
account with enough matches would eventually exceed Postgres's 65,535
bind-parameter limit and get an error instead of a page. Fixed with `WHERE
EXISTS` subqueries in the repository layer. (This round's own fix for #6
below replaced the proof that originally covered this defect.)

### 3. Seven Codex review threads had no reply, and #34 merged before its head commit was reviewed

`#28` (header/tag executor atomicity) and `#29` (two SSRF ranges, the
`AggregateError` cause bug) each had unreplied threads from the review round
before this one; `#34`'s last three findings (the `openapi.yaml` recursive
ref, the `http/` file-per-module rule, and the missing 400 on list routes)
were posted after the PR was squash-merged, so no push ever answered them.
Fixed by verifying and fixing every one of the seven (this record; #4–#7
below), replying on each thread naming the fixing commit, and by putting the
head-commit-reviewed check ahead of merge in this project's own workflow
going forward.

### 4. Two IANA-registry SSRF ranges named by review, and eleven more found checking the rest of the registry

Codex named DS-Lite's `192.0.0.1`/`.2` and IPv6 documentation
(`2001:db8::/32`). Checking every remaining entry in the IANA IPv4 and IPv6
Special-Purpose Address Registries against the blocklist found eleven more
non-global ranges with no rule at all: IPv4 dummy address, NAT64/DNS64
Discovery, the three TEST-NET documentation ranges, the deprecated 6to4
relay anycast; IPv6 Benchmarking, deprecated ORCHID, two newer documentation
ranges (RFC 9637's `3fff::/20`), Segment Routing SIDs, the Discard-Only
block, and the Dummy IPv6 Prefix. Two ranges' registry entries carve out a
handful of individually-global addresses inside an otherwise non-global
block (`192.0.0.9`/`.10`, three `2001:1::` anycast addresses); those specific
addresses are deliberately left reachable rather than swept in with their
enclosing block -- see the comparison table below for which, and why IPv4's
`192.0.0.0/24` and IPv6's `2001::/23` were treated asymmetrically (a two-address
false-positive cost is not the same as blocking two currently-assigned /28s).
Every added range has a rejection test in `host-validator.test.ts`, proven by
removal (all sixteen fail against the pre-fix blocklist, confirmed then
restored).

**IANA comparison table** (`checked` = every entry in both registries as of
this record's date; `−` = already covered by an existing, differently-scoped
rule):

| Block                    | Family | Name                                                     | Global? | Action                                                                                                                                                                                           |
| ------------------------ | ------ | -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0.0.0.0/8`              | v4     | "This network"                                           | No      | already blocked                                                                                                                                                                                  |
| `10.0.0.0/8`             | v4     | Private-Use                                              | No      | already blocked                                                                                                                                                                                  |
| `100.64.0.0/10`          | v4     | Shared Address Space (CGNAT)                             | No      | already blocked                                                                                                                                                                                  |
| `127.0.0.0/8`            | v4     | Loopback                                                 | No      | already blocked                                                                                                                                                                                  |
| `169.254.0.0/16`         | v4     | Link Local                                               | No      | already blocked                                                                                                                                                                                  |
| `172.16.0.0/12`          | v4     | Private-Use                                              | No      | already blocked                                                                                                                                                                                  |
| `192.0.0.0/24`           | v4     | IETF Protocol Assignments (parent)                       | No      | **added, wholesale** (see the carve-out note) -- covers DS-Lite (Codex-named), the dummy address, NAT64/DNS64 Discovery, and every unnamed address in the /24 a first version of this fix missed |
| `192.0.0.9/32`           | v4     | Port Control Protocol Anycast                            | **Yes** | carved out of the /24 block (see note)                                                                                                                                                           |
| `192.0.0.10/32`          | v4     | TURN Anycast                                             | **Yes** | carved out of the /24 block (see note)                                                                                                                                                           |
| `192.0.2.0/24`           | v4     | Documentation (TEST-NET-1)                               | No      | **added**                                                                                                                                                                                        |
| `192.31.196.0/24`        | v4     | AS112-v4                                                 | Yes     | no rule needed                                                                                                                                                                                   |
| `192.52.193.0/24`        | v4     | AMT                                                      | Yes     | no rule needed                                                                                                                                                                                   |
| `192.88.99.0/24`         | v4     | 6to4 Relay Anycast (deprecated)                          | No      | **added**                                                                                                                                                                                        |
| `192.168.0.0/16`         | v4     | Private-Use                                              | No      | already blocked                                                                                                                                                                                  |
| `192.175.48.0/24`        | v4     | Direct Delegation AS112                                  | Yes     | no rule needed                                                                                                                                                                                   |
| `198.18.0.0/15`          | v4     | Benchmarking                                             | No      | already blocked                                                                                                                                                                                  |
| `198.51.100.0/24`        | v4     | Documentation (TEST-NET-2)                               | No      | **added**                                                                                                                                                                                        |
| `203.0.113.0/24`         | v4     | Documentation (TEST-NET-3)                               | No      | **added**                                                                                                                                                                                        |
| `224.0.0.0/4`            | v4     | Multicast                                                | No      | already blocked                                                                                                                                                                                  |
| `240.0.0.0/4`            | v4     | Reserved (covers `255.255.255.255/32` Limited Broadcast) | No      | already blocked                                                                                                                                                                                  |
| `::1/128`                | v6     | Loopback                                                 | No      | already blocked                                                                                                                                                                                  |
| `::/128`                 | v6     | Unspecified                                              | No      | already blocked                                                                                                                                                                                  |
| `::ffff:0:0/96`          | v6     | IPv4-mapped                                              | No      | handled by cross-family matching, not a subnet rule                                                                                                                                              |
| `64:ff9b::/96`           | v6     | IPv4-IPv6 Translation (NAT64 WKP)                        | **Yes** | blocked anyway -- registry "Global" answers routability, not embedded-address safety (see code comment)                                                                                          |
| `64:ff9b:1::/48`         | v6     | IPv4-IPv6 Translation (NAT64 local-use)                  | No      | already blocked                                                                                                                                                                                  |
| `100::/64`               | v6     | Discard-Only Address Block                               | No      | **added**                                                                                                                                                                                        |
| `100:0:0:1::/64`         | v6     | Dummy IPv6 Prefix                                        | No      | **added**                                                                                                                                                                                        |
| `2001::/23`              | v6     | IETF Protocol Assignments (parent)                       | No      | **added, wholesale** (see the carve-out note) -- covers Teredo, Benchmarking, deprecated ORCHID, and every unnamed address in the /23 a first version of this fix missed                         |
| `2001:1::1/128`–`.3/128` | v6     | PCP/TURN/DNS-SD Anycast                                  | Yes     | carved out of the /23 block (see note)                                                                                                                                                           |
| `2001:3::/32`            | v6     | AMT                                                      | Yes     | carved out of the /23 block (see note)                                                                                                                                                           |
| `2001:4:112::/48`        | v6     | AS112-v6                                                 | Yes     | carved out of the /23 block (see note)                                                                                                                                                           |
| `2001:20::/28`           | v6     | ORCHIDv2                                                 | Yes     | carved out of the /23 block (see note)                                                                                                                                                           |
| `2001:30::/28`           | v6     | Drone Remote ID (DETs)                                   | Yes     | carved out of the /23 block (see note)                                                                                                                                                           |
| `2001:db8::/32`          | v6     | Documentation                                            | No      | **added** (Codex-named) -- outside `2001::/23`, so a separate rule regardless                                                                                                                    |
| `2002::/16`              | v6     | 6to4                                                     | No      | already blocked                                                                                                                                                                                  |
| `2620:4f:8000::/48`      | v6     | Direct Delegation AS112                                  | Yes     | no rule needed                                                                                                                                                                                   |
| `3fff::/20`              | v6     | Documentation (RFC 9637)                                 | No      | **added**                                                                                                                                                                                        |
| `5f00::/16`              | v6     | Segment Routing (SRv6) SIDs                              | No      | **added**                                                                                                                                                                                        |
| `fc00::/7`               | v6     | Unique-Local                                             | No      | already blocked                                                                                                                                                                                  |
| `fe80::/10`              | v6     | Link-Local                                               | No      | already blocked                                                                                                                                                                                  |

Carve-out note: `192.0.0.0/24` and `2001::/23` are both non-global parent
classifications with more-specific globally reachable entries inside them.
An earlier version of this fix (this PR's own first commit) named and
blocked only the registry's own named non-global sub-blocks within each
parent, leaving every unnamed address in the parent -- unassigned, but
still non-global by inheritance -- unblocked (defect #11 below). Both
parents are now blocked wholesale, with the registry's global exceptions
inside them (`192.0.0.9`/`.10`; `2001:1::1`–`.3`, `2001:3::/32`,
`2001:4:112::/48`, `2001:20::/28`, `2001:30::/28`) carved back out via a
second `BlockList` (`GLOBAL_EXCEPTIONS` in `host-validator.ts`) checked
before the main one -- `net.BlockList` has no subtraction, so "block X
except Y" is two lists, the narrower checked first. Source: IANA's
[IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)
and
[IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml)
Special-Purpose Address Registries.

### 5. `AggregateError` as a `cause` collapsed to the string "AggregateError"

`describeError`'s top-level `AggregateError` branch expands `err.errors`
correctly, but an `AggregateError` reached through a `cause` chain (a
multi-address connection failure attached as another error's cause, which is
how Node itself sometimes reports one) fell into the ordinary-`Error` branch
instead, read its usually-empty `message`, and fell back to the type name --
discarding every constituent error the log most needed. Fixed with a
`describeAggregateShallow` helper: one level of the aggregate's own
constituents, not their own further cause chains, to stay bounded rather
than recursive. Proven by removal: reverting to the ordinary-`Error` branch
fails both new tests (confirmed, then restored).

### 6. The OpenAPI document's recursive assertion schema referenced a non-existent, non-standard location

`z.toJSONSchema` on the recursive `jsonValueSchema` (an endpoint assertion's
`equals` field, which can itself be an object or array of more JSON values)
produced a `definitions` object nested inside that field's own schema, with
`$ref: "#/definitions/__schema0"`. `definitions` is a Swagger 2.0/JSON Schema
keyword OpenAPI 3.0 does not recognize, and even a resolver that tried anyway
would look at the document root, not the field's local position, and still
find nothing -- confirmed by the new ref-resolution test failing against the
pre-fix document (a `#/definitions/__schema0` ref with nothing there).
Fixed by hoisting the schema into a named `components.schemas.JsonValue` and
rewriting every occurrence (the standalone conversion's `$ref: "#"`, and each
nested conversion's local `definitions` block) to reference it by its real
path. New integration test walks every `$ref` in the whole document and
checks each one resolves.

### 7. `HeaderRepository`/`TagRepository`'s replace methods accepted a non-transactional executor

`replaceForService`/`replaceForEndpoint`'s optional `executor` parameter was
typed `Kysely<Database>`, which a plain, non-transactional instance also
satisfies. Passed one, the method's lock/delete/insert run as separate
autocommit statements: the `FOR UPDATE` lock releases after the single
statement that took it, not after the whole replace, and an insert failure
can leave the delete committed with nothing to replace it. No caller in this
codebase does this today, but the type let a future one. Fixed by tightening
the parameter to `Transaction<Database>`, which only a real transaction
satisfies -- a compile-time guard, not a runtime check. Proven by removal:
reverting either repository's type makes its own `@ts-expect-error` test
fail to typecheck (an "Unused '@ts-expect-error' directive" error), in both
`header.repository.int.test.ts` and `tag.repository.int.test.ts`.

### 8. `npm run test:int` failed intermittently on a slow CI runner

The two tests proving #2's fix (`WHERE EXISTS` vs a materialized id list)
each bulk-inserted 70,000 rows via `generate_series` to force the old
implementation past Postgres's bind-parameter ceiling. On a slow runner the
insert plus the subsequent query occasionally exceeded the test's 30s
timeout, failing a `main` CI run that a re-run then passed -- a flake, not a
real regression, but one that made `main`'s CI signal unreliable.

First fix: replaced both with a fast, database-free unit test per repository
that `.compile()`s the tag-filtered query and asserts its bind-parameter
count (5 or 6, by route) is fixed regardless of anything -- the property the
slow test tried to observe at execution time is visible in the query's shape
alone, without running it (proven by removal: reverting the `EXISTS` clause
to a literal 1000-element `IN (...)` array -- no database needed for that
either -- fails the assertion). Review of this fix (this PR's own head
commit) correctly pointed out the fast test alone lost real behavioral
coverage: it stays green even if `.list()` stops calling the query builder
it checks, or if the generated SQL fails against real Postgres for some
other reason -- exactly the property the original 70,000-row test proved and
a compiled-query check cannot.

Second fix, in response: restored both 70,000-row tests **alongside** the
fast ones, not instead of them, with the timeout raised from 30s to 90s. The
insert and query are fast on their own (under 2s locally); the flake was
margin against a loaded CI runner, not underlying slowness, so a larger
margin is the correct fix rather than removing the behavioral proof. Proven
by removal: reverting either repository's tag filter to a materialized id
list built from a real query against the 70,000 inserted rows fails with a
genuine Postgres bind-parameter error (confirmed for both, then restored) --
the same error the original defect produced.

### 9. A "compile-time-only" proof executed a real database call

`void headers.replaceForService(serviceId, userId, [], ctx.db)`, meant to
prove `Transaction<Database>` typing rejects a non-transactional executor
(defect #7) at compile time, discards the returned promise but still
_starts_ it: the synchronous `it()` completes immediately and `afterAll`
closes the shared pool, racing a real delete/insert against real rows
outside any transaction. Fixed by wrapping the call in a function that is
declared but never invoked -- TypeScript still type-checks an unreachable
function body, so the `@ts-expect-error` still does its job, but nothing
runs. Same pattern in both repositories' int test files. Proven by removal:
reverting either repository's `Transaction<Database>` tightening still fails
typecheck the same way as before.

### 10. A named SSRF finding turned out to be incorrect on inspection

Review of this PR's SSRF fix (#4) claimed `192.88.99.2/32` ("6a44-relay
anycast address") is a more-specific, globally reachable exception inside
the now-blocked `192.88.99.0/24`, and should stay reachable the way
`192.0.0.9/32`/`.10/32` do. Checked against IANA's own published CSV rather
than trusting the claim:

```sh
$ curl -s https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv | grep 192.88.99
192.88.99.0/24,Deprecated (6to4 Relay Anycast),[RFC7526],2001-06,2015-03,,,,,
192.88.99.2/32,6a44-relay anycast address,[RFC6751],2012-10,N/A,True,True,True,False,False
```

The ninth column is "Globally Reachable"; it reads `False` for
`192.88.99.2/32`, the same as its parent. The finding was incorrect --
pushed back on the thread with this evidence, no code change made. Not
counted as a fixed defect; recorded here because it is exactly the kind of
claim this milestone's own review process (checking against the primary
source instead of trusting either party) exists to catch, including a
review's own mistakes.

### 11. Naming only the registry's own named children left most of two non-global parent ranges unblocked

A separate finding on the same review round as #10 (and, unlike it,
correct): defect #4's fix named and blocked only the sub-blocks the IANA
registries themselves give names to inside `192.0.0.0/24` and `2001::/23`
(DS-Lite, the dummy address, NAT64/DNS64 Discovery, Teredo, Benchmarking,
deprecated ORCHID). Both parent blocks are non-global as a whole per their
own registry entries -- every address inside them inherits that
classification unless a _more specific_ entry overrides it -- so an address
with no name of its own, like `192.0.0.11` or `2001:5::1`, matched none of
the named children and was still accepted. Confirmed by direct bit-range
computation that both example addresses fall inside their respective
parent's declared prefix before writing the fix.

Both parents are now blocked wholesale (`bl.addSubnet('192.0.0.0', 24, ...)`,
`bl.addSubnet('2001::', 23, ...)`), with the registry's own more-specific
globally reachable entries inside them carved back out via a second
`BlockList` (`GLOBAL_EXCEPTIONS`) checked first -- the comparison table
above has the full list of what's carved out and why. This also let two
lines from #4's fix be removed as redundant: `2001::/32` (Teredo) and the
IPv4 `192.0.0.0/29`/`192.0.0.8/32`/`192.0.0.170/31` sub-blocks are all
already covered by their now-wholesale parent.

Two new tests for the gap itself (`192.0.0.11`, `2001:5::1`, both now
rejected) and seven new tests for the IPv6 exceptions this round made
explicit. Proven by removal: reverting either wholesale block back to its
narrower, named-only predecessor fails both gap tests (confirmed for both,
then restored).

### 12. The tag-filter `EXISTS` query hung on `main` CI after PR #37 merged -- a statistics race, not a slow runner

PR #37 merged clean (`c2f577d`), but the very next `main` CI run
(35004850255) timed out at 90s in
`service.repository.int.test.ts > list > still returns a page when the
match set is larger than Postgres can bind as one IN list`. Its endpoint
twin passed in 7s in the same run; the test normally takes 2-7s. It had
failed on 2 of the last 3 `main` pushes, always the service version --
a hang, not flakiness, and the 90s timeout that test already carried was
never a fix for it.

**Hypothesis and reproduction.** The suspect was the tag-filter `WHERE
EXISTS` query getting a pathological plan when the planner has no fresh
statistics on rows the test just bulk-inserted -- autovacuum's autoanalyze
runs asynchronously and had not caught up. Manually timing that query
right after a bulk insert gave inconsistent results between attempts
(sometimes fast) because autoanalyze was racing my own queries and
sometimes won first, confirmed via `pg_stat_user_tables.last_autoanalyze`.
Setting `ALTER TABLE ... SET (autovacuum_enabled = false)` before the
insert removed the race and made the bad plan reproduce every time:

```sql
-- services.list: EXISTS query, single-column user_id index, no ANALYZE, 70,000 rows
Limit  (actual time=75.167..75.168 rows=10 loops=1)
  Buffers: shared hit=280712
  ->  Sort  (actual time=75.166..75.167 rows=10 loops=1)
        Sort Key: services.id
        Sort Method: top-N heapsort  Memory: 27kB
        ->  Nested Loop  (actual time=10.956..71.436 rows=70000 loops=1)
              ->  HashAggregate (rows=70000)     -- tags materialized whole
                    ->  Index Scan using tags_key_value_idx on tags (rows=70000)
              ->  Index Scan using services_user_id_id_idx on services (loops=70000)
Execution Time: 75.397 ms
```

Confirmed the same shape for `endpoints.listForService` (two equality
filters, `service_id` and `user_id`): 280,712 buffer hits, 70.982 ms, same
materialize-then-sort shape. Both are real, deterministic, and match the
CI symptom exactly: the planner underestimates `tags`' selectivity (no
statistics yet), so it drives the join from the smaller apparent side --
`tags` -- materializing every match before `LIMIT` can trim anything,
instead of walking `services`/`endpoints` in `id` order and stopping after 10. Locally this is only 70-90ms because the machine is cache-hot
(`Buffers: shared hit=...`, no `read=`); at 500,000 rows the same shape
still only reached 825ms locally (`shared hit=1996628`). CI's runner
storage is slower and more contended, so the same O(row-count) buffer
count that costs under 100ms on a warm local SSD is what crosses a 90s
timeout there -- `pg_stat_activity` during a hung local attempt (forced
with `pg_sleep` in a second session) showed the query itself active, not
waiting on a lock, ruling out lock contention as the mechanism.

An earlier investigative dead end, recorded because it nearly shipped:
replacing `services_service_id_idx`/`endpoints_service_id_idx` with a
_two_-column composite `(service_id, id)` for `endpoints.listForService`
(one filter column short of the query's two) let Postgres choose a
`BitmapAnd` across that index and the separate `user_id` index instead of
either one alone, discarding index order entirely -- reproduced as an
actual 80.6-second local hang (`Execution Time: 80591.617 ms`,
`Buffers: shared hit=24967720`) even on a cache-hot machine, not just a
worse estimate. That ruled out "add _an_ index" as sufficient; the fix
needed to cover every equality filter the query applies, together.

**Fix.** Two changes, applied together (neither alone was reliable under
retest -- see below):

- **`LATERAL` instead of `EXISTS`**
  (`src/core/registration/repositories/{service,endpoint}.repository.ts`):
  a correlated subquery referencing the outer row can only be evaluated as
  the driven side of a nested loop -- Postgres has no plan where it starts
  from `tags` and materializes matches first. This removes the planner's
  _choice_, rather than trying to bias a choice that depends on an
  estimate the planner cannot have yet.
- **Composite indexes ending in `id`, covering every equality filter**
  (migration `0005_list_query_indexes`): `services (user_id, id)`,
  `endpoints (user_id, id)`, `endpoints (service_id, user_id, id)`. A
  single-column filter index gives the filter but not the sort order, so
  even with `LATERAL` driving correctly, the planner still needed a
  separate `Sort` node that waits for the full result before `LIMIT`
  applies; a composite index ending in `id` gives filter and sort order
  together, so the index scan itself can stop at the first 10 matches.

Re-running the same `EXPLAIN (ANALYZE, BUFFERS)` under the same forced
unanalyzed-statistics condition, with the fix:

```sql
-- services.list: LATERAL, composite (user_id, id) index, no ANALYZE, 70,000 rows
Limit  (actual time=1.838..10.526 rows=10 loops=1)
  Buffers: shared hit=3193
  ->  Nested Loop  (actual time=1.838..10.524 rows=10 loops=1)
        ->  Index Scan using services_user_id_id_idx on services (rows=10 loops=1)
        ->  Limit  (actual time=1.050..1.051 rows=1 loops=10)   -- driven side, per outer row
              ->  Index Scan using tags_key_value_idx on tags (rows=1 loops=10)
Execution Time: 10.537 ms

-- endpoints.listForService: LATERAL, composite (service_id, user_id, id) index, no ANALYZE
Limit  (actual time=0.976..12.768 rows=10 loops=1)
  Buffers: shared hit=3986
  ->  Nested Loop  (actual time=0.975..12.767 rows=10 loops=1)
        ->  Index Scan using endpoints_service_id_user_id_id_idx on endpoints (rows=10 loops=1)
        ->  Limit (loops=10) -> Index Scan using tags_key_value_idx on tags
Execution Time: 12.783 ms
```

280,712 -> 3,193 buffer hits for `services.list` (88x fewer); 70.982 ms ->
12.783 ms for `endpoints.listForService`; both bounded by `LIMIT 10`
regardless of how many rows match, not by the match-set size -- the plan
does not depend on fresh statistics at all, so it holds identically before
and after `ANALYZE`, which closes the "adding `ANALYZE` to the test alone
is not a fix, production has the same window" gap: nothing in production
runs `ANALYZE` between a bulk write and the next read either, and now
nothing needs to.

The remaining per-outer-iteration index choice inside the `LATERAL`
subquery (`tags_key_value_idx`, `Rows Removed by Filter: 39028` per loop)
is itself still an estimate-dependent choice that `ANALYZE` corrects
(confirmed: `tags_endpoint_key_key`, `Buffers: shared hit=53`,
`Execution Time: 0.185 ms` once real statistics exist) -- but it is now
bounded by `LIMIT` (at most 10 outer loops) rather than by the total match
count, so the same unanalyzed-statistics window that used to cost
280,712 buffer touches now costs at most a few thousand, a different and
much smaller class of risk that self-heals on the next autoanalyze.

**A rejected alternative.** `SET LOCAL enable_bitmapscan = off` inside a
transaction fixed `endpoints.list()` on first try (forced an `Index Scan`,
0.134 ms) but failed a clean retest for `services.list()`: Postgres picked
a different bad plan the GUC does not address (driving the nested loop
from `tags_key_value_idx` instead of a bitmap scan), 78-84 ms across 3
consistent trials. A cost-based tie-break toggle is not structural --
abandoned for `LATERAL`, which was reliable across every query shape and
retest.

**Determinism.** Both bulk-insert integration tests
(`service.repository.int.test.ts`, `endpoint.repository.int.test.ts`,
`"still returns a page when the match set is larger..."`) now wrap their
insert and query in `ALTER TABLE ... SET (autovacuum_enabled = false)` /
`RESET` for the tables they bulk-insert into, forcing the worst-case
unanalyzed condition on every run instead of leaving it to an autoanalyze
race the test could win or lose depending on runner speed -- the same
condition confirmed above to reproduce the bad plan 100% of the time
against the pre-fix code. Confirmed against the pre-fix `EXISTS` code
(reverted locally, migration `0005` rolled back, re-verified with
`EXPLAIN`, then restored) that this condition reliably reproduces the
pathological plan; confirmed against the fixed code that the plan holds
regardless. The timeout is back to the suite's default 20s
(`vitest.integration.mts`'s `testTimeout`) — the 90s value was never a fix
and is not needed once the plan does not depend on statistics.

**A methodological trap, found while writing this up.** Re-running the same
`EXPLAIN` reproduction against a Postgres container that had already run
other tests did not reproduce the bad plan -- `TRUNCATE` resets
`pg_class.reltuples`/`relpages` but does not clear `pg_statistic` (it keeps
the table's OID, only the physical storage is replaced), so a table that
had ever been `ANALYZE`d before, even with different data, keeps
old-but-present column statistics across a `TRUNCATE`, and the planner's
estimate from those stale-but-nonzero statistics happened to be good enough
to avoid the bad plan. Every reproduction in this defect's writeup was
re-confirmed against a genuinely fresh container (`docker compose down -v`

- `up -d`, migrated from empty, nothing else run first) -- the condition
  that actually matches CI, which never reuses a container between runs.
  This is also why the integration tests disable autovacuum explicitly
  instead of relying on freshness alone: a long-lived local Postgres (or a
  CI cache that reused a volume) would silently stop exercising this defect
  otherwise.

**Codex review follow-up (PR #38).** Review on this PR's head commit
(`7869d52`) found a real second instance of the same class of bug: the
regression tests above use `limit: 10`, but `MAX_LIST_LIMIT` permits up to
1,000. At `limit: 10` the LATERAL's per-iteration tag lookup only ran 10
times, so a wrong per-iteration index choice stayed cheap by accident; at
`limit: 1000` it didn't. Confirmed on a fresh container: the same 70,000-row
setup at `limit: 1000` reproduced a 79.8s hang (`Execution Time:
79813.811 ms`, `Buffers: shared hit=24966507`) -- `tags_key_value_idx`
(`key`, `value`), created in migration `0004` and with no caller other than
this LATERAL lookup, let the planner rescan every tag sharing this test's
`key`/`value` (about 35,000 of them, per `Rows Removed by Filter`) on each
of the outer loop's 70,000 iterations, instead of using the unique
`tags_service_key_key`/`tags_endpoint_key_key` index (`(owner, key)`,
migration `0004`) that already bounds the lookup to exactly one row per
iteration regardless of statistics.

Fixed the same way as the outer join, by removing the choice rather than
biasing it: migration `0006_drop_tags_key_value_idx` drops the index, since
nothing else in the codebase queries `tags` by `key`/`value` without an
owner filter (`TagRepository`'s own queries filter by `service_id`/
`endpoint_id`). Re-verified on the same fresh container after dropping it:
63ms (`Buffers: shared hit=281609`), using `tags_service_key_key`, 1,268x
faster and 89x fewer buffer hits than the pre-fix plan at the same
`limit: 1000`. The residual `Bitmap Heap Scan` on the _outer_ table this
plan still shows at `limit: 1000` (not present at `limit: 10`, where the
outer side uses an ordered `Index Scan`) is the same statistics-dependent
choice as the base fix above, now bounded to `O(match count)` rather than
`O(match count × non-matching tags)` -- a real but far smaller residual
that self-heals on the next autoanalyze, not a new instance of the
unbounded defect.

Both bulk-insert tests now also assert a page at `limit: 1000` in the same
autovacuum-disabled block, proven by removal on a fresh container the same
way as the base fix: recreating `tags_key_value_idx` alone (migration
`0005`'s composite indexes and the `LATERAL` join both still in place)
made both tests fail with a 20s test timeout and cascading 30s hook
timeouts in the next file (the hung query kept holding a pool connection
well past vitest's own timeout, exactly matching the original CI symptom
of one slow query starving the rest of the run) -- restoring the migration
made both pass again.

**10x integration run.** `npm run test:int` (18 files, 303 tests) run 10
consecutive times, each against a freshly recreated Postgres container
(`docker compose down -v` + `up -d`, migrated from empty), no failures,
re-run after the `limit: 1000` regression coverage above was added:

| Run | Duration | Run | Duration |
| --- | -------- | --- | -------- |
| 1   | 17.61s   | 6   | 17.67s   |
| 2   | 17.83s   | 7   | 17.85s   |
| 3   | 17.74s   | 8   | 17.68s   |
| 4   | 17.34s   | 9   | 17.57s   |
| 5   | 17.85s   | 10  | 17.72s   |

303/303 passed on every run; total suite duration stayed in a 17.34s-17.85s
band, no run approached the 20s default per-test timeout on any single
test.

## What this does not cover

- **Load.** NFR-6/NFR-7 are M4 concerns; the 70,000-row scale check above
  proves a query shape, not throughput under concurrent load.
- **The connect-time SSRF guard.** This module's own doc comment says so:
  DNS rebinding between save-time validation and M3's actual connection is
  closed by M3's own pinning, not by anything checked here.
- **Real registrar/DNS behavior for the newly-blocked ranges.** Every check
  above used IP literals; none of the sixteen new SSRF rules were exercised
  through an actual DNS record resolving into one of them, though the guard's
  own address-classification code path does not distinguish a literal from a
  resolved address.
- **A self-updating blocklist.** Review of this PR's SSRF fix raised, as a
  P1, that the blocklist is still hand-maintained `BlockList` entries rather
  than generated from the full registry data or a maintained library, so a
  future IANA addition or reclassification needs a code change to take
  effect here. True, and worth doing, but out of scope for this PR: the task
  this round was auditing and fixing the _current_ hand-maintained list
  against the _current_ registries (done, with the comparison table above
  for exactly this kind of future audit), not replacing the mechanism.
  The same staleness risk already existed for every pre-existing rule
  (RFC1918, loopback, link-local, CGNAT) before this PR touched anything,
  without it being raised then; generating from vendored registry data, or
  adopting a third-party SSRF library (several exist -- `ssrf-req-filter`,
  `got-ssrf`, `ssrf-guard`, `@tak-ps/node-safeurl` -- none confirmed to cover
  the full IANA special-purpose registries this fix now does, and swapping
  the mechanism would need its own security review, not a fold-in here) is
  a separately-scoped follow-up, not a blocker on this one. Not fixed;
  pushed back on the thread with this reasoning.
