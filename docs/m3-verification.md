# M3 verification record

What was executed to accept M3 — the probe executor — and what it produced.
Kept for the reason [m2-verification.md](m2-verification.md) gives: the unit
tests prove each piece behaves, while nearly every defect found on this
milestone was a property no unit test caught until it was run against a real
socket, a real certificate or a real `undici`.

M3 shipped as three PRs — #43 (the shared `json_path` grammar and the
save-time contract), #48 (probing pure logic and the connect-time SSRF pin),
#49 (the executor itself) — against `docs/m3-plan.md` §8's five-PR
breakdown, consolidated per the cost-discipline rule added in #44.

Date: 2026-09-20 · `main` at `ec246b2` (this record is its own next commit) ·
Postgres 17-alpine · Node 22 in CI and the image, 24 locally · undici 6.28.0

## Method

Three layers, because no one of them was sufficient:

1. **The suites**, local and in CI — 997 unit tests and 316 integration tests.
2. **A fresh clone** (`npm ci`, `npm run build`, `npm run verify`) at the head
   commit, to catch anything depending on a dirty working tree.
3. **The real container stack** (`docker compose up -d --build`), with
   `probe()` executed **inside the running api container** against live
   endpoints. This last one is the only layer that exercises the code as it
   actually ships, and it is where the plan's "real run" requirement is met.

Every guard was additionally re-proved by removal on the final code: the guard
is deleted, the suite is run, the named test is watched failing, and the guard
is restored. Each is recorded in its own commit message.

## Results

### The suites

| Check                                  | Result                                         |
| -------------------------------------- | ---------------------------------------------- |
| `npm run verify` (fresh clone at head) | pass — format, lint, types, openapi, 997 tests |
| `npm run build` (fresh clone)          | pass                                           |
| `npm run test:int` vs real Postgres    | 315 passed, 1 skipped                          |
| CI, five jobs, on the head SHA         | all pass                                       |

The one skipped integration test is the D69 stalled-pipe reproduction,
committed `it.skip` with its reason and a 30s timeout — a deliberate record of
an open follow-up, not a silent exclusion.

### The real container stack

`docker compose up -d --build` from an empty volume. Port 3000 belongs to
another project on this machine, so the api was published on 3100 through a
local override file; `docker-compose.yml` itself was not modified.

| Check                                     | Result                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| `migrate` service                         | ran to completion, exited 0                             |
| `api` container                           | `Up (healthy)`                                          |
| `worker` container                        | `Up`, logged `worker started`                           |
| `GET /readyz`                             | `{"status":"ok","database":"ok"}`                       |
| `GET /healthz`                            | `{"status":"ok"}`                                       |
| Probing module present in the image       | `dist/worker/probing/{index.js,utils/*.js,assertions/}` |
| `probe()` importable from the built index | `exports: createConnector,probe`                        |

### `probe()` executed inside the production container

The check that matters most, because it runs the shipped artifact rather than
the source tree. Seven outcome shapes against live endpoints:

| Scenario                               | Outcome                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `GET /healthz`                         | `success`, `status: 200`, `total_ms: 8`, `dns_ms: 0` |
| `json_path` assertion that holds       | `success`, `status: 200`                             |
| `json_path` assertion that fails       | `ASSERTION_FAILED`, **`status: 200` retained**       |
| `expected_status: [500–599]` vs a 200  | `STATUS_MISMATCH`, `status: 200`                     |
| `GET /nope` against the "any 2xx" rule | `STATUS_MISMATCH`, `status: 404`                     |
| Nothing listening on the port          | `CONNECTION_REFUSED`, `code: ECONNREFUSED`           |
| Loopback with the SSRF guard enabled   | `BLOCKED_BY_POLICY`, `code: ADDRESS_NOT_ALLOWED`     |

Two review findings are visible in that table as data rather than as claims:
`status` surviving on `ASSERTION_FAILED` and `STATUS_MISMATCH` is the fix for
defect #7 below, and `dns_ms: 0` on an IP-literal target is defect #9.

Afterwards `docker compose down`; other projects' containers on this machine
were untouched and 5432 was released.

## Defects found by running it

Nine, none of which the unit tests caught on their own. Seven were raised by
Codex across eight review rounds on #49; two came from auditing areas Codex's
findings exposed. Each is listed with what it would have done in production,
because that is the part a passing test suite hid.

1. **A custom `connect` silently opts out of undici's `connectTimeout`.**
   `Client` applies it inside `buildConnector`, which is called only when
   `typeof connect !== 'function'` (undici 6.28.0). The connector D13 requires
   therefore had no connect bound at all, leaving a dropped SYN to the OS's
   ~75s. Found by reading undici's source rather than trusting the plan's
   §2.4 note. Now enforced by the connector itself (D70).

2. **`authorizationError` is a bare string, not an `Error`.** `@types/node`
   declares it as `Error`, so reading `.code` — as the type invites — yields
   `undefined` and **every** TLS refusal would have classified as
   `UNKNOWN_ERROR`. Measured on the pinned runtime (D71).

3. **Node does not reject an IP `servername`.** It accepts it and warns
   (`DEP0123`) that it will be ignored later. The code had a guard justified by
   a crash that does not happen; the justification was corrected to the real
   one — identity must be checked against the certificate's IP SANs (D71).

4. **`Agent.close()` hangs on exactly the hops it is called for.** It waits for
   in-flight requests, and on a connect that never completed there is one that
   never finishes, so cleanup outlived the deadline it existed to honour. The
   deadline test died at the runner's 5s timeout until this became `destroy()`
   (D72).

5. **A malformed `Location` leaked its hop.** `new URL(location, target)`
   throws before the discard, so the body kept streaming and the `Agent`
   stayed open for the life of the process. Found in the hostile self-review
   pass and fixed before Codex raised the identical finding.

6. **`total_ms` included probeboard's own teardown.** A latency M6 persists and
   reports from, describing our cleanup rather than the endpoint. Fixed at all
   four terminal sites.

7. **Socket resets classified as `UNKNOWN_ERROR`.** Once the connector hands
   the socket over, a peer reset reaches `fetch()` as undici's `SocketError`
   carrying `UND_ERR_SOCKET`, not a raw `ECONNRESET`; the cause walk stops at
   the first code it finds. The consequence is worse than a wrong label — M6
   **excludes** `UNKNOWN` from uptime arithmetic instead of counting the
   endpoint as DOWN, so real outages would have gone unrecorded. §6 had planned
   a real-reset test and none existed, which is why it survived.

8. **A healthy `302` recorded as downtime.** The redirect budget was checked
   before `Location`, so a `3xx` carrying none was reported
   `TOO_MANY_REDIRECTS` whenever `max_redirects` was zero or spent — with the
   status dropped, so an operator could not see what the endpoint answered.

9. **`TLS_HANDSHAKE_FAILED` was unreachable, and `dns_ms` measured the wrong
   thing.** §3.5 named `EPROTO`, but Node reports the specific OpenSSL code
   (`ERR_SSL_WRONG_VERSION_NUMBER` for https against a plain HTTP port,
   `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION` for a version mismatch) — both were
   `UNKNOWN_ERROR`. Separately, `dns_ms` bracketed the whole SSRF guard, so URL
   parsing and address classification were reported as DNS latency; on an
   IP-literal target, where the resolver is never called, that was the _only_
   thing it measured.

Two further defects were in the **tests and fixtures**, not the code, and are
worth recording because they are the failure mode this repository has been
bitten by before:

- **Guard-enabled tests that passed while proving nothing.** A loopback test
  server is itself inside the SSRF blocklist, so those probes were refused
  before connecting — and `ADDRESS_NOT_ALLOWED` happened to be what they
  asserted. Fixed by resolving to a routable stand-in while the transport still
  dials locally, and by asserting the first hop was actually reached.
- **A listener test that passed with and without its fix.** It asserted no
  `MaxListenersExceededWarning`, but `AbortSignal` is an `EventTarget` whose
  max-listener count is unlimited, so no such warning is ever emitted. Replaced
  with a direct `getEventListeners` assertion after the premise was measured.

## What is not verified

- **`probe()` is not yet driven by anything.** M4 owns the scheduler; the real
  run above invoked it directly. Nothing in the running stack calls it on a
  schedule, and no result is persisted — M5 owns storage.
- **`CONNECTION_TIMEOUT` is not reproduced as a genuine dropped SYN.** Loopback
  either refuses instantly or accepts, and a real blackhole address is itself
  in the SSRF blocklist. A connector withholding its callback proves
  probeboard's own enforcement and mapping, not the OS's connect-timeout
  mechanics. Recorded as a scoped gap in `docs/m3-plan.md` §6, not skipped
  quietly.
- **The audit script has not been run against any deployed database.** It is an
  operator step (D48/D50/D51), not a migration, and must be run once before M4
  starts probing.

## Deferred to follow-ups

| Item                                                                     | Where                            |
| ------------------------------------------------------------------------ | -------------------------------- |
| D69's bounded exit for the audit's stalled reader                        | plan §9, skipped repro on `main` |
| `ENOTFOUND` vs `ENODATA` indistinguishable in `resolveAll`               | plan §9                          |
| `closeDispatcher` swallows a teardown failure with no diagnostic         | plan §9 — M4 owns the logger     |
| `ProbeDeps` has grown to seven fields, four of them plain config numbers | plan §9                          |
| An endpoint on a WHATWG blocked port reports `UNKNOWN_ERROR`             | plan §9 (D73)                    |
| With redirects, `cert_expires_at` is the final https hop's certificate   | plan §9                          |
