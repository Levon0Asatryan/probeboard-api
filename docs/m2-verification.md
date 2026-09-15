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
`fix/m2-review-findings`, that closed every Codex thread the first round left
unreplied and fixed what those threads found.

Date: 2026-09-15 · branch `fix/m2-review-findings` at `000f30f` (this record
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
| 70,000 rows carrying the same tag (integration test, not a live curl run) | still returns one page -- see "Defects found" #2                                                    |
| `WHERE EXISTS` compiled parameter count for a tag filter                  | fixed (5 or 6, by route), independent of the number of matching rows -- fast unit test, no database |

### OpenAPI document

| Check                                                                  | Result                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run openapi -- --check`                                           | up to date                                                                                 |
| `GET /docs-json` (the served document)                                 | `200`; `components.schemas.JsonValue` present                                              |
| Every `$ref` in the document resolves to something that exists         | integration test walks the whole document and checks each one                              |
| `?cursor`/`?limit`/`?tag` validation failures on the three list routes | `400` now documented in the response map (fixed in #34's own review round, confirmed here) |

### Suites and tooling

| Check                                               | Result                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run typecheck`                                 | clean                                                                              |
| `npm run lint`                                      | clean                                                                              |
| `npx vitest run` (unit)                             | 627 passed, 55 files                                                               |
| `npm run test:coverage`                             | 97.44% stmts / 91.49% branches / 98.31% fns / 98.01% lines -- above the 90% floor  |
| `npm run test:int` (real Postgres)                  | 301 passed, 18 files, 14.9s (was timing out intermittently before defect #6 below) |
| `docker compose up -d --build` from an empty volume | postgres, migrate, api, worker healthy                                             |

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

| Block                       | Family | Name                                                     | Global? | Action                                                                                                  |
| --------------------------- | ------ | -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `0.0.0.0/8`                 | v4     | "This network"                                           | No      | already blocked                                                                                         |
| `10.0.0.0/8`                | v4     | Private-Use                                              | No      | already blocked                                                                                         |
| `100.64.0.0/10`             | v4     | Shared Address Space (CGNAT)                             | No      | already blocked                                                                                         |
| `127.0.0.0/8`               | v4     | Loopback                                                 | No      | already blocked                                                                                         |
| `169.254.0.0/16`            | v4     | Link Local                                               | No      | already blocked                                                                                         |
| `172.16.0.0/12`             | v4     | Private-Use                                              | No      | already blocked                                                                                         |
| `192.0.0.0/29`              | v4     | IPv4 Service Continuity Prefix (DS-Lite)                 | No      | **added** (Codex-named)                                                                                 |
| `192.0.0.8/32`              | v4     | IPv4 dummy address                                       | No      | **added**                                                                                               |
| `192.0.0.9/32`              | v4     | Port Control Protocol Anycast                            | **Yes** | left reachable (see note)                                                                               |
| `192.0.0.10/32`             | v4     | TURN Anycast                                             | **Yes** | left reachable (see note)                                                                               |
| `192.0.0.170/32`, `.171/32` | v4     | NAT64/DNS64 Discovery                                    | No      | **added**                                                                                               |
| `192.0.2.0/24`              | v4     | Documentation (TEST-NET-1)                               | No      | **added**                                                                                               |
| `192.31.196.0/24`           | v4     | AS112-v4                                                 | Yes     | no rule needed                                                                                          |
| `192.52.193.0/24`           | v4     | AMT                                                      | Yes     | no rule needed                                                                                          |
| `192.88.99.0/24`            | v4     | 6to4 Relay Anycast (deprecated)                          | No      | **added**                                                                                               |
| `192.168.0.0/16`            | v4     | Private-Use                                              | No      | already blocked                                                                                         |
| `192.175.48.0/24`           | v4     | Direct Delegation AS112                                  | Yes     | no rule needed                                                                                          |
| `198.18.0.0/15`             | v4     | Benchmarking                                             | No      | already blocked                                                                                         |
| `198.51.100.0/24`           | v4     | Documentation (TEST-NET-2)                               | No      | **added**                                                                                               |
| `203.0.113.0/24`            | v4     | Documentation (TEST-NET-3)                               | No      | **added**                                                                                               |
| `224.0.0.0/4`               | v4     | Multicast                                                | No      | already blocked                                                                                         |
| `240.0.0.0/4`               | v4     | Reserved (covers `255.255.255.255/32` Limited Broadcast) | No      | already blocked                                                                                         |
| `::1/128`                   | v6     | Loopback                                                 | No      | already blocked                                                                                         |
| `::/128`                    | v6     | Unspecified                                              | No      | already blocked                                                                                         |
| `::ffff:0:0/96`             | v6     | IPv4-mapped                                              | No      | handled by cross-family matching, not a subnet rule                                                     |
| `64:ff9b::/96`              | v6     | IPv4-IPv6 Translation (NAT64 WKP)                        | **Yes** | blocked anyway -- registry "Global" answers routability, not embedded-address safety (see code comment) |
| `64:ff9b:1::/48`            | v6     | IPv4-IPv6 Translation (NAT64 local-use)                  | No      | already blocked                                                                                         |
| `100::/64`                  | v6     | Discard-Only Address Block                               | No      | **added**                                                                                               |
| `100:0:0:1::/64`            | v6     | Dummy IPv6 Prefix                                        | No      | **added**                                                                                               |
| `2001::/23`                 | v6     | IETF Protocol Assignments (parent)                       | No      | not swept wholesale -- see asymmetry note                                                               |
| `2001::/32`                 | v6     | Teredo                                                   | No      | already blocked                                                                                         |
| `2001:1::1/128`–`.3/128`    | v6     | PCP/TURN/DNS-SD Anycast                                  | Yes     | no rule needed                                                                                          |
| `2001:2::/48`               | v6     | Benchmarking                                             | No      | **added**                                                                                               |
| `2001:3::/32`               | v6     | AMT                                                      | Yes     | no rule needed                                                                                          |
| `2001:4:112::/48`           | v6     | AS112-v6                                                 | Yes     | no rule needed                                                                                          |
| `2001:10::/28`              | v6     | deprecated (previously ORCHID)                           | No      | **added**                                                                                               |
| `2001:20::/28`              | v6     | ORCHIDv2                                                 | Yes     | no rule needed                                                                                          |
| `2001:30::/28`              | v6     | Drone Remote ID (DETs)                                   | Yes     | no rule needed                                                                                          |
| `2001:db8::/32`             | v6     | Documentation                                            | No      | **added** (Codex-named)                                                                                 |
| `2002::/16`                 | v6     | 6to4                                                     | No      | already blocked                                                                                         |
| `2620:4f:8000::/48`         | v6     | Direct Delegation AS112                                  | Yes     | no rule needed                                                                                          |
| `3fff::/20`                 | v6     | Documentation (RFC 9637)                                 | No      | **added**                                                                                               |
| `5f00::/16`                 | v6     | Segment Routing (SRv6) SIDs                              | No      | **added**                                                                                               |
| `fc00::/7`                  | v6     | Unique-Local                                             | No      | already blocked                                                                                         |
| `fe80::/10`                 | v6     | Link-Local                                               | No      | already blocked                                                                                         |

Asymmetry note: IPv4's `192.0.0.0/24` and IPv6's `2001::/23` are both
non-global parent classifications with global exceptions carved out inside
them, but they were not treated the same way. `192.0.0.0/24`'s exceptions are
two single anycast addresses (`.9`, `.10`) -- excluding just those two from a
wholesale block needs eight separate CIDR ranges for no real benefit, so the
three specifically-named non-global sub-blocks are listed individually
instead, leaving the small unnamed remainder of the /24 (and the two global
addresses) alone. `2001::/23`'s exceptions include two entire currently-active
/28 allocations (ORCHIDv2, Drone Remote ID) -- wholesale-blocking the /23
would reject real, assigned global traffic, a materially larger cost than
IPv4's two addresses, so only the specifically-named non-global sub-blocks
are blocked there too, by the same reasoning applied consistently rather than
swept differently. Source: IANA's
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
insert plus the subsequent query occasionally exceeded the test timeout,
failing a `main` CI run that a re-run then passed -- a flake, not a real
regression, but one that made `main`'s CI signal unreliable. Replaced with a
fast, database-free unit test per repository that `.compile()`s the tag-filtered
query and asserts its bind-parameter count (5 or 6, by route) is fixed
regardless of anything -- the actual property the slow test was trying to
observe at execution time is visible in the query's shape alone, without
running it. `npm run test:int`'s own suite for these two repositories now
runs in the same time as any other file (previously 30s allotted for the two
slow tests alone), and each fast test is proven by removal (reverting the
`EXISTS` clause to a literal 1000-element `IN (...)` array -- no database
needed for that either -- fails the parameter-count assertion, confirmed
then restored).

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
